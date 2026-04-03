import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

// ─── Connection Cache ──────────────────────────────────────────────────────────

const connections = new Map<string, Database.Database>();

function openDb(filePath: string): Database.Database {
  if (connections.has(filePath)) {
    return connections.get(filePath)!;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  connections.set(filePath, db);
  logger.debug(`Opened database: ${filePath}`);
  return db;
}

// ─── Global DB ────────────────────────────────────────────────────────────────

export function getGlobalDb(): Database.Database {
  const filePath = join(config.DATA_DIR, 'agent.db');
  const db = openDb(filePath);
  migrateGlobalDb(db);
  return db;
}

function migrateGlobalDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      skill_name  TEXT NOT NULL,
      group_id    TEXT NOT NULL,
      execute_at  TEXT NOT NULL,
      recurrence  TEXT,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_execute_at
      ON scheduled_tasks (execute_at, status);

    CREATE TABLE IF NOT EXISTS skill_registry (
      name        TEXT PRIMARY KEY,
      version     TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ─── Group DB ─────────────────────────────────────────────────────────────────

export function getGroupDb(groupId: string): Database.Database {
  const safe = groupId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = join(config.DATA_DIR, safe, 'database.db');
  const db = openDb(filePath);
  migrateGroupDb(db);
  return db;
}

function migrateGroupDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      name        TEXT,
      timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS members (
      id                TEXT PRIMARY KEY,
      group_id          TEXT NOT NULL REFERENCES groups(id),
      platform_user_id  TEXT NOT NULL,
      display_name      TEXT NOT NULL,
      phone_number      TEXT,
      aliases           TEXT NOT NULL DEFAULT '[]',
      UNIQUE(group_id, platform_user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                TEXT PRIMARY KEY,
      group_id          TEXT NOT NULL REFERENCES groups(id),
      platform          TEXT NOT NULL,
      sender_id         TEXT NOT NULL,
      sender_name       TEXT NOT NULL,
      text              TEXT,
      media_type        TEXT,
      media_mime        TEXT,
      media_caption     TEXT,
      quoted_message_id TEXT,
      timestamp         TEXT NOT NULL,
      raw               TEXT NOT NULL DEFAULT '{}'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      sender_name,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, sender_name)
        VALUES (new.rowid, new.text, new.sender_name);
    END;

    CREATE TABLE IF NOT EXISTS expenses (
      id                TEXT PRIMARY KEY,
      group_id          TEXT NOT NULL REFERENCES groups(id),
      payer_id          TEXT NOT NULL REFERENCES members(id),
      amount            REAL NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'INR',
      description       TEXT,
      category          TEXT,
      split_type        TEXT NOT NULL DEFAULT 'equal',
      source_message_id TEXT,
      expense_date      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS expense_events (
      id          TEXT PRIMARY KEY,
      expense_id  TEXT NOT NULL,
      group_id    TEXT NOT NULL REFERENCES groups(id),
      actor_name  TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_expense_events_expense_id
      ON expense_events (expense_id);

    CREATE TABLE IF NOT EXISTS expense_splits (
      id           TEXT PRIMARY KEY,
      expense_id   TEXT NOT NULL REFERENCES expenses(id),
      member_id    TEXT NOT NULL REFERENCES members(id),
      share_amount REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id             TEXT PRIMARY KEY,
      group_id       TEXT NOT NULL REFERENCES groups(id),
      from_member_id TEXT NOT NULL REFERENCES members(id),
      to_member_id   TEXT NOT NULL REFERENCES members(id),
      amount         REAL NOT NULL,
      currency       TEXT NOT NULL DEFAULT 'INR',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_state (
      group_id    TEXT NOT NULL REFERENCES groups(id),
      skill_name  TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, skill_name)
    );
  `);

  // Additive migration for existing groups — safe if column already exists
  try { db.exec(`ALTER TABLE expenses ADD COLUMN expense_date TEXT`); } catch { /* exists */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function closeAll(): void {
  for (const [path, db] of connections) {
    try {
      db.close();
      logger.debug(`Closed database: ${path}`);
    } catch { /* ignore */ }
  }
  connections.clear();
}

export function ensureGroup(
  db: Database.Database,
  groupId: string,
  platform: string,
  name?: string
): void {
  db.prepare(`
    INSERT OR IGNORE INTO groups (id, platform, name)
    VALUES (?, ?, ?)
  `).run(groupId, platform, name ?? null);
}

export function upsertMember(
  db: Database.Database,
  groupId: string,
  platformUserId: string,
  displayName: string,
  phoneNumber?: string
): string {
  const id = `${groupId}:${platformUserId}`;
  db.prepare(`
    INSERT INTO members (id, group_id, platform_user_id, display_name, phone_number)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, platform_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      phone_number = COALESCE(excluded.phone_number, phone_number)
  `).run(id, groupId, platformUserId, displayName, phoneNumber ?? null);
  return id;
}

/**
 * Finds or creates a member by display name. Used when a person is mentioned
 * in a message (e.g. "Supriya paid 50") but hasn't sent a message yet and
 * isn't in the members table. Creates a placeholder with a synthetic platform ID.
 */
export function ensureMemberByName(
  db: Database.Database,
  groupId: string,
  displayName: string
): string {
  // Try exact name match first (case-insensitive)
  const existing = db.prepare(
    `SELECT id FROM members WHERE group_id = ? AND LOWER(display_name) = LOWER(?)`
  ).get(groupId, displayName) as { id: string } | undefined;

  if (existing) return existing.id;

  // Create placeholder — synthetic platform_user_id derived from name
  const syntheticUserId = `named:${displayName.toLowerCase().replace(/\s+/g, '_')}`;
  return upsertMember(db, groupId, syntheticUserId, displayName);
}
