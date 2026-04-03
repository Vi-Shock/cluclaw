import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { ScheduledTask, SchedulerInterface } from '../types.js';
import { logger } from './logger.js';

interface TaskRow {
  id: string;
  skill_name: string;
  group_id: string;
  execute_at: string;
  recurrence: string | null;
  payload: string;
  status: string;
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    skillName: row.skill_name,
    groupId: row.group_id,
    executeAt: new Date(row.execute_at),
    recurrence: row.recurrence ?? undefined,
    payload: JSON.parse(row.payload) as unknown,
  };
}

// Minimal cron parser: "min hour dom month dow"
// Only handles simple patterns like "0 9 * * 1-5"
function nextCronDate(cron: string, from: Date): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Default: 1 hour from now
    return new Date(from.getTime() + 60 * 60 * 1000);
  }

  const [minStr, hourStr] = parts;
  const min = minStr === '*' ? from.getMinutes() : parseInt(minStr, 10);
  const hour = hourStr === '*' ? from.getHours() : parseInt(hourStr, 10);

  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(isNaN(min) ? 0 : min);
  next.setHours(isNaN(hour) ? next.getHours() : hour);

  // If the computed time is in the past, advance by 1 day
  if (next <= from) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

export class Scheduler implements SchedulerInterface {
  constructor(private readonly db: Database.Database) {}

  schedule(task: Omit<ScheduledTask, 'id'>): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO scheduled_tasks
        (id, skill_name, group_id, execute_at, recurrence, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      task.skillName,
      task.groupId,
      task.executeAt.toISOString(),
      task.recurrence ?? null,
      JSON.stringify(task.payload)
    );
    logger.debug(`Scheduled task ${id} for skill ${task.skillName} at ${task.executeAt.toISOString()}`);
    return id;
  }

  cancel(taskId: string): void {
    this.db.prepare(`
      UPDATE scheduled_tasks SET status = 'cancelled'
      WHERE id = ? AND status = 'pending'
    `).run(taskId);
  }

  listPending(skillName: string): ScheduledTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE skill_name = ? AND status = 'pending'
      ORDER BY execute_at ASC
    `).all(skillName) as TaskRow[];
    return rows.map(rowToTask);
  }

  // Called every 60s from agent main loop. Returns tasks that are due.
  tick(): ScheduledTask[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'pending' AND execute_at <= ?
      ORDER BY execute_at ASC
    `).all(now) as TaskRow[];

    const due: ScheduledTask[] = [];

    for (const row of rows) {
      // Mark as running
      this.db.prepare(
        `UPDATE scheduled_tasks SET status = 'running' WHERE id = ?`
      ).run(row.id);

      due.push(rowToTask(row));

      // If recurring, schedule the next occurrence
      if (row.recurrence) {
        const next = nextCronDate(row.recurrence, new Date());
        this.db.prepare(`
          INSERT INTO scheduled_tasks
            (id, skill_name, group_id, execute_at, recurrence, payload)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          row.skill_name,
          row.group_id,
          next.toISOString(),
          row.recurrence,
          row.payload
        );
      }
    }

    return due;
  }

  markComplete(taskId: string): void {
    this.db.prepare(
      `UPDATE scheduled_tasks SET status = 'completed' WHERE id = ?`
    ).run(taskId);
  }

  markFailed(taskId: string): void {
    this.db.prepare(
      `UPDATE scheduled_tasks SET status = 'failed' WHERE id = ?`
    ).run(taskId);
  }
}
