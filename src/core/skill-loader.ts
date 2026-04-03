import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { Skill } from '../types.js';
import { logger } from './logger.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export async function loadSkills(): Promise<Map<string, Skill>> {
  const skillsDir = resolve(__dirname, '..', 'skills');
  const skills = new Map<string, Skill>();

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    logger.warn('No skills directory found at', skillsDir);
    return skills;
  }

  for (const entry of entries) {
    const indexPath = join(skillsDir, entry, 'index.js'); // compiled output
    const indexTsPath = join(skillsDir, entry, 'index.ts'); // dev (tsx)

    const entryPath = existsSync(indexPath)
      ? indexPath
      : existsSync(indexTsPath)
        ? indexTsPath
        : null;

    if (!entryPath) {
      logger.debug(`Skipping ${entry}: no index.ts/js found`);
      continue;
    }

    try {
      const mod = await import(entryPath) as { default?: Skill };
      const skill = mod.default;

      if (!skill || typeof skill.shouldActivate !== 'function' || typeof skill.handle !== 'function') {
        logger.warn(`Skill ${entry}: invalid export, skipping`);
        continue;
      }

      // Load SKILL.md if present
      const skillMdPath = join(skillsDir, entry, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        skill.skillMd = readFileSync(skillMdPath, 'utf-8');
      }

      skills.set(skill.name, skill);
      logger.info(`Loaded skill: ${skill.name}`);
    } catch (err) {
      logger.error(`Failed to load skill ${entry}:`, err);
    }
  }

  return skills;
}
