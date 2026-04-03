import type { GroupMessage, QuotedMessage, MediaContent } from '../types.js';

// ─── Command Detection ────────────────────────────────────────────────────────

const COMMAND_REGEX = /^\/?([\w-]+)(?:\s+(.*))?$/s;

export interface ParsedCommand {
  command: string;
  args: string;
}

export function isCommand(message: GroupMessage): boolean {
  const text = message.content.text?.trim();
  if (!text) return false;
  return COMMAND_REGEX.test(text);
}

export function extractCommand(message: GroupMessage): ParsedCommand | null {
  const text = message.content.text?.trim();
  if (!text) return null;

  const match = COMMAND_REGEX.exec(text);
  if (!match) return null;

  return {
    command: match[1].toLowerCase(),
    args: (match[2] ?? '').trim(),
  };
}

// ─── Telegram Normalization ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeTelegramMessage(raw: any): GroupMessage | null {
  const msg = raw?.message ?? raw;

  if (!msg?.message_id || !msg?.chat) return null;

  // Only process group/supergroup messages
  const chatType = msg.chat.type as string;
  if (!['group', 'supergroup'].includes(chatType)) return null;

  const sender = msg.from;
  if (!sender) return null;

  const groupId = String(msg.chat.id);
  const senderId = String(sender.id);
  const senderName =
    [sender.first_name, sender.last_name].filter(Boolean).join(' ') ||
    sender.username ||
    senderId;

  let content: GroupMessage['content'] = {};

  // Text
  if (msg.text) {
    content.text = msg.text as string;
  } else if (msg.caption) {
    content.text = msg.caption as string;
  }

  // Media
  if (msg.photo) {
    const largest = (msg.photo as unknown[]).at(-1) as { file_id: string } | undefined;
    content.media = {
      type: 'image',
      mimeType: 'image/jpeg',
      caption: msg.caption as string | undefined,
    };
    void largest; // file_id used later for download
  } else if (msg.voice || msg.audio) {
    const audio = (msg.voice ?? msg.audio) as { mime_type?: string };
    content.media = {
      type: 'audio',
      mimeType: (audio.mime_type as string | undefined) ?? 'audio/ogg',
    };
  } else if (msg.document) {
    const doc = msg.document as { mime_type?: string; file_name?: string };
    content.media = {
      type: 'document',
      mimeType: (doc.mime_type as string | undefined) ?? 'application/octet-stream',
    };
  } else if (msg.video) {
    content.media = {
      type: 'video',
      mimeType: 'video/mp4',
    };
  }

  // Quoted message (1 level deep only)
  if (msg.reply_to_message) {
    const reply = msg.reply_to_message as Record<string, unknown>;
    const replySender = reply.from as Record<string, unknown> | undefined;
    const quotedSenderId = String(replySender?.id ?? '');
    const quotedSenderName =
      [replySender?.first_name, replySender?.last_name].filter(Boolean).join(' ') ||
      (replySender?.username as string | undefined) ||
      quotedSenderId;

    const quoted: QuotedMessage = {
      id: String(reply.message_id),
      sender: { id: quotedSenderId, name: quotedSenderName },
      content: {
        text: (reply.text ?? reply.caption) as string | undefined,
      },
      timestamp: new Date((reply.date as number) * 1000),
    };
    content.quotedMessage = quoted;
  }

  return {
    id: `tg:${groupId}:${msg.message_id}`,
    groupId,
    platform: 'telegram',
    sender: { id: senderId, name: senderName },
    content,
    timestamp: new Date((msg.date as number) * 1000),
    raw,
  };
}

