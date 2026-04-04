import type { Skill, GroupMessage, GroupContext, SkillResponse, ScheduledTask } from '../../types.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  shouldParseAsExpense,
  looksLikeCorrection,
  parseExpense,
  parseCorrection,
  fastParseCorrection,
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
  addPersonToSplit,
  updateExpenseDescription,
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
  renderPersonAdded,
  renderDescriptionChanged,
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
    if (matches.length === 1) {
      const all = getExpenses(db, groupId, 100);
      const pos = all.findIndex((e) => e.id === matches[0].id) + 1;
      return { expense: matches[0], position: pos > 0 ? pos : 1 };
    }
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

/**
 * Tries to detect a peer-to-peer settlement ("X paid Y amount" or "paid Y amount").
 * Checks that the recipient resolves to a known group member so we don't confuse
 * "Ravi paid 500 for dinner" (expense) with "Ravi paid Priya 500" (settlement).
 */
function tryParseSettlement(
  text: string,
  senderName: string,
  members: import('../../types.js').Member[]
): { fromId: string; fromName: string; toId: string; toName: string; amount: number } | null {
  // Extract a numeric amount anywhere in the message
  const amountMatch = /₹\s*(\d+(?:\.\d+)?)/i.exec(text)
    ?? /(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|rupees?)?\s*$/i.exec(text);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1]);
  if (isNaN(amount) || amount <= 0) return null;

  // Check if any member name appears right after "paid" (→ that member is the recipient)
  for (const toMember of members) {
    const variants = [toMember.displayName, ...toMember.aliases];
    for (const name of variants) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`\\bpaid\\s+${escaped}\\b`, 'i').test(text)) continue;

      // Recipient found — now resolve payer
      const beforePaid = /^(.+?)\s+paid\b/i.exec(text);
      let fromMember: import('../../types.js').Member | undefined;
      if (beforePaid) {
        const fromName = beforePaid[1].trim();
        fromMember = /^(i|me)$/i.test(fromName)
          ? resolveMemberName(senderName, members)
          : resolveMemberName(fromName, members);
      } else {
        fromMember = resolveMemberName(senderName, members);
      }

      if (!fromMember || fromMember.id === toMember.id) continue;
      return { fromId: fromMember.id, fromName: fromMember.displayName, toId: toMember.id, toName: toMember.displayName, amount };
    }
  }
  return null;
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
      // Try deterministic regex extraction first; fall back to LLM only if needed
      const fastResult = fastParseCorrection(text);
      const correction = fastResult ?? await parseCorrection(message, context);
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

            // Safety net: if LLM said change_split but only named 1 person not already in the split,
            // treat it as add_person so we don't accidentally replace the whole split.
            if (splitMembers.length === 1 && !beforeSplit.includes(splitMembers[0].displayName)) {
              const personToAdd = splitMembers[0];
              const addedOk = addPersonToSplit(db, result.expense.id, personToAdd);
              if (!addedOk) return { text: `ℹ️ ${personToAdd.displayName} is already in the split.` };
              const afterAdd = [...beforeSplit, personToAdd.displayName];
              logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'person_added', { added: personToAdd.displayName, before: beforeSplit, after: afterAdd });
              const expDescAdd = result.expense.description ?? result.expense.category ?? 'expense';
              return { text: renderPersonAdded(expDescAdd, result.position, message.sender.name, personToAdd.displayName, beforeSplit, afterAdd, result.expense.amount, result.expense.currency) };
            }
            // Resolve new_split_amounts by memberId for unequal splits
            let splitAmountsById: Record<string, number> | undefined;
            if (correction.new_split_amounts && Object.keys(correction.new_split_amounts).length > 0) {
              splitAmountsById = {};
              for (const [name, val] of Object.entries(correction.new_split_amounts)) {
                const resolved = resolveMemberName(name === 'me' || name === 'I' ? message.sender.name : name, context.members);
                if (resolved) splitAmountsById[resolved.id] = val;
              }
            }
            const splitTypeForUpdate = (correction as { split_type?: string }).split_type as 'equal' | 'exact' | 'percentage' | undefined ?? 'equal';
            updateExpenseSplit(db, result.expense.id, splitMembers, splitAmountsById, splitTypeForUpdate);
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

          case 'add_person': {
            if (!correction.add_person) break;
            const result = resolveExpenseTarget(db, message.groupId, correction.expense_position, correction.expense_description);
            if (!result) return { text: '❌ Couldn\'t find that expense. Type `details` to see all.' };
            if ('ambiguous' in result) return { text: renderAmbiguous(result.ambiguous, db, message.groupId) };
            const person = resolveMemberName(correction.add_person, context.members);
            if (!person) return { text: `❌ Couldn't find member "${correction.add_person}" in this group.` };
            const beforeNamesAdd = result.expense.splits.map((s) => s.memberName);
            const added = addPersonToSplit(db, result.expense.id, person);
            if (!added) return { text: `ℹ️ ${person.displayName} is already in the split.` };
            const afterNamesAdd = [...beforeNamesAdd, person.displayName];
            logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'person_added', { added: person.displayName, before: beforeNamesAdd, after: afterNamesAdd });
            const expDesc5 = result.expense.description ?? result.expense.category ?? 'expense';
            return { text: renderPersonAdded(expDesc5, result.position, message.sender.name, person.displayName, beforeNamesAdd, afterNamesAdd, result.expense.amount, result.expense.currency) };
          }

          case 'change_description': {
            if (!correction.new_description) break;
            const result = resolveExpenseTarget(db, message.groupId, correction.expense_position, correction.expense_description);
            if (!result) return { text: '❌ Couldn\'t find that expense. Type `details` to see all.' };
            if ('ambiguous' in result) return { text: renderAmbiguous(result.ambiguous, db, message.groupId) };
            const oldDesc = result.expense.description ?? result.expense.category ?? 'expense';
            updateExpenseDescription(db, result.expense.id, correction.new_description);
            logExpenseEvent(db, result.expense.id, message.groupId, message.sender.name, 'description_updated', { before: oldDesc, after: correction.new_description });
            return { text: renderDescriptionChanged(correction.new_description, result.position, message.sender.name, oldDesc, correction.new_description) };
          }

          default:
            break;
        }
      }
    }

    // 2. Fast-path settlement detection: "X paid Y amount" where Y is a known member
    const settlement = tryParseSettlement(text, message.sender.name, context.members);
    if (settlement) {
      const db2 = getGroupDb(message.groupId);
      addSettlement(db2, message.groupId, settlement.fromId, settlement.toId, settlement.amount);
      logger.info(`Settlement recorded: ${settlement.fromName} paid ${settlement.toName} ₹${settlement.amount}`);
      return { text: `✅ Recorded: ${settlement.fromName} paid *${settlement.toName}* ₹${settlement.amount}` };
    }

    // 3. Try parsing as a new expense
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
      if (!posMatch) return null; // doesn't look like a command — let NL correction handle it
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
      if (!match) return null; // doesn't start with #N — let NL correction handle it

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
          // Support: "Ravi, Priya" (equal), "Ravi:200, Priya:150" (exact), "Ravi:60%, Priya:40%" (percentage)
          const parts = value.split(/[,&]+/).map((n) => n.trim()).filter(Boolean);
          if (parts.length === 0) return { text: '❌ Provide at least one name to split with.' };

          let splitType: 'equal' | 'exact' | 'percentage' = 'equal';
          const splitAmountsById: Record<string, number> = {};
          const members: NonNullable<ReturnType<typeof resolveMemberName>>[] = [];

          for (const part of parts) {
            // Match "Name:200" or "Name:60%"
            const colonMatch = /^(.+?):(\d+(?:\.\d+)?)(%)?\s*$/.exec(part);
            if (colonMatch) {
              const memberName = colonMatch[1].trim();
              const val = parseFloat(colonMatch[2]);
              const isPct = colonMatch[3] === '%';
              if (isPct) splitType = 'percentage';
              else if (splitType === 'equal') splitType = 'exact';
              const m = resolveMemberName(memberName, context.members);
              if (!m) return { text: `❌ Couldn't find member "${memberName}".` };
              members.push(m);
              splitAmountsById[m.id] = val;
            } else {
              const m = resolveMemberName(part, context.members);
              if (!m) return { text: `❌ Couldn't find member "${part}".` };
              members.push(m);
            }
          }

          if (members.length === 0) return { text: '❌ Couldn\'t resolve any of the named members.' };
          const beforeSplit = expense.splits.map((s) => s.memberName);
          const afterSplit = members.map((m) => m.displayName);
          updateExpenseSplit(db, expense.id, members, Object.keys(splitAmountsById).length > 0 ? splitAmountsById : undefined, splitType);
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'split_changed', { before: beforeSplit, after: afterSplit });
          return { text: renderSplitChanged(desc, position, 'You', beforeSplit, afterSplit, expense.amount, expense.currency) };
        }

        case 'add': {
          const personToAdd = resolveMemberName(value, context.members);
          if (!personToAdd) return { text: `❌ Couldn't find member "${value}".` };
          const beforeNamesAdd = expense.splits.map((s) => s.memberName);
          const added = addPersonToSplit(db, expense.id, personToAdd);
          if (!added) return { text: `ℹ️ ${personToAdd.displayName} is already in the split.` };
          const afterNamesAdd = [...beforeNamesAdd, personToAdd.displayName];
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'person_added', { added: personToAdd.displayName, before: beforeNamesAdd, after: afterNamesAdd });
          return { text: renderPersonAdded(desc, position, 'You', personToAdd.displayName, beforeNamesAdd, afterNamesAdd, expense.amount, expense.currency) };
        }

        case 'amount': {
          const amount = parseFloat(value);
          if (isNaN(amount) || amount <= 0) return { text: '❌ Invalid amount.' };
          const oldAmt = expense.amount;
          updateExpenseAmount(db, expense.id, amount);
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'amount_updated', { before: oldAmt, after: amount });
          return { text: renderAmountChanged(desc, position, 'You', oldAmt, amount, expense.currency) };
        }

        case 'payer': {
          const newPayer = resolveMemberName(value, context.members);
          if (!newPayer) return { text: `❌ Couldn't find member "${value}".` };
          const oldPayer = expense.payerName;
          updateExpensePayer(db, expense.id, newPayer.id);
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'payer_changed', { before: oldPayer, after: newPayer.displayName });
          return { text: renderPayerChanged(desc, position, 'You', oldPayer, newPayer.displayName) };
        }

        case 'remove': {
          const person = resolveMemberName(value, context.members);
          if (!person) return { text: `❌ Couldn't find member "${value}".` };
          const beforeNames = expense.splits.map((s) => s.memberName);
          const afterNames = beforeNames.filter((n) => n !== person.displayName);
          removePersonFromSplit(db, expense.id, person.id);
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'person_removed', { removed: person.displayName, before: beforeNames, after: afterNames });
          return { text: renderPersonRemoved(desc, position, 'You', person.displayName, beforeNames, afterNames, expense.amount, expense.currency) };
        }

        case 'date': {
          const parsed = parseDateInput(value);
          if (!parsed) return { text: `❌ Couldn't parse date "${value}". Try: 1 Apr, Apr 1, yesterday, 2026-04-01` };
          const oldDate = expense.expenseDate;
          updateExpenseDate(db, expense.id, parsed);
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'date_updated', { before: oldDate.toISOString().split('T')[0], after: parsed });
          return { text: renderDateChanged(desc, position, 'You', oldDate, new Date(parsed)) };
        }

        case 'description': {
          if (!value) return { text: '❌ Provide a new description.' };
          const oldDescEdit = expense.description ?? expense.category ?? 'expense';
          updateExpenseDescription(db, expense.id, value);
          logExpenseEvent(db, expense.id, context.groupId, 'You', 'description_updated', { before: oldDescEdit, after: value });
          return { text: renderDescriptionChanged(value, position, 'You', oldDescEdit, value) };
        }

        default:
          return { text: `❌ Unknown operation "${op}". Use: split, add, amount, payer, remove, date, description` };
      }
    },

    history: async (args: string, context: GroupContext): Promise<SkillResponse | null> => {
      const trimmed = args.trim();
      const posMatch = /^#?(\d+)$/.exec(trimmed);
      if (!posMatch) return null; // let NL correction handle it
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

      // settle command is always "I am settling with <name>" — look up sender from history
      const lastMsg = context.history[context.history.length - 1];
      const senderName = lastMsg?.sender.name;
      const fromMember = senderName ? resolveMemberName(senderName, context.members) : undefined;
      if (!fromMember) return { text: '❌ Could not identify who is settling. Try: `settle <name> <amount>`' };

      const db = getGroupDb(context.groupId);
      addSettlement(db, context.groupId, fromMember.id, toMember.id, amount);

      return {
        text: `✅ Recorded: ${fromMember.displayName} paid *${toMember.displayName}* ₹${amount}`,
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
