import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Member } from '../../types.js';
import type { ExpenseExtraction, Expense, Balance, ExpenseEvent, ExpenseEventType } from './schemas.js';
import { resolveMemberName } from './parser.js';
import { logger } from '../../core/logger.js';
import { ensureMemberByName } from '../../memory/store.js';

// ─── Expense CRUD ─────────────────────────────────────────────────────────────

export function addExpense(
  db: Database.Database,
  groupId: string,
  extraction: ExpenseExtraction,
  members: Member[],
  sourceMessageId: string,
  senderName: string
): Expense | null {
  let knownMembers = members; // local copy so we can append placeholders
  const payerName = extraction.payer ?? senderName;
  let payerMember = resolveMemberName(payerName, knownMembers);

  if (!payerMember) {
    // Auto-register the named person as a placeholder member so the expense isn't lost
    logger.info(`Auto-registering unknown payer "${payerName}" as placeholder member`);
    const id = ensureMemberByName(db, groupId, payerName);
    payerMember = { id, groupId, platformUserId: `named:${payerName}`, displayName: payerName, aliases: [] };
    knownMembers = [...knownMembers, payerMember];
  }

  const splitNames = extraction.split_among ?? knownMembers.map((m) => m.displayName);
  const splitMembers: Member[] = splitNames.map((name) => {
    const resolved = resolveMemberName(name, knownMembers);
    if (resolved) return resolved;
    // Auto-register unknown split members too
    logger.info(`Auto-registering unknown split member "${name}" as placeholder member`);
    const id = ensureMemberByName(db, groupId, name);
    const placeholder: Member = { id, groupId, platformUserId: `named:${name}`, displayName: name, aliases: [] };
    knownMembers = [...knownMembers, placeholder];
    return placeholder;
  });

  if (splitMembers.length === 0) {
    logger.warn('Could not resolve any split members');
    return null;
  }

  const amount = extraction.amount ?? 0;

  // Compute per-member share amounts (equal by default, exact or percentage if provided)
  const splitAmountsByName = extraction.split_amounts ?? {};
  const computedShares: Map<string, number> = new Map();

  if (extraction.split_type === 'exact' && Object.keys(splitAmountsByName).length > 0) {
    for (const member of splitMembers) {
      const share = splitAmountsByName[member.displayName] ?? splitAmountsByName[member.displayName.split(' ')[0]];
      computedShares.set(member.id, share ?? 0);
    }
  } else if (extraction.split_type === 'percentage' && Object.keys(splitAmountsByName).length > 0) {
    for (const member of splitMembers) {
      const pct = splitAmountsByName[member.displayName] ?? splitAmountsByName[member.displayName.split(' ')[0]] ?? 0;
      computedShares.set(member.id, amount * (pct / 100));
    }
  } else {
    // Equal split
    const shareAmount = amount / splitMembers.length;
    for (const member of splitMembers) computedShares.set(member.id, shareAmount);
  }

  const expenseId = randomUUID();
  // Use LLM-extracted expense_date if provided, otherwise today
  const expenseDateStr = extraction.expense_date ?? new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO expenses
      (id, group_id, payer_id, amount, currency, description, category,
       split_type, source_message_id, expense_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    expenseId,
    groupId,
    payerMember.id,
    amount,
    extraction.currency ?? 'INR',
    extraction.description ?? null,
    extraction.category ?? null,
    extraction.split_type ?? 'equal',
    sourceMessageId,
    expenseDateStr
  );

  for (const member of splitMembers) {
    db.prepare(`
      INSERT INTO expense_splits (id, expense_id, member_id, share_amount)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), expenseId, member.id, computedShares.get(member.id) ?? 0);
  }

  return {
    id: expenseId,
    groupId,
    payerId: payerMember.id,
    payerName: payerMember.displayName,
    amount,
    currency: extraction.currency ?? 'INR',
    description: extraction.description,
    category: extraction.category,
    splitType: (extraction.split_type ?? 'equal') as 'equal' | 'exact' | 'percentage',
    expenseDate: new Date(expenseDateStr),
    createdAt: new Date(),
    hasEdits: false,
    splits: splitMembers.map((m) => ({
      memberId: m.id,
      memberName: m.displayName,
      shareAmount: computedShares.get(m.id) ?? 0,
    })),
    sourceMessageId,
  };
}

export function getLastExpense(
  db: Database.Database,
  groupId: string
): { id: string; description: string | null } | null {
  return db.prepare(`
    SELECT id, description FROM expenses
    WHERE group_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(groupId) as { id: string; description: string | null } | null;
}

export function deleteExpense(db: Database.Database, expenseId: string): boolean {
  const result = db.prepare(`
    UPDATE expenses SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(expenseId);
  return result.changes > 0;
}

export function updateExpenseAmount(
  db: Database.Database,
  expenseId: string,
  newAmount: number
): boolean {
  // Get existing splits to recalculate shares
  const splits = db.prepare(`
    SELECT id, member_id FROM expense_splits WHERE expense_id = ?
  `).all(expenseId) as Array<{ id: string; member_id: string }>;

  if (splits.length === 0) return false;

  const newShare = newAmount / splits.length;

  db.prepare(`
    UPDATE expenses SET amount = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newAmount, expenseId);

  for (const split of splits) {
    db.prepare(`
      UPDATE expense_splits SET share_amount = ? WHERE id = ?
    `).run(newShare, split.id);
  }

  return true;
}

interface ExpenseRowFull {
  id: string;
  group_id: string;
  payer_id: string;
  payer_name: string;
  amount: number;
  currency: string;
  description: string | null;
  category: string | null;
  split_type: string;
  source_message_id: string | null;
  expense_date: string | null;
  created_at: string;
}

interface SplitRowFull {
  expense_id: string;
  member_id: string;
  member_name: string;
  share_amount: number;
}

function rowToExpense(db: Database.Database, row: ExpenseRowFull, editedIds: Set<string>): Expense {
  const splits = db.prepare(`
    SELECT es.*, m.display_name AS member_name
    FROM expense_splits es
    JOIN members m ON es.member_id = m.id
    WHERE es.expense_id = ?
  `).all(row.id) as SplitRowFull[];

  return {
    id: row.id,
    groupId: row.group_id,
    payerId: row.payer_id,
    payerName: row.payer_name,
    amount: row.amount,
    currency: row.currency,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    splitType: row.split_type as 'equal' | 'exact' | 'percentage',
    splits: splits.map((s) => ({
      memberId: s.member_id,
      memberName: s.member_name,
      shareAmount: s.share_amount,
    })),
    sourceMessageId: row.source_message_id ?? undefined,
    expenseDate: new Date(row.expense_date ?? row.created_at),
    createdAt: new Date(row.created_at),
    hasEdits: editedIds.has(row.id),
  };
}

/** Returns IDs of expenses that have been edited after creation. */
function getEditedIds(db: Database.Database, groupId: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT expense_id FROM expense_events
    WHERE group_id = ? AND event_type != 'created'
  `).all(groupId) as Array<{ expense_id: string }>;
  return new Set(rows.map((r) => r.expense_id));
}

export function getExpenses(
  db: Database.Database,
  groupId: string,
  limit = 50
): Expense[] {
  const rows = db.prepare(`
    SELECT e.*, m.display_name AS payer_name
    FROM expenses e
    JOIN members m ON e.payer_id = m.id
    WHERE e.group_id = ? AND e.deleted_at IS NULL
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(groupId, limit) as ExpenseRowFull[];

  const editedIds = getEditedIds(db, groupId);
  return rows.map((row) => rowToExpense(db, row, editedIds));
}

export function addSettlement(
  db: Database.Database,
  groupId: string,
  fromMemberId: string,
  toMemberId: string,
  amount: number,
  currency = 'INR'
): void {
  db.prepare(`
    INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), groupId, fromMemberId, toMemberId, amount, currency);
}

// ─── Targeted Lookup ─────────────────────────────────────────────────────────

/**
 * Returns the expense at 1-based position N in the chronological list.
 * Position 1 = oldest, which matches what renderDetails() shows.
 */
export function getExpenseByPosition(
  db: Database.Database,
  groupId: string,
  position: number
): Expense | null {
  const row = db.prepare(`
    SELECT e.*, m.display_name AS payer_name
    FROM expenses e
    JOIN members m ON e.payer_id = m.id
    WHERE e.group_id = ? AND e.deleted_at IS NULL
    ORDER BY e.created_at DESC
    LIMIT 1 OFFSET ?
  `).get(groupId, position - 1) as ExpenseRowFull | undefined;

  if (!row) return null;
  return rowToExpense(db, row, getEditedIds(db, groupId));
}

/**
 * Returns all expenses whose description or category contains the query string.
 */
export function findExpensesByDescription(
  db: Database.Database,
  groupId: string,
  query: string
): Expense[] {
  const pattern = `%${query.toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT e.*, m.display_name AS payer_name
    FROM expenses e
    JOIN members m ON e.payer_id = m.id
    WHERE e.group_id = ? AND e.deleted_at IS NULL
      AND (LOWER(COALESCE(e.description,'')) LIKE ? OR LOWER(COALESCE(e.category,'')) LIKE ?)
    ORDER BY e.created_at DESC
  `).all(groupId, pattern, pattern) as ExpenseRowFull[];

  const editedIds = getEditedIds(db, groupId);
  return rows.map((row) => rowToExpense(db, row, editedIds));
}

/**
 * Returns expenses whose amount matches the given value (exact or within ±1 for float rounding).
 */
export function findExpensesByAmount(
  db: Database.Database,
  groupId: string,
  amount: number
): Expense[] {
  const rows = db.prepare(`
    SELECT e.*, m.display_name AS payer_name
    FROM expenses e
    JOIN members m ON e.payer_id = m.id
    WHERE e.group_id = ? AND e.deleted_at IS NULL
      AND ABS(e.amount - ?) < 0.01
    ORDER BY e.created_at DESC
  `).all(groupId, amount) as ExpenseRowFull[];

  const editedIds = getEditedIds(db, groupId);
  return rows.map((row) => rowToExpense(db, row, editedIds));
}

/**
 * Replaces the split members for an expense.
 * Pass splitAmounts (memberId → amount/percentage) for unequal splits.
 */
export function updateExpenseSplit(
  db: Database.Database,
  expenseId: string,
  splitMembers: Member[],
  splitAmounts?: Record<string, number>,  // memberId → exact amount or percentage
  splitType: 'equal' | 'exact' | 'percentage' = 'equal'
): boolean {
  if (splitMembers.length === 0) return false;

  const expense = db.prepare(
    'SELECT amount FROM expenses WHERE id = ? AND deleted_at IS NULL'
  ).get(expenseId) as { amount: number } | undefined;

  if (!expense) return false;

  db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expenseId);

  for (const member of splitMembers) {
    let shareAmount: number;
    if (splitAmounts && member.id in splitAmounts) {
      shareAmount = splitType === 'percentage'
        ? expense.amount * (splitAmounts[member.id] / 100)
        : splitAmounts[member.id];
    } else {
      shareAmount = expense.amount / splitMembers.length;
    }
    db.prepare(`
      INSERT INTO expense_splits (id, expense_id, member_id, share_amount)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), expenseId, member.id, shareAmount);
  }

  db.prepare(`UPDATE expenses SET updated_at = datetime('now') WHERE id = ?`).run(expenseId);
  return true;
}

/**
 * Changes the payer for an existing expense.
 */
export function updateExpensePayer(
  db: Database.Database,
  expenseId: string,
  newPayerId: string
): boolean {
  const result = db.prepare(`
    UPDATE expenses SET payer_id = ?, updated_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(newPayerId, expenseId);
  return result.changes > 0;
}

/**
 * Removes one person from the split and recalculates equal shares for the rest.
 */
export function removePersonFromSplit(
  db: Database.Database,
  expenseId: string,
  memberId: string
): boolean {
  const expense = db.prepare(
    'SELECT amount FROM expenses WHERE id = ? AND deleted_at IS NULL'
  ).get(expenseId) as { amount: number } | undefined;

  if (!expense) return false;

  db.prepare(
    'DELETE FROM expense_splits WHERE expense_id = ? AND member_id = ?'
  ).run(expenseId, memberId);

  // Recalculate shares for remaining members
  const remaining = db.prepare(
    'SELECT id FROM expense_splits WHERE expense_id = ?'
  ).all(expenseId) as Array<{ id: string }>;

  if (remaining.length === 0) return true; // edge case: no one left

  const newShare = expense.amount / remaining.length;
  for (const row of remaining) {
    db.prepare('UPDATE expense_splits SET share_amount = ? WHERE id = ?').run(newShare, row.id);
  }

  db.prepare(`UPDATE expenses SET updated_at = datetime('now') WHERE id = ?`).run(expenseId);
  return true;
}

/**
 * Adds a new person to the split and recalculates equal shares for everyone.
 * Returns false if the member is already in the split.
 */
export function addPersonToSplit(
  db: Database.Database,
  expenseId: string,
  member: Member
): boolean {
  const expense = db.prepare(
    'SELECT amount FROM expenses WHERE id = ? AND deleted_at IS NULL'
  ).get(expenseId) as { amount: number } | undefined;

  if (!expense) return false;

  const existing = db.prepare(
    'SELECT id FROM expense_splits WHERE expense_id = ? AND member_id = ?'
  ).get(expenseId, member.id);

  if (existing) return false; // already in split

  const existingRows = db.prepare(
    'SELECT id FROM expense_splits WHERE expense_id = ?'
  ).all(expenseId) as Array<{ id: string }>;

  const newCount = existingRows.length + 1;
  const newShare = expense.amount / newCount;

  // Recalculate existing shares
  for (const row of existingRows) {
    db.prepare('UPDATE expense_splits SET share_amount = ? WHERE id = ?').run(newShare, row.id);
  }

  // Insert new member
  db.prepare(`
    INSERT INTO expense_splits (id, expense_id, member_id, share_amount)
    VALUES (?, ?, ?, ?)
  `).run(randomUUID(), expenseId, member.id, newShare);

  db.prepare(`UPDATE expenses SET updated_at = datetime('now') WHERE id = ?`).run(expenseId);
  return true;
}

/**
 * Updates the description of an expense.
 */
export function updateExpenseDescription(
  db: Database.Database,
  expenseId: string,
  description: string
): boolean {
  const result = db.prepare(`
    UPDATE expenses SET description = ?, updated_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(description, expenseId);
  return result.changes > 0;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export function logExpenseEvent(
  db: Database.Database,
  expenseId: string,
  groupId: string,
  actorName: string,
  eventType: ExpenseEventType,
  payload: Record<string, unknown> = {}
): void {
  db.prepare(`
    INSERT INTO expense_events (id, expense_id, group_id, actor_name, event_type, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), expenseId, groupId, actorName, eventType, JSON.stringify(payload));
}

export function getExpenseEvents(
  db: Database.Database,
  expenseId: string
): ExpenseEvent[] {
  const rows = db.prepare(`
    SELECT * FROM expense_events WHERE expense_id = ? ORDER BY created_at ASC
  `).all(expenseId) as Array<{
    id: string; expense_id: string; group_id: string;
    actor_name: string; event_type: string; payload: string; created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    expenseId: r.expense_id,
    groupId: r.group_id,
    actorName: r.actor_name,
    eventType: r.event_type as ExpenseEventType,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: new Date(r.created_at),
  }));
}

export function updateExpenseDate(
  db: Database.Database,
  expenseId: string,
  newDateStr: string  // YYYY-MM-DD
): boolean {
  const result = db.prepare(`
    UPDATE expenses SET expense_date = ?, updated_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(newDateStr, expenseId);
  return result.changes > 0;
}

// ─── Balance Calculation ──────────────────────────────────────────────────────

interface NetBalance {
  [memberId: string]: number; // positive = owed money, negative = owes money
}

export function calculateBalances(
  db: Database.Database,
  groupId: string
): Balance[] {
  // Compute net balance per person (per currency)
  // net[currency][memberId] = amount they are NET owed (positive) or NET owe (negative)
  const net: Record<string, Record<string, number>> = {};

  const expenses = getExpenses(db, groupId);

  for (const expense of expenses) {
    const { currency, payerId, splits } = expense;
    if (!net[currency]) net[currency] = {};

    // Payer is owed the full amount
    net[currency][payerId] = (net[currency][payerId] ?? 0) + expense.amount;

    // Each person in the split owes their share
    for (const split of splits) {
      net[currency][split.memberId] =
        (net[currency][split.memberId] ?? 0) - split.shareAmount;
    }
  }

  // Apply settlements
  const settlements = db.prepare(`
    SELECT * FROM settlements WHERE group_id = ?
  `).all(groupId) as Array<{
    from_member_id: string;
    to_member_id: string;
    amount: number;
    currency: string;
  }>;

  for (const s of settlements) {
    if (!net[s.currency]) net[s.currency] = {};
    net[s.currency][s.from_member_id] =
      (net[s.currency][s.from_member_id] ?? 0) + s.amount;
    net[s.currency][s.to_member_id] =
      (net[s.currency][s.to_member_id] ?? 0) - s.amount;
  }

  // Get member names
  const memberMap = new Map<string, string>();
  const members = db.prepare(
    'SELECT id, display_name FROM members WHERE group_id = ?'
  ).all(groupId) as Array<{ id: string; display_name: string }>;
  for (const m of members) memberMap.set(m.id, m.display_name);

  // Build pairwise balance list
  const balances: Balance[] = [];

  for (const [currency, netByCurrency] of Object.entries(net)) {
    for (const [debtorId, netAmount] of Object.entries(netByCurrency)) {
      if (netAmount >= -0.01) continue; // skip if they are owed money or neutral

      for (const [creditorId, creditorNet] of Object.entries(netByCurrency)) {
        if (creditorId === debtorId) continue;
        if (creditorNet <= 0.01) continue; // creditor must be owed money

        const owed = Math.min(Math.abs(netAmount), creditorNet);
        if (owed < 0.01) continue;

        balances.push({
          fromMemberId: debtorId,
          fromMemberName: memberMap.get(debtorId) ?? debtorId,
          toMemberId: creditorId,
          toMemberName: memberMap.get(creditorId) ?? creditorId,
          amount: Math.round(owed * 100) / 100,
          currency,
        });
      }
    }
  }

  return balances;
}

// ─── Debt Simplification ──────────────────────────────────────────────────────

export function simplifyDebts(balances: Balance[]): Balance[] {
  // Group by currency
  const byCurrency = new Map<string, Balance[]>();
  for (const b of balances) {
    const list = byCurrency.get(b.currency) ?? [];
    list.push(b);
    byCurrency.set(b.currency, list);
  }

  const simplified: Balance[] = [];

  for (const [currency, currBalances] of byCurrency) {
    // Compute net per person
    const net = new Map<string, { name: string; amount: number }>();

    for (const b of currBalances) {
      const debtor = net.get(b.fromMemberId) ?? { name: b.fromMemberName, amount: 0 };
      debtor.amount -= b.amount;
      net.set(b.fromMemberId, debtor);

      const creditor = net.get(b.toMemberId) ?? { name: b.toMemberName, amount: 0 };
      creditor.amount += b.amount;
      net.set(b.toMemberId, creditor);
    }

    const debtors = [...net.entries()]
      .filter(([, v]) => v.amount < -0.01)
      .sort(([, a], [, b]) => a.amount - b.amount);

    const creditors = [...net.entries()]
      .filter(([, v]) => v.amount > 0.01)
      .sort(([, a], [, b]) => b.amount - a.amount);

    let di = 0;
    let ci = 0;

    while (di < debtors.length && ci < creditors.length) {
      const [debtorId, debtor] = debtors[di];
      const [creditorId, creditor] = creditors[ci];

      const amount = Math.min(Math.abs(debtor.amount), creditor.amount);

      simplified.push({
        fromMemberId: debtorId,
        fromMemberName: debtor.name,
        toMemberId: creditorId,
        toMemberName: creditor.name,
        amount: Math.round(amount * 100) / 100,
        currency,
      });

      debtor.amount += amount;
      creditor.amount -= amount;

      if (Math.abs(debtor.amount) < 0.01) di++;
      if (creditor.amount < 0.01) ci++;
    }
  }

  return simplified;
}
