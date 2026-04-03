import type { Skill, GroupMessage, GroupContext, SkillResponse, ScheduledTask } from '../../types.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  shouldParseAsExpense,
  looksLikeCorrection,
  parseExpense,
  parseCorrection,
  resolveMemberName,
} from './parser.js';
import {
  addExpense,
  getLastExpense,
  deleteExpense,
  getExpenses,
  calculateBalances,
  simplifyDebts,
  addSettlement,
  updateExpenseAmount,
  getExpenseByPosition,
  findExpensesByDescription,
  updateExpenseSplit,
  updateExpensePayer,
  removePersonFromSplit,
  logExpenseEvent,
  getExpenseEvents,
  updateExpenseDate,
} from './ledger.js';
import type { Expense } from './schemas.js';
import {
  renderSplitsSummary,
  renderDetails,
  renderClarificationQuestion,
  renderCorrectionConfirmation,
  renderDeleteConfirmation,
  renderHelp,
  renderWelcome,
  renderSplitChanged,
  renderAmountChanged,
  renderPayerChanged,
  renderPersonRemoved,
  renderDateChanged,
  renderExpenseHistory,
} from './renderer.js';
import { getGroupDb } from '../../memory/store.js';

const SKILL_NAME = 'expense-split';

// ─── Target Resolution ────────────────────────────────────────────────────────

/**
 * Resolves which expense a correction is targeting.
 * Priority: explicit #N position > description keyword > falls back to last expense.
 * Returns { expense, position } or null if not found / ambiguous.
 */
function resolveExpenseTarget(
  db: import('better-sqlite3').Database,
  groupId: string,
  position: number | undefined,
  description: string | undefined
): { expense: Expense; position: number } | { ambiguous: Expense[] } | null {
  if (position !== undefined) {
    const expense = getExpenseByPosition(db, groupId, position);
    return expense ? { expense, position } : null;
  }

  if (description) {
    const matches = findExpensesByDescription(db, groupId, description);
    if (matches.length === 0) return null;
    if (matches.length === 1) return { expense: matches[0], position: -1 };
    return { ambiguous: matches };
  }

  // Fall back to most recent expense (getExpenses returns DESC, so [0] = newest = #1)
  const all = getExpenses(db, groupId, 100);
  if (all.length === 0) return null;
  return { expense: all[0], position: 1 };
}

/**
 * Formats an ambiguous match response listing expenses with their positions.
 */
function renderAmbiguous(matches: Expense[], db: import('better-sqlite3').Database, groupId: string): string {
  const all = getExpenses(db, groupId, 100);
  const lines = matches.map((m) => {
    const pos = all.findIndex((e) => e.id === m.id) + 1;
    const desc = m.description ?? m.category ?? 'expense';
    return `#${pos}. ${m.payerName} paid ₹${m.amount} for ${desc}`;
  });
  return `🤔 Found multiple matching expenses — which one?\n\n${lines.join('\n')}\n\nUse \`edit #N ...\` to target a specific one.`;
}

/** Parses human date strings into YYYY-MM-DD. Returns null if unrecognised. */
function parseDateInput(input: string): string | null {
  const s = input.trim().toLowerCase();
  const today = new Date();

  if (s === 'today') return today.toISOString().split('T')[0];
  if (s === 'yesterday') {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }

  // ISO format: 2026-04-01
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const months: Record<string, number> = {
    jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
    january:0,february:1,march:2,april:3,june:5,july:6,august:7,september:8,october:9,november:10,december:11,
  };

  // "1 Apr" or "Apr 1"
  const m1 = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(s);
  const m2 = /^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(s);
  const match = m1 ?? m2;
  if (match) {
    const day = m1 ? parseInt(m1[1], 10) : parseInt(m2![2], 10);
    const monStr = m1 ? m1[2] : m2![1];
    const year = parseInt(m1 ? (m1[3] ?? String(today.getFullYear())) : (m2![3] ?? String(today.getFullYear())), 10);
    const mon = months[monStr];
    if (mon === undefined || isNaN(day) || day < 1 || day > 31) return null;
    const d = new Date(year, mon, day);
    return d.toISOString().split('T')[0];
  }

  return null;
}

