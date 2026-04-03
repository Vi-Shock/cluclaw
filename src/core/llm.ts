import { generateObject, generateText as aiGenerateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import type { LLMInterface } from '../types.js';

type SupportedProvider = 'openai' | 'anthropic' | 'groq' | 'google' | 'ollama' | 'mistral';

function buildModel(
  provider: SupportedProvider,
  model: string,
  apiKey?: string,
  baseUrl?: string
) {
  switch (provider) {
    case 'openai':
    case 'ollama':
    case 'mistral': {
      const client = createOpenAI({
        apiKey: apiKey ?? 'ollama', // Ollama doesn't need a real key
        baseURL: baseUrl,
      });
      return client(model);
    }
    case 'anthropic': {
      const client = createAnthropic({ apiKey });
      return client(model);
    }
    case 'groq': {
      const client = createGroq({ apiKey });
      return client(model);
    }
    case 'google': {
      const client = createGoogleGenerativeAI({ apiKey });
      return client(model);
    }
  }
}

function getLLMModel() {
  return buildModel(
    config.LLM_PROVIDER,
    config.LLM_MODEL,
    config.LLM_API_KEY,
    config.LLM_BASE_URL
  );
}

function getVisionModel() {
  const provider = config.VISION_PROVIDER ?? config.LLM_PROVIDER;
  const model = config.VISION_MODEL ?? config.LLM_MODEL;
  const apiKey = config.VISION_API_KEY ?? config.LLM_API_KEY;
  return buildModel(provider, model, apiKey, config.LLM_BASE_URL);
}

export async function extractStructured<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  options?: { vision?: boolean; imageBase64?: string; systemPrompt?: string }
): Promise<T> {
  const model = options?.vision ? getVisionModel() : getLLMModel();

  const messages: Parameters<typeof generateObject>[0]['messages'] = [];

  if (options?.vision && options.imageBase64) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          image: options.imageBase64,
        },
        { type: 'text', text: prompt },
      ],
    });
  }

  try {
    const result = await generateObject({
      model,
      schema,
      system: options?.systemPrompt,
      prompt: messages.length === 0 ? prompt : undefined,
      messages: messages.length > 0 ? messages : undefined,
    });
    return result.object;
  } catch (err) {
    logger.error('LLM extractStructured failed:', err);
    throw err;
  }
}

export async function generateText(
  prompt: string,
  options?: { systemPrompt?: string }
): Promise<string> {
  const model = getLLMModel();
  try {
    const result = await aiGenerateText({
      model,
      system: options?.systemPrompt,
      prompt,
    });
    return result.text;
  } catch (err) {
    logger.error('LLM generateText failed:', err);
    throw err;
  }
}

// LLMInterface implementation for injecting into GroupContext
export const llmInterface: LLMInterface = {
  extractStructured,
  generateText,
};