// ─── WhatsApp Normalization ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeWhatsAppMessage(raw: any): GroupMessage | null {
  const key = raw?.key;
  if (!key?.remoteJid) return null;

  // Only group messages
  if (!key.remoteJid.endsWith('@g.us')) return null;

  const groupId = key.remoteJid as string;
  const messageId = key.id as string;
  const fromMe = key.fromMe as boolean;

  const pushName = (raw.pushName as string | undefined) ?? '';
  const senderId = fromMe
    ? (raw.participant ?? key.remoteJid) as string
    : (key.participant ?? raw.participant ?? senderId) as string;

  // Extract the actual message content
  const msg = raw.message ?? {};
  let text: string | undefined;
  let media: MediaContent | undefined;
  let quotedMessage: QuotedMessage | undefined;

  if (msg.conversation) {
    text = msg.conversation as string;
  } else if (msg.extendedTextMessage) {
    const ext = msg.extendedTextMessage as Record<string, unknown>;
    text = ext.text as string | undefined;

    // Quoted message
    if (ext.contextInfo) {
      const ctx = ext.contextInfo as Record<string, unknown>;
      if (ctx.quotedMessage) {
        const quotedMsg = ctx.quotedMessage as Record<string, unknown>;
        const quotedText =
          (quotedMsg.conversation as string | undefined) ??
          ((quotedMsg.extendedTextMessage as Record<string, unknown> | undefined)?.text as string | undefined);

        quotedMessage = {
          id: (ctx.stanzaId as string | undefined) ?? '',
          sender: {
            id: (ctx.participant as string | undefined) ?? '',
            name: '',
            phoneNumber: extractPhone(ctx.participant as string | undefined),
          },
          content: { text: quotedText },
          timestamp: new Date(),
        };
      }
    }
  } else if (msg.imageMessage) {
    const img = msg.imageMessage as Record<string, unknown>;
    media = {
      type: 'image',
      mimeType: (img.mimetype as string | undefined) ?? 'image/jpeg',
      caption: img.caption as string | undefined,
    };
    text = img.caption as string | undefined;
  } else if (msg.audioMessage || msg.pttMessage) {
    const audio = (msg.audioMessage ?? msg.pttMessage) as Record<string, unknown>;
    media = {
      type: 'audio',
      mimeType: (audio.mimetype as string | undefined) ?? 'audio/ogg; codecs=opus',
    };
  } else if (msg.documentMessage) {
    const doc = msg.documentMessage as Record<string, unknown>;
    media = {
      type: 'document',
      mimeType: (doc.mimetype as string | undefined) ?? 'application/octet-stream',
    };
  } else if (msg.videoMessage) {
    const vid = msg.videoMessage as Record<string, unknown>;
    media = {
      type: 'video',
      mimeType: (vid.mimetype as string | undefined) ?? 'video/mp4',
      caption: vid.caption as string | undefined,
    };
  }

  if (!text && !media) return null;

  const senderPhone = extractPhone(
    fromMe ? undefined : (key.participant as string | undefined) ?? groupId
  );

  return {
    id: `wa:${groupId}:${messageId}`,
    groupId,
    platform: 'whatsapp',
    sender: {
      id: senderId ?? key.remoteJid,
      name: pushName,
      phoneNumber: senderPhone,
    },
    content: { text, media, quotedMessage },
    timestamp: new Date((raw.messageTimestamp as number) * 1000),
    raw,
  };
}

function extractPhone(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const match = /^(\d+)@/.exec(jid);
  return match ? match[1] : undefined;
}

// ─── Message Storage ──────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export function storeMessage(
  db: Database.Database,
  message: GroupMessage
): void {
  db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, group_id, platform, sender_id, sender_name,
       text, media_type, media_mime, media_caption,
       quoted_message_id, timestamp, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    message.groupId,
    message.platform,
    message.sender.id,
    message.sender.name,
    message.content.text ?? null,
    message.content.media?.type ?? null,
    message.content.media?.mimeType ?? null,
    message.content.media?.caption ?? null,
    message.content.quotedMessage?.id ?? null,
    message.timestamp.toISOString(),
    JSON.stringify(message.raw)
  );
}