const expenseSkill: Skill = {
  name: SKILL_NAME,
  description: 'Passively tracks who paid what from group conversation and calculates settlements',

  // ─── Fast Filter ──────────────────────────────────────────────────────────

  shouldActivate(message: GroupMessage): boolean {
    const text = message.content.text ?? message.content.media?.caption ?? '';
    if (!text && !message.content.media) return false;

    // Image could be a receipt
    if (message.content.media?.type === 'image') return true;
    // Audio could be a voice note about an expense
    if (message.content.media?.type === 'audio') return true;

    return shouldParseAsExpense(text) || looksLikeCorrection(text);
  },

  // ─── Main Handler ─────────────────────────────────────────────────────────

  async handle(message: GroupMessage, context: GroupContext): Promise<SkillResponse | null> {
    const db = getGroupDb(message.groupId);
    const text = message.content.text ?? message.content.media?.caption ?? '';

    // 1. Check for corrections first
    if (looksLikeCorrection(text)) {
      const correction = await parseCorrection(message, context);
      if (correction) {
        switch (correction.correction_type) {
          case 'remove_last': {
            const last = getLastExpense(db, message.groupId);
            if (last) {
              deleteExpense(db, last.id);
              return { text: renderDeleteConfirmation(last.description) };
            }
            return { text: '❌ No expense to remove.' };
          }

          case 'update_amount': {
            if (!correction.new_amount) break;
            const result = resolveExpenseTarget(db, message.groupId, correction.expense_position, correction.expense_description);
            if (!result) return { text: '❌ No expense found to update.' };
            if ('ambiguous' in result) return { text: renderAmbiguous(result.ambiguous, db, message.groupId) };
            const oldAmt = result.expense.amount;
            const expDesc = result.expense.description ?? result.expense.category ?? 'expense';
            updateExpenseAmount(db, result.expense.id, correction.new_amount);
            logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'amount_updated', { before: oldAmt, after: correction.new_amount });
            return { text: renderAmountChanged(expDesc, result.position, message.sender.name, oldAmt, correction.new_amount, result.expense.currency) };
          }

          case 'change_split': {
            if (!correction.new_split_among?.length) break;
            const result = resolveExpenseTarget(db, message.groupId, correction.expense_position, correction.expense_description);
            if (!result) return { text: '❌ Couldn\'t find that expense. Type `details` to see all.' };
            if ('ambiguous' in result) return { text: renderAmbiguous(result.ambiguous, db, message.groupId) };
            const splitMembers = correction.new_split_among
              .map((name) => resolveMemberName(name === 'me' || name === 'I' ? message.sender.name : name, context.members))
              .filter((m): m is NonNullable<typeof m> => m !== undefined);
            if (splitMembers.length === 0) return { text: '❌ Couldn\'t resolve any of the named members.' };
            const beforeSplit = result.expense.splits.map((s) => s.memberName);
            const afterSplit = splitMembers.map((m) => m.displayName);
            updateExpenseSplit(db, result.expense.id, splitMembers);
            logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'split_changed', { before: beforeSplit, after: afterSplit });
            const expDesc2 = result.expense.description ?? result.expense.category ?? 'expense';
            return { text: renderSplitChanged(expDesc2, result.position, message.sender.name, beforeSplit, afterSplit, result.expense.amount, result.expense.currency) };
          }

          case 'change_payer': {
            if (!correction.new_payer) break;
            const result = resolveExpenseTarget(db, message.groupId, correction.expense_position, correction.expense_description);
            if (!result) return { text: '❌ Couldn\'t find that expense. Type `details` to see all.' };
            if ('ambiguous' in result) return { text: renderAmbiguous(result.ambiguous, db, message.groupId) };
            const newPayer = resolveMemberName(correction.new_payer, context.members);
            if (!newPayer) return { text: `❌ Couldn't find member "${correction.new_payer}".` };
            const oldPayer = result.expense.payerName;
            updateExpensePayer(db, result.expense.id, newPayer.id);
            logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'payer_changed', { before: oldPayer, after: newPayer.displayName });
            const expDesc3 = result.expense.description ?? result.expense.category ?? 'expense';
            return { text: renderPayerChanged(expDesc3, result.position, message.sender.name, oldPayer, newPayer.displayName) };
          }

          case 'remove_person': {
            if (!correction.remove_person) break;
            const result = resolveExpenseTarget(db, message.groupId, correction.expense_position, correction.expense_description);
            if (!result) return { text: '❌ Couldn\'t find that expense. Type `details` to see all.' };
            if ('ambiguous' in result) return { text: renderAmbiguous(result.ambiguous, db, message.groupId) };
            const person = resolveMemberName(correction.remove_person, context.members);
            if (!person) return { text: `❌ Couldn't find member "${correction.remove_person}".` };
            const beforeNames = result.expense.splits.map((s) => s.memberName);
            const afterNames = beforeNames.filter((n) => n !== person.displayName);
            removePersonFromSplit(db, result.expense.id, person.id);
            logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'person_removed', { removed: person.displayName, before: beforeNames, after: afterNames });
            const expDesc4 = result.expense.description ?? result.expense.category ?? 'expense';
            return { text: renderPersonRemoved(expDesc4, result.position, message.sender.name, person.displayName, beforeNames, afterNames, result.expense.amount, result.expense.currency) };
          }

          default:
            break;
        }
      }
    }

    // 2. Try parsing as a new expense
    const extraction = await parseExpense(message, context.members, context, expenseSkill.skillMd);
    if (!extraction) return null;

    // 2a. Needs clarification
    if (extraction.needs_clarification && extraction.clarification_question) {
      return {
        text: renderClarificationQuestion(extraction.clarification_question),
        replyTo: message.id,
      };
    }

    // 2b. Low confidence — stay silent
    if (extraction.confidence < 0.6) {
      logger.debug(`Low confidence (${extraction.confidence}), staying silent`);
      return null;
    }

    // 2c. High confidence — record the expense
    const expense = addExpense(
      db,
      message.groupId,
      extraction,
      context.members,
      message.id,
      message.sender.name
    );

    if (!expense) {
      logger.warn('addExpense returned null — could not resolve members');
      return null;
    }

    // Log creation event for audit trail
    logExpenseEvent(db, expense.id, message.groupId, message.sender.name, 'created', {
      payer: expense.payerName,
      amount: expense.amount,
      currency: expense.currency,
      split: expense.splits.map((s) => s.memberName),
    });

    logger.info(
      `Recorded expense: ${expense.amount} ${expense.currency} by ${expense.payerName} — ${expense.description}`
    );

    // Stay silent for very high confidence expenses; confirm for medium confidence
    if (extraction.confidence >= 0.85) {
      return { silent: true };
    }

    return {
      text: `✅ Got it — ${expense.payerName} paid ${expense.amount} ${expense.currency}${expense.description ? ` for ${expense.description}` : ''}.`,
      silent: false,
    };
  },

  // ─── Commands ─────────────────────────────────────────────────────────────

  commands: {
    splits: async (_args: string, context: GroupContext): Promise<SkillResponse | null> => {
      const db = getGroupDb(context.groupId);
      const rawBalances = calculateBalances(db, context.groupId);
      const simplified = simplifyDebts(rawBalances);
      return { text: renderSplitsSummary(simplified) };
    },

    split: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      return expenseSkill.commands['splits']!(args, context);
    },

    balances: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      return expenseSkill.commands['splits']!(args, context);
    },

    'settle up': async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      return expenseSkill.commands['splits']!(args, context);
    },

    details: async (_args: string, context: GroupContext): Promise<SkillResponse | null> => {
      const db = getGroupDb(context.groupId);
      const expenses = getExpenses(db, context.groupId);
      return { text: renderDetails(expenses) };
    },

    detail: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      return expenseSkill.commands['details']!(args, context);
    },

    expenses: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      return expenseSkill.commands['details']!(args, context);
    },

    help: async (_args: string, _context: GroupContext): Promise<SkillResponse | null> => {
      return { text: renderHelp(config.BOT_NAME) };
    },

    'remove last': async (_args: string, context: GroupContext): Promise<SkillResponse | null> => {
      const db = getGroupDb(context.groupId);
      const last = getLastExpense(db, context.groupId);
      if (!last) return { text: '❌ No expense to remove.' };
      deleteExpense(db, last.id);
      return { text: renderDeleteConfirmation(last.description) };
    },

    undo: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      return expenseSkill.commands['remove last']!(args, context);
    },

    remove: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      // Support: remove #N  or  remove last
      const trimmed = args.trim();
      if (!trimmed || trimmed.toLowerCase() === 'last') {
        return expenseSkill.commands['remove last']!('', context);
      }
      const posMatch = /^#?(\d+)$/.exec(trimmed);
      if (!posMatch) return { text: '❌ Usage: `remove #N` or `remove last`' };
      const position = parseInt(posMatch[1], 10);
      const db = getGroupDb(context.groupId);
      const expense = getExpenseByPosition(db, context.groupId, position);
      if (!expense) return { text: `❌ No expense at position #${position}. Type \`details\` to see all.` };
      deleteExpense(db, expense.id);
      return { text: renderDeleteConfirmation(expense.description ?? null) };
    },

    edit: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      // Syntax: edit #N <op> <value>
      // op: split <names> | amount <value> | payer <name> | remove <name>
      const trimmed = args.trim();
      const match = /^#?(\d+)\s+(\w+)\s*(.*)$/i.exec(trimmed);
      if (!match) {
        return {
          text: '❌ Usage:\n`edit #N split Vishak, Supriya`\n`edit #N amount 350`\n`edit #N payer Supriya`\n`edit #N remove Priya`\n`edit #N date 1 Apr`',
        };
      }

      const position = parseInt(match[1], 10);
      const op = match[2].toLowerCase();
      const value = match[3].trim();
      const db = getGroupDb(context.groupId);
      const expense = getExpenseByPosition(db, context.groupId, position);

      if (!expense) {
        return { text: `❌ No expense at position #${position}. Type \`details\` to see all.` };
      }

      const desc = expense.description ?? expense.category ?? `expense #${position}`;

      switch (op) {
        case 'split': {
          const names = value.split(/[,&]+/).map((n) => n.trim()).filter(Boolean);
          if (names.length === 0) return { text: '❌ Provide at least one name to split with.' };
          const members = names
            .map((n) => resolveMemberName(n, context.members))
            .filter((m): m is NonNullable<typeof m> => m !== undefined);
          if (members.length === 0) return { text: '❌ Couldn\'t resolve any of the named members.' };
          const beforeSplit = expense.splits.map((s) => s.memberName);
          const afterSplit = members.map((m) => m.displayName);
          updateExpenseSplit(db, expense.id, members);
          logExpenseEvent(db, expense.id, context.groupId, context.members.find((m) => m.displayName === context.groupId)?.displayName ?? 'unknown', 'split_changed', { before: beforeSplit, after: afterSplit });
          return { text: renderSplitChanged(desc, position, 'You', beforeSplit, afterSplit, expense.amount, expense.currency) };
        }

        case 'amount': {
          const amount = parseFloat(value);
          if (isNaN(amount) || amount <= 0) return { text: '❌ Invalid amount.' };
          const oldAmt = expense.amount;
          updateExpenseAmount(db, expense.id, amount);
          logExpenseEvent(db, expense.id, context.groupId, 'you', 'amount_updated', { before: oldAmt, after: amount });
          return { text: renderAmountChanged(desc, position, 'You', oldAmt, amount, expense.currency) };
        }

        case 'payer': {
          const newPayer = resolveMemberName(value, context.members);
          if (!newPayer) return { text: `❌ Couldn't find member "${value}".` };
          const oldPayer = expense.payerName;
          updateExpensePayer(db, expense.id, newPayer.id);
          logExpenseEvent(db, expense.id, context.groupId, 'you', 'payer_changed', { before: oldPayer, after: newPayer.displayName });
          return { text: renderPayerChanged(desc, position, 'You', oldPayer, newPayer.displayName) };
        }

        case 'remove': {
          const person = resolveMemberName(value, context.members);
          if (!person) return { text: `❌ Couldn't find member "${value}".` };
          const beforeNames = expense.splits.map((s) => s.memberName);
          const afterNames = beforeNames.filter((n) => n !== person.displayName);
          removePersonFromSplit(db, expense.id, person.id);
          logExpenseEvent(db, expense.id, context.groupId, 'you', 'person_removed', { removed: person.displayName, before: beforeNames, after: afterNames });
          return { text: renderPersonRemoved(desc, position, 'You', person.displayName, beforeNames, afterNames, expense.amount, expense.currency) };
        }

        case 'date': {
          const parsed = parseDateInput(value);
          if (!parsed) return { text: `❌ Couldn't parse date "${value}". Try: 1 Apr, Apr 1, yesterday, 2026-04-01` };
          const oldDate = expense.expenseDate;
          updateExpenseDate(db, expense.id, parsed);
          logExpenseEvent(db, expense.id, context.groupId, 'you', 'date_updated', { before: oldDate.toISOString().split('T')[0], after: parsed });
          return { text: renderDateChanged(desc, position, 'You', oldDate, new Date(parsed)) };
        }

        default:
          return { text: `❌ Unknown operation "${op}". Use: split, amount, payer, remove, date` };
      }
    },

    history: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      const trimmed = args.trim();
      const posMatch = /^#?(\d+)$/.exec(trimmed);
      if (!posMatch) return { text: '❌ Usage: `history #N` — e.g. `history #2`' };
      const position = parseInt(posMatch[1], 10);
      const db = getGroupDb(context.groupId);
      const expense = getExpenseByPosition(db, context.groupId, position);
      if (!expense) return { text: `❌ No expense at #${position}. Type \`details\` to see all.` };
      const events = getExpenseEvents(db, expense.id);
      return { text: renderExpenseHistory(expense, position, events) };
    },

    settle: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      // Syntax: settle <name> <amount> [currency]
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        return { text: '❌ Usage: `settle <name> <amount>` e.g. `settle Ravi 500`' };
      }

      const amountStr = parts[parts.length - 1];
      const amount = parseFloat(amountStr);
      if (isNaN(amount)) {
        return { text: '❌ Invalid amount. Usage: `settle <name> <amount>`' };
      }

      const name = parts.slice(0, -1).join(' ');
      const toMember = resolveMemberName(name, context.members);
      if (!toMember) {
        return { text: `❌ Couldn't find member "${name}" in this group.` };
      }

      const fromMember = context.members.find(
        (m) => m.platformUserId === context.groupId || m.displayName === 'You'
      ) ?? context.members[0];

      if (!fromMember) return { text: '❌ Could not identify who is settling.' };

      const db = getGroupDb(context.groupId);
      addSettlement(db, context.groupId, fromMember.id, toMember.id, amount);

      return {
        text: `✅ Recorded: paid ${toMember.displayName} ₹${amount}`,
      };
    },
  },

  // ─── Install ──────────────────────────────────────────────────────────────

  async onInstall(context: GroupContext): Promise<void> {
    logger.info(`Expense skill installed in group ${context.groupId}`);
  },

  // ─── Scheduled Tasks (not used by expense skill, but interface satisfied) ─

  async onScheduledTask(
    _task: ScheduledTask,
    _context: GroupContext
  ): Promise<SkillResponse | null> {
    return null;
  },
};

export default expenseSkill;
