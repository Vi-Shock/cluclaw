// Platform-aware message formatter
// Skills return semantic text; this converts to platform-specific markup

type Platform = 'whatsapp' | 'telegram';

// ─── Semantic Markers → Platform Markup ──────────────────────────────────────

// Input text uses Markdown-style: *bold*, _italic_, `code`
// WhatsApp: *bold*, _italic_, `code` (same — but no tables, no ##)
// Telegram: Markdown V2 or HTML — we use the simpler MarkdownV2 subset

export function formatForPlatform(text: string, platform: Platform): string {
  if (platform === 'whatsapp') {
    return formatForWhatsApp(text);
  }
  return formatForTelegram(text);
}

function formatForWhatsApp(text: string): string {
  // WhatsApp bold: *text*, italic: _text_, code: `text`, strikethrough: ~text~
  // Our internal format already uses these — just clean up unsupported syntax
  return text
    // Remove markdown headings
    .replace(/^#{1,6}\s+/gm, '')
    // Convert double-star bold to single (WhatsApp uses single *)
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    // Remove horizontal rules
    .replace(/^---+$/gm, '──────────')
    // Limit consecutive newlines
    .replace(/\n{3,}/g, '\n\n');
}

function formatForTelegram(text: string): string {
  // Telegram MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
  // BUT we want to preserve our intentional * and _ formatting
  // Strategy: parse our format first, then escape non-formatting chars

  // We keep our internal format as-is since Telegram supports the same symbols
  // Just handle edge cases

  return text
    // Convert ## headers to bold
    .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*')
    // Ensure list items are formatted correctly
    .replace(/^[-•]\s+/gm, '• ')
    // Limit consecutive newlines
    .replace(/\n{3,}/g, '\n\n');
}

// ─── Semantic Helpers ─────────────────────────────────────────────────────────

export function bold(text: string): string {
  return `*${text}*`;
}

export function italic(text: string): string {
  return `_${text}_`;
}

export function code(text: string): string {
  return `\`${text}\``;
}

export function heading(text: string): string {
  return `*${text}*`;
}

export function listItem(text: string): string {
  return `• ${text}`;
}

export function list(items: string[]): string {
  return items.map(listItem).join('\n');
}

export function divider(): string {
  return '──────────';
}
