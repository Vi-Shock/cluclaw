// Shared types for CluClaw — the source of truth for all interfaces

// ─── Message Types ────────────────────────────────────────────────────────────

export interface QuotedMessage {
  id: string;
  sender: {
    id: string;
    name: string;
    phoneNumber?: string;
  };
  content: {
    text?: string;
    media?: MediaContent;
  };
  timestamp: Date;
}

export interface MediaContent {
  type: 'image' | 'audio' | 'video' | 'document';
  buffer?: Buffer;
  mimeType: string;
  caption?: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  platform: 'whatsapp' | 'telegram';
  sender: {
    id: string;
    name: string;
    phoneNumber?: string;
  };
  content: {
    text?: string;
    media?: MediaContent;
    quotedMessage?: QuotedMessage; // max 1 level deep
  };
  timestamp: Date;
  raw: unknown; // original platform message object
}

// ─── Member ───────────────────────────────────────────────────────────────────

export interface Member {
  id: string;           // internal DB id
  groupId: string;
  platformUserId: string;
  displayName: string;
  phoneNumber?: string;
  aliases: string[];    // user-registered name aliases
}

// ─── Skill System ─────────────────────────────────────────────────────────────

export interface SkillResponse {
  text?: string;
  replyTo?: string;    // message ID to reply to
  silent?: boolean;    // log only, don't send to group
}

export type CommandHandler = (
  args: string,
  context: GroupContext
) => Promise<SkillResponse | null>;

export interface ScheduledTask {
  id: string;
  skillName: string;
  groupId: string;
  executeAt: Date;
  recurrence?: string; // cron expression e.g. "0 9 * * 1-5"
  payload: unknown;
}

export interface LLMInterface {
  extractStructured<T>(
    prompt: string,
    schema: import('zod').ZodSchema<T>,
    options?: { vision?: boolean; imageBase64?: string; systemPrompt?: string }
  ): Promise<T>;
  generateText(
    prompt: string,
    options?: { systemPrompt?: string }
  ): Promise<string>;
}

export interface SchedulerInterface {
  schedule(task: Omit<ScheduledTask, 'id'>): string;
  cancel(taskId: string): void;
  listPending(skillName: string): ScheduledTask[];
}

export interface GroupContext {
  groupId: string;
  platform: 'whatsapp' | 'telegram';
  members: Member[];
  history: GroupMessage[];     // last HISTORY_LIMIT messages
  timezone: string;
  llm: LLMInterface;
  getSkillState<T>(skillName: string): T | null;
  setSkillState<T>(skillName: string, state: T): void;
  scheduler: SchedulerInterface;
  searchHistory(query: string): GroupMessage[];
}

export interface Skill {
  name: string;
  description: string;
  skillMd?: string; // loaded from SKILL.md at startup

  // Fast check — regex only, no LLM. Called for EVERY message.
  shouldActivate(message: GroupMessage): boolean;

  // Process the message. LLM calls happen here. Return null to stay silent.
  handle(message: GroupMessage, context: GroupContext): Promise<SkillResponse | null>;

  // Explicit commands this skill handles
  commands: Record<string, CommandHandler>;

  // Optional: handle scheduled/timed triggers
  onScheduledTask?(task: ScheduledTask, context: GroupContext): Promise<SkillResponse | null>;

  // Optional: called when skill is first activated in a group
  onInstall?(context: GroupContext): Promise<void>;
}

// ─── Channel ──────────────────────────────────────────────────────────────────

export interface ChannelAdapter {
  start(): Promise<void>;
  sendMessage(groupId: string, text: string): Promise<void>;
  sendReply(groupId: string, replyToMessageId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

// ─── Database Row Types ───────────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  platform: 'whatsapp' | 'telegram';
  name: string | null;
  timezone: string;
  created_at: string;
}

export interface MemberRow {
  id: string;
  group_id: string;
  platform_user_id: string;
  display_name: string;
  phone_number: string | null;
  aliases: string; // JSON array
}

export interface MessageRow {
  id: string;
  group_id: string;
  platform: string;
  sender_id: string;
  sender_name: string;
  text: string | null;
  media_type: string | null;
  media_mime: string | null;
  media_caption: string | null;
  quoted_message_id: string | null;
  timestamp: string;
  raw: string; // JSON
}
