import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { Agent } from './core/agent.js';
import { closeAll } from './memory/store.js';

async function main(): Promise<void> {
  const agent = new Agent();

  // ─── Register Channels ──────────────────────────────────────────────────────

  if (config.TELEGRAM_ENABLED) {
    const { createTelegramChannel } = await import('./channels/telegram.js');
    const telegram = createTelegramChannel(
      (msg) => agent.handleMessage(msg),
      (groupId, platform) => agent.handleGroupJoin(groupId, platform)
    );
    agent.registerChannel('telegram', telegram);
  }

  if (config.WHATSAPP_ENABLED) {
    const { createWhatsAppChannel } = await import('./channels/whatsapp.js');
    const whatsapp = createWhatsAppChannel(
      (msg) => agent.handleMessage(msg),
      (groupId, platform) => agent.handleGroupJoin(groupId, platform)
    );
    agent.registerChannel('whatsapp', whatsapp);
  }

  if (!config.TELEGRAM_ENABLED && !config.WHATSAPP_ENABLED) {
    logger.error('No channels enabled. Set TELEGRAM_ENABLED=true or WHATSAPP_ENABLED=true in .env');
    process.exit(1);
  }

  // ─── Start ──────────────────────────────────────────────────────────────────

  await agent.start();

  // ─── Graceful Shutdown ──────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await agent.stop();
      closeAll();
      logger.info('Goodbye!');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep process alive (channels use long-polling/WebSocket)
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
