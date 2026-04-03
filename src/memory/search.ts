import type Database from 'better-sqlite3';
import type { GroupMessage } from '../types.js';

interface SearchOptions {
  limit?: number;
  sender?: string;
  since?: Date;
}

interface MessageRow {
  id: string;
  group_id: string;
  platform: string;
  sender_id: string;
  sender_name: string;
  text: string | null;
  media_type: string | null;
  media_mime: string | null;
  media_caption: string | null;
  quoted_message_id: string | null;
  timestamp: string;
  raw: string;
}

export function searchMessages(
  db: Database.Database,
  query: string,
  options: SearchOptions = {}
): GroupMessage[] {
  const { limit = 20, sender, since } = options;

  // Escape FTS5 special chars
  const escaped = query.replace(/["]/g, '""');

  let sql = `
    SELECT m.*
    FROM messages m
    JOIN messages_fts fts ON m.rowid = fts.rowid
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [`"${escaped}"`];

  if (sender) {
    sql += ` AND m.sender_name LIKE ?`;
    params.push(`%${sender}%`);
  }
  if (since) {
    sql += ` AND m.timestamp >= ?`;
    params.push(since.toISOString());
  }

  sql += ` ORDER BY m.timestamp DESC LIMIT ?`;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(rowToGroupMessage);
  } catch {
    // FTS5 query syntax error — fall back to LIKE search
    const fallback = db.prepare(`
      SELECT * FROM messages
      WHERE text LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as MessageRow[];
    return fallback.map(rowToGroupMessage);
  }
}

export function getRecentMessages(
  db: Database.Database,
  groupId: string,
  limit: number
): GroupMessage[] {
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(groupId, limit) as MessageRow[];

  return rows.reverse().map(rowToGroupMessage);
}

function rowToGroupMessage(row: MessageRow): GroupMessage {
  const raw = JSON.parse(row.raw) as unknown;
  return {
    id: row.id,
    groupId: row.group_id,
    platform: row.platform as 'whatsapp' | 'telegram',
    sender: {
      id: row.sender_id,
      name: row.sender_name,
    },
    content: {
      text: row.text ?? undefined,
      media: row.media_type
        ? {
            type: row.media_type as 'image' | 'audio' | 'video' | 'document',
            mimeType: row.media_mime ?? 'application/octet-stream',
            caption: row.media_caption ?? undefined,
          }
        : undefined,
    },
    timestamp: new Date(row.timestamp),
    raw,
  };
}
