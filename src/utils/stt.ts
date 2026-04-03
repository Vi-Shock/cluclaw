import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

/**
 * Transcribe audio buffer to text using the configured STT provider.
 * Provider-agnostic: routes to Groq Whisper, OpenAI Whisper, or local whisper.cpp.
 */
export async function transcribe(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const provider = config.STT_PROVIDER;

  switch (provider) {
    case 'groq':
      return transcribeWithGroq(buffer, mimeType);
    case 'openai':
      return transcribeWithOpenAI(buffer, mimeType);
    case 'local':
      return transcribeWithLocal(buffer, mimeType);
    default:
      throw new Error(`Unsupported STT provider: ${String(provider)}`);
  }
}

// ─── Groq Whisper ─────────────────────────────────────────────────────────────

async function transcribeWithGroq(buffer: Buffer, mimeType: string): Promise<string> {
  const { default: Groq } = await import('groq-sdk');
  const client = new Groq({ apiKey: config.STT_API_KEY ?? config.LLM_API_KEY });

  const ext = mimeTypeToExt(mimeType);
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });

  const transcription = await client.audio.transcriptions.create({
    file,
    model: config.STT_MODEL,
  });

  logger.debug(`Groq STT transcription: "${transcription.text}"`);
  return transcription.text;
}

// ─── OpenAI Whisper ───────────────────────────────────────────────────────────

async function transcribeWithOpenAI(buffer: Buffer, mimeType: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.STT_API_KEY ?? config.LLM_API_KEY });

  const ext = mimeTypeToExt(mimeType);
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });

  const transcription = await client.audio.transcriptions.create({
    file,
    model: config.STT_MODEL,
  });

  logger.debug(`OpenAI STT transcription: "${transcription.text}"`);
  return transcription.text;
}

// ─── Local whisper.cpp ────────────────────────────────────────────────────────

async function transcribeWithLocal(buffer: Buffer, mimeType: string): Promise<string> {
  const { execFile, writeFile, unlink } = await import('fs/promises');
  const { promisify } = await import('util');
  const execFileAsync = promisify(
    (await import('child_process')).execFile
  );
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { randomUUID } = await import('crypto');

  const ext = mimeTypeToExt(mimeType);
  const tmpPath = join(tmpdir(), `cluclaw-audio-${randomUUID()}.${ext}`);
  const outPath = tmpPath.replace(`.${ext}`, '.txt');

  try {
    await writeFile(tmpPath, buffer);

    await execFileAsync('whisper', [
      tmpPath,
      '--output-txt',
      '--output-dir', tmpdir(),
      '--model', 'base',
    ]);

    const { readFile } = await import('fs/promises');
    const text = await readFile(outPath, 'utf-8');
    logger.debug(`Local Whisper transcription: "${text.trim()}"`);
    return text.trim();
  } finally {
    for (const p of [tmpPath, outPath]) {
      await unlink(p).catch(() => {/* ignore */});
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/flac': 'flac',
  };
  return map[mimeType] ?? 'ogg';
}
