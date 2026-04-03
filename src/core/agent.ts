import type { GroupMessage, Skill, SkillResponse } from '../types.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { Scheduler } from './scheduler.js';
import { loadSkills } from './skill-loader.js';
import { extractCommand, isCommand, storeMessage } from './message-bus.js';
import { getGlobalDb, getGroupDb, ensureGroup, upsertMember } from '../memory/store.js';
import { createGroupContext } from '../memory/group-context.js';
import { llmInterface } from './llm.js';
import { renderWelcome } from '../skills/expense-split/renderer.js';
import type { ChannelAdapter } from '../channels/types.js';
import { transcribe } from '../utils/stt.js';
import { extractFromImage, receiptToText } from '../utils/vision.js';

export class Agent {
  private skills = new Map<string, Skill>();
  private channels = new Map<string, ChannelAdapter>();
  private scheduler!: Scheduler;
  private schedulerTimer?: ReturnType<typeof setInterval>;

  async start(): Promise<void> {
    logger.info(`Starting ${config.BOT_NAME}...`);

    const globalDb = getGlobalDb();
    this.scheduler = new Scheduler(globalDb);

    this.skills = await loadSkills();
    logger.info(`Loaded ${this.skills.size} skill(s): ${[...this.skills.keys()].join(', ')}`);

    // Start channels
    for (const [name, channel] of this.channels) {
      try {
        await channel.start();
        logger.info(`Channel "${name}" started`);
      } catch (err) {
        logger.error(`Failed to start channel "${name}":`, err);
      }
    }

    // Scheduler loop — checks every 60s
    this.schedulerTimer = setInterval(
      () => this.runSchedulerTick().catch((err: unknown) => logger.error('Scheduler tick error:', err)),
      60_000
    );

    logger.info(`${config.BOT_NAME} is running!`);
  }

  registerChannel(name: string, channel: ChannelAdapter): void {
    this.channels.set(name, channel);
  }

