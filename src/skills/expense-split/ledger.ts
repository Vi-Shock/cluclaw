import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Member } from '../../types.js';
import type { ExpenseExtraction, Expense, Balance } from './schemas.js';
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
  const shareAmount = amount / splitMembers.length;

  const expenseId = randomUUID();

  db.prepare(`
    INSERT INTO expenses
      (id, group_id, payer_id, amount, currency, description, category,
       split_type, source_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    expenseId,
    groupId,
    payerMember.id,
    amount,
    extraction.currency ?? 'INR',
    extraction.description ?? null,
    extraction.category ?? null,
    extraction.split_type ?? 'equal',
    sourceMessageId
  );

  for (const member of splitMembers) {
    db.prepare(`
      INSERT INTO expense_splits (id, expense_id, member_id, share_amount)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), expenseId, member.id, shareAmount);
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
    splits: splitMembers.map((m) => ({
      memberId: m.id,
      memberName: m.displayName,
      shareAmount,
    })),
    sourceMessageId,
    createdAt: new Date(),
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
  created_at: string;
}

interface SplitRowFull {
  expense_id: string;
  member_id: string;
  member_name: string;
  share_amount: number;
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

  return rows.map((row) => {
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
      createdAt: new Date(row.created_at),
    };
  });
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
