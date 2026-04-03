// Minimal logger with LOG_LEVEL support, timestamps, and ANSI colors

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function getConfiguredLevel(): Level {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVELS) return raw as Level;
  return 'info';
}

function log(level: Level, ...args: unknown[]): void {
  const configuredLevel = getConfiguredLevel();
  if (LEVELS[level] < LEVELS[configuredLevel]) return;

  const ts = new Date().toISOString();
  const color = COLORS[level];
  const label = level.toUpperCase().padEnd(5);
  const prefix = `${color}${ts} [${label}]${RESET}`;

  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info:  (...args: unknown[]) => log('info',  ...args),
  warn:  (...args: unknown[]) => log('warn',  ...args),
  error: (...args: unknown[]) => log('error', ...args),
};
