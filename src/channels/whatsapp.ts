import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { normalizeWhatsAppMessage } from '../core/message-bus.js';
import type { GroupMessage } from '../types.js';
import type { ChannelAdapter } from './types.js';

const AUTH_DIR = join(config.DATA_DIR, 'whatsapp-auth');

// Pino-compatible logger shim for Baileys internals (our logger lacks trace/fatal/child)
const baileysLogger = {
  trace: () => {},
  debug: (...args: unknown[]) => logger.debug(...args),
  info:  (...args: unknown[]) => logger.info(...args),
  warn:  (...args: unknown[]) => logger.warn(...args),
  error: (...args: unknown[]) => logger.error(...args),
  fatal: (...args: unknown[]) => logger.error(...args),
  child: () => baileysLogger,
} as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1];

// Rate limiting — max 1 message per 2 seconds to avoid bans
const MESSAGE_DELAY_MS = 2000;
let lastMessageTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastMessageTime;
  if (elapsed < MESSAGE_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, MESSAGE_DELAY_MS - elapsed));
  }
  lastMessageTime = Date.now();
}

export function createWhatsAppChannel(
  onMessage: (msg: GroupMessage) => Promise<void>,
  onGroupJoin: (groupId: string, platform: 'whatsapp') => Promise<void>
): ChannelAdapter {
  let sock: WASocket | null = null;
  let isConnected = false;
  let reconnectAttempts = 0;
  let reconnectPending = false;
  let connectedAt = 0;

  async function connect(): Promise<void> {
    mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(`Using Baileys version ${version.join('.')}`);

    // Close any existing socket before creating a new one to avoid conflict loops
    if (sock) {
      sock.ev.removeAllListeners('connection.update');
      sock.ws.close();
      sock = null;
    }

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false, // less suspicious
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('QR code generated — scan with WhatsApp to connect');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info('WhatsApp connected ✓');
        isConnected = true;
        reconnectPending = false;
        connectedAt = Date.now();
        // Reset backoff after 30s of stability (scheduled check)
        setTimeout(() => {
          if (isConnected && Date.now() - connectedAt >= 30_000) reconnectAttempts = 0;
        }, 30_000);
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`WhatsApp disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect && !reconnectPending) {
          reconnectPending = true;
          const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
          reconnectAttempts++;
          logger.info(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
          setTimeout(() => connect().catch((err: unknown) => logger.error('Reconnect failed:', err)), delay);
        } else if (!shouldReconnect) {
          logger.error('WhatsApp logged out. Delete auth directory and restart to re-authenticate.');
        }
      }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const raw of messages) {
        // Skip own messages and status broadcasts
        if (raw.key.fromMe) continue;
        if (raw.key.remoteJid === 'status@broadcast') continue;

        try {
          const msg = normalizeWhatsAppMessage(raw as unknown as Record<string, unknown>);
          if (!msg) continue;

          // Download media buffer if present
          if (msg.content.media && raw.message) {
            try {
              const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
              const buffer = await downloadMediaMessage(
                raw as proto.IWebMessageInfo,
                'buffer',
                {}
              ) as Buffer;
              if (buffer && msg.content.media) {
                msg.content.media.buffer = buffer;
              }
            } catch (err) {
              logger.warn('Failed to download WhatsApp media:', err);
            }
          }

          await onMessage(msg);
        } catch (err) {
          logger.error('WhatsApp message handler error:', err);
        }
      }
    });

    // Detect bot added to group
    sock.ev.on('group-participants.update', async (update) => {
      const { id: groupId, participants, action } = update;
      const botJid = sock?.user?.id;

      if (action === 'add' && botJid && participants.includes(botJid)) {
        logger.info(`Bot added to WhatsApp group: ${groupId}`);
        await onGroupJoin(groupId, 'whatsapp').catch((err: unknown) =>
          logger.error('Group join handler error:', err)
        );
      }
    });
  }

  return {
    async start(): Promise<void> {
      logger.info('Starting WhatsApp channel...');
      logger.warn(
        '⚠️  WhatsApp uses an unofficial API (Baileys). Use a dedicated phone number to avoid account restrictions.'
      );
      await connect();
    },

    async sendMessage(groupId: string, text: string): Promise<void> {
      if (!sock || !isConnected) {
        logger.warn('WhatsApp not connected, cannot send message');
        return;
      }
      await rateLimit();
      try {
        await sock.sendMessage(groupId, { text });
      } catch (err) {
        logger.error('Failed to send WhatsApp message:', err);
      }
    },

    async sendReply(groupId: string, replyToMessageId: string, text: string): Promise<void> {
      if (!sock || !isConnected) {
        logger.warn('WhatsApp not connected, cannot send reply');
        return;
      }

      // Extract the original Baileys message key from our internal ID
      // Format: wa:{groupId}:{messageId}
      const parts = replyToMessageId.split(':');
      const msgId = parts.length >= 3 ? parts.slice(2).join(':') : undefined;

      await rateLimit();
      try {
        if (msgId) {
          await sock.sendMessage(groupId, {
            text,
            // quote the original message if we have its ID
          }, { quoted: { key: { id: msgId, remoteJid: groupId }, message: { conversation: '' } } });
        } else {
          await sock.sendMessage(groupId, { text });
        }
      } catch (err) {
        logger.error('Failed to send WhatsApp reply:', err);
      }
    },

    async stop(): Promise<void> {
      logger.info('Stopping WhatsApp channel...');
      // Use end() not logout() — logout() revokes the session server-side,
      // meaning saved creds become invalid and a new QR scan is required on restart.
      // end() closes the WebSocket gracefully while keeping the session alive.
      try {
        sock?.end(undefined);
      } catch { /* ignore */ }
      sock = null;
      isConnected = false;
    },
  };
}