  async stop(): Promise<void> {
    logger.info('Shutting down...');

    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }

    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        logger.debug(`Channel "${name}" stopped`);
      } catch (err) {
        logger.error(`Error stopping channel "${name}":`, err);
      }
    }
  }

  // ─── Message Handling ───────────────────────────────────────────────────────

  async handleMessage(message: GroupMessage): Promise<void> {
    logger.debug(
      `[${message.platform}] ${message.sender.name}: ${message.content.text ?? '[media]'}`
    );

    const db = getGroupDb(message.groupId);

    // Ensure group and member are registered
    ensureGroup(db, message.groupId, message.platform);
    upsertMember(
      db,
      message.groupId,
      message.sender.id,
      message.sender.name,
      message.sender.phoneNumber
    );

    // Pre-process media
    await this.preprocessMedia(message);

    // Store message in history
    storeMessage(db, message);

    // Build context
    const context = createGroupContext(
      message.groupId,
      message.platform,
      db,
      this.scheduler,
      llmInterface
    );

    // Route to commands first
    if (isCommand(message)) {
      const parsed = extractCommand(message);
      if (parsed) {
        const response = await this.routeCommand(parsed.command, parsed.args, context);
        if (response) {
          await this.sendResponse(message.groupId, message.platform, response, message.id);
        }
        return;
      }
    }

    // Route to skills (all that activate)
    for (const skill of this.skills.values()) {
      try {
        if (!skill.shouldActivate(message)) continue;

        const response = await skill.handle(message, context);
        if (response && !response.silent) {
          await this.sendResponse(
            message.groupId,
            message.platform,
            response,
            response.replyTo ?? message.id
          );
        }
      } catch (err) {
        logger.error(`Skill "${skill.name}" error:`, err);
      }
    }
  }

  private async preprocessMedia(message: GroupMessage): Promise<void> {
    const media = message.content.media;
    if (!media?.buffer) return;

    // STT: transcribe voice notes
    if (media.type === 'audio') {
      try {
        const text = await transcribe(media.buffer, media.mimeType);
        if (text) {
          // Inject transcription as the message text
          message.content.text = text;
          logger.debug(`STT transcription: "${text}"`);
        }
      } catch (err) {
        logger.warn('STT transcription failed:', err);
      }
    }

    // Vision: extract receipt data from images
    if (media.type === 'image') {
      try {
        const receipt = await extractFromImage(media.buffer, media.mimeType);
        if (receipt?.total) {
          const syntheticText = receiptToText(receipt, message.sender.name);
          message.content.text = message.content.text
            ? `${message.content.text} ${syntheticText}`
            : syntheticText;
          logger.debug(`Vision receipt: "${syntheticText}"`);
        }
      } catch (err) {
        logger.warn('Vision extraction failed:', err);
      }
    }
  }

  // ─── Command Routing ────────────────────────────────────────────────────────

  private async routeCommand(
    command: string,
    args: string,
    context: ReturnType<typeof createGroupContext>
  ): Promise<SkillResponse | null> {
    // Multi-word command check (e.g. "remove last")
    const multiWordCommands = ['remove last', 'settle up', 'who owes what'];

    for (const skill of this.skills.values()) {
      // Check multi-word commands first
      for (const mwc of multiWordCommands) {
        const fullCommand = command + (args ? ` ${args}` : '');
        if (fullCommand.toLowerCase().startsWith(mwc) && skill.commands[mwc]) {
          const remainingArgs = fullCommand.slice(mwc.length).trim();
          return skill.commands[mwc](remainingArgs, context);
        }
      }

      // Single-word command
      if (skill.commands[command]) {
        return skill.commands[command](args, context);
      }
    }

    return null;
  }

  // ─── Group Join ─────────────────────────────────────────────────────────────

  async handleGroupJoin(groupId: string, platform: 'whatsapp' | 'telegram'): Promise<void> {
    logger.info(`Joined group ${groupId} on ${platform}`);

    const db = getGroupDb(groupId);
    ensureGroup(db, groupId, platform);

    const context = createGroupContext(groupId, platform, db, this.scheduler, llmInterface);

    // Run onInstall for each skill
    for (const skill of this.skills.values()) {
      if (skill.onInstall) {
        await skill.onInstall(context).catch((err: unknown) =>
          logger.error(`Skill "${skill.name}" onInstall error:`, err)
        );
      }
    }

    // Send welcome message
    const welcome = renderWelcome(config.BOT_NAME);
    await this.sendResponse(groupId, platform, { text: welcome });
  }

  // ─── Response Sending ───────────────────────────────────────────────────────

  private async sendResponse(
    groupId: string,
    platform: 'whatsapp' | 'telegram',
    response: SkillResponse,
    replyToId?: string
  ): Promise<void> {
    if (!response.text) return;

    const channel = this.channels.get(platform);
    if (!channel) {
      logger.warn(`No channel found for platform "${platform}"`);
      return;
    }

    try {
      if (replyToId) {
        await channel.sendReply(groupId, replyToId, response.text);
      } else {
        await channel.sendMessage(groupId, response.text);
      }
    } catch (err) {
      logger.error('Failed to send response:', err);
    }
  }

  // ─── Scheduler Tick ─────────────────────────────────────────────────────────

  private async runSchedulerTick(): Promise<void> {
    const dueTasks = this.scheduler.tick();

    for (const task of dueTasks) {
      const skill = this.skills.get(task.skillName);
      if (!skill?.onScheduledTask) {
        this.scheduler.markComplete(task.id);
        continue;
      }

      try {
        const db = getGroupDb(task.groupId);
        const context = createGroupContext(
          task.groupId,
          'telegram', // platform stored in task payload if needed
          db,
          this.scheduler,
          llmInterface
        );

        const response = await skill.onScheduledTask(task, context);

        if (response?.text && !response.silent) {
          // We need the platform — store it in task payload
          const payload = task.payload as Record<string, unknown> | null;
          const platform = (payload?.platform as 'whatsapp' | 'telegram') ?? 'telegram';
          await this.sendResponse(task.groupId, platform, response);
        }

        this.scheduler.markComplete(task.id);
      } catch (err) {
        logger.error(`Scheduled task ${task.id} failed:`, err);
        this.scheduler.markFailed(task.id);
      }
    }
  }
}
