import { Bot, type Context } from 'grammy';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { normalizeTelegramMessage } from '../core/message-bus.js';
import type { GroupMessage } from '../types.js';
import type { ChannelAdapter } from './types.js';

export function createTelegramChannel(
  onMessage: (msg: GroupMessage) => Promise<void>,
  onGroupJoin: (groupId: string, platform: 'telegram') => Promise<void>
): ChannelAdapter {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN!);

  // Listen for all group/supergroup messages
  bot.on('message', async (ctx: Context) => {
    try {
      const raw = ctx.update.message;
      if (!raw) return;

      const msg = normalizeTelegramMessage(raw);
      if (!msg) return;

      // Optionally download media buffer before passing along
      if (raw.photo) {
        const photos = raw.photo;
        const largest = photos[photos.length - 1];
        if (largest) {
          try {
            const file = await ctx.api.getFile(largest.file_id);
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
              const res = await fetch(url);
              const buf = Buffer.from(await res.arrayBuffer());
              if (msg.content.media) {
                msg.content.media.buffer = buf;
              }
            }
          } catch (err) {
            logger.warn('Failed to download photo:', err);
          }
        }
      }

      if (raw.voice || raw.audio) {
        const audio = raw.voice ?? raw.audio;
        if (audio && 'file_id' in audio) {
          try {
            const file = await ctx.api.getFile(audio.file_id);
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
              const res = await fetch(url);
              const buf = Buffer.from(await res.arrayBuffer());
              if (msg.content.media) {
                msg.content.media.buffer = buf;
              }
            }
          } catch (err) {
            logger.warn('Failed to download audio:', err);
          }
        }
      }

      await onMessage(msg);
    } catch (err) {
      logger.error('Telegram message handler error:', err);
    }
  });

  // Detect when bot is added to a group
  bot.on('my_chat_member', async (ctx: Context) => {
    try {
      const update = ctx.update.my_chat_member;
      if (!update) return;

      const { chat, new_chat_member } = update;
      const chatType = chat.type;

      if (!['group', 'supergroup'].includes(chatType)) return;
      if (new_chat_member.status !== 'member' && new_chat_member.status !== 'administrator') return;

      const groupId = String(chat.id);
      logger.info(`Bot added to Telegram group: ${groupId} (${chat.title})`);
      await onGroupJoin(groupId, 'telegram');
    } catch (err) {
      logger.error('Telegram my_chat_member handler error:', err);
    }
  });

  return {
    async start(): Promise<void> {
      logger.info('Starting Telegram bot...');
      // Start polling in the background
      bot.start({
        onStart: (info) => logger.info(`Telegram bot @${info.username} started`),
      }).catch((err: unknown) => logger.error('Telegram bot crashed:', err));
    },

    async sendMessage(groupId: string, text: string): Promise<void> {
      try {
        await bot.api.sendMessage(Number(groupId), text, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        // Markdown might fail on special chars — fall back to plain text
        try {
          await bot.api.sendMessage(Number(groupId), text);
        } catch (err2) {
          logger.error('Failed to send Telegram message:', err2);
        }
      }
    },

    async sendReply(groupId: string, replyToMessageId: string, text: string): Promise<void> {
      // Extract the numeric message ID from our internal ID format tg:groupId:msgId
      const parts = replyToMessageId.split(':');
      const msgId = parts.length >= 3 ? parseInt(parts[2], 10) : NaN;

      try {
        if (!isNaN(msgId)) {
          await bot.api.sendMessage(Number(groupId), text, {
            reply_parameters: { message_id: msgId },
            parse_mode: 'Markdown',
          });
        } else {
          await bot.api.sendMessage(Number(groupId), text, { parse_mode: 'Markdown' });
        }
      } catch {
        await bot.api.sendMessage(Number(groupId), text).catch((e: unknown) =>
          logger.error('Failed to send Telegram reply:', e)
        );
      }
    },

    async stop(): Promise<void> {
      logger.info('Stopping Telegram bot...');
      await bot.stop();
    },
  };
}
