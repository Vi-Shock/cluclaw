import type Database from 'better-sqlite3';
import type {
  GroupContext,
  GroupMessage,
  Member,
  ScheduledTask,
  LLMInterface,
  SchedulerInterface,
} from '../types.js';
import { getRecentMessages, searchMessages } from './search.js';
import { config } from '../core/config.js';

interface MemberRow {
  id: string;
  group_id: string;
  platform_user_id: string;
  display_name: string;
  phone_number: string | null;
  aliases: string;
}

function loadMembers(db: Database.Database, groupId: string): Member[] {
  const rows = db.prepare(
    'SELECT * FROM members WHERE group_id = ?'
  ).all(groupId) as MemberRow[];

  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    platformUserId: r.platform_user_id,
    displayName: r.display_name,
    phoneNumber: r.phone_number ?? undefined,
    aliases: JSON.parse(r.aliases) as string[],
  }));
}

function loadGroupTimezone(db: Database.Database, groupId: string): string {
  const row = db.prepare(
    'SELECT timezone FROM groups WHERE id = ?'
  ).get(groupId) as { timezone: string } | undefined;
  return row?.timezone ?? config.DEFAULT_TIMEZONE;
}

export function createGroupContext(
  groupId: string,
  platform: 'whatsapp' | 'telegram',
  db: Database.Database,
  scheduler: SchedulerInterface,
  llm: LLMInterface
): GroupContext {
  const members = loadMembers(db, groupId);
  const history = getRecentMessages(db, groupId, config.HISTORY_LIMIT);
  const timezone = loadGroupTimezone(db, groupId);

  return {
    groupId,
    platform,
    members,
    history,
    timezone,
    llm,

    getSkillState<T>(skillName: string): T | null {
      const row = db.prepare(
        'SELECT state FROM skill_state WHERE group_id = ? AND skill_name = ?'
      ).get(groupId, skillName) as { state: string } | undefined;

      if (!row) return null;
      try {
        return JSON.parse(row.state) as T;
      } catch {
        return null;
      }
    },

    setSkillState<T>(skillName: string, state: T): void {
      db.prepare(`
        INSERT INTO skill_state (group_id, skill_name, state, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(group_id, skill_name) DO UPDATE SET
          state = excluded.state,
          updated_at = excluded.updated_at
      `).run(groupId, skillName, JSON.stringify(state));
    },

    scheduler: {
      schedule(task: Omit<ScheduledTask, 'id'>): string {
        return scheduler.schedule(task);
      },
      cancel(taskId: string): void {
        scheduler.cancel(taskId);
      },
      listPending(skillName: string): ScheduledTask[] {
        return scheduler.listPending(skillName).filter(
          (t) => t.groupId === groupId
        );
      },
    },

    searchHistory(query: string): GroupMessage[] {
      return searchMessages(db, query, { limit: 20 });
    },
  };
}
