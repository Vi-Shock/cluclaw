import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  // Bot identity
  BOT_NAME: z.string().default('CluClaw'),

  // Channels
  WHATSAPP_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  TELEGRAM_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // LLM
  LLM_PROVIDER: z
    .enum(['openai', 'anthropic', 'groq', 'google', 'ollama', 'mistral'])
    .default('groq'),
  LLM_MODEL: z.string().default('llama-3.3-70b-versatile'),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),

  // Vision (falls back to LLM config)
  VISION_PROVIDER: z
    .enum(['openai', 'anthropic', 'groq', 'google', 'ollama', 'mistral'])
    .optional(),
  VISION_MODEL: z.string().optional(),
  VISION_API_KEY: z.string().optional(),

  // STT
  STT_PROVIDER: z.enum(['groq', 'openai', 'local']).default('groq'),
  STT_MODEL: z.string().default('whisper-large-v3'),
  STT_API_KEY: z.string().optional(),

  // General
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATA_DIR: z.string().default('./data'),
  DEFAULT_CURRENCY: z.string().default('INR'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  HISTORY_LIMIT: z.coerce.number().int().positive().default(50),
});

function loadConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid configuration:');
    for (const err of result.error.errors) {
      console.error(`  ${err.path.join('.')}: ${err.message}`);
    }
    process.exit(1);
  }

  const cfg = result.data;

  // Validate channel-specific requirements
  if (cfg.TELEGRAM_ENABLED && !cfg.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_ENABLED=true but TELEGRAM_BOT_TOKEN is not set');
    process.exit(1);
  }

  return cfg;
}

export const config = loadConfig();
export type Config = typeof config;
