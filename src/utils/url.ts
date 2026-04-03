import { logger } from '../core/logger.js';

export interface UrlMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  domain: string;
}

/**
 * Fetch URL metadata (title, description, OG image) using native fetch.
 * Uses regex to extract meta tags — no heavy DOM parser needed.
 */
export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CluClaw/1.0)',
        Accept: 'text/html',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) return { url, domain };

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return { url, domain };
    }

    // Read only first 50KB to avoid large pages
    const reader = res.body?.getReader();
    if (!reader) return { url, domain };

    let html = '';
    let bytes = 0;
    while (bytes < 50_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytes += value?.length ?? 0;
    }
    reader.cancel().catch(() => {/* ignore */});

    const title = extractMeta(html, ['og:title', 'twitter:title']) ?? extractTitle(html);
    const description = extractMeta(html, ['og:description', 'twitter:description', 'description']);
    const image = extractMeta(html, ['og:image', 'twitter:image']);

    return { url, title, description, image, domain };
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      logger.debug(`Failed to fetch URL metadata for ${url}:`, err);
    }
    return null;
  }
}

function extractMeta(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const regex = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const match = regex.exec(html) ??
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`,
        'i'
      ).exec(html);

    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return undefined;
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : undefined;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
