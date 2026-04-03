import type { Balance, Expense, ExpenseEvent } from './schemas.js';

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

function fmt(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? currency + ' ';
  return `${sym}${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// ─── Splits Summary ───────────────────────────────────────────────────────────

export function renderSplitsSummary(
  balances: Balance[],
  groupName?: string
): string {
  if (balances.length === 0) {
    return '✅ Everyone is settled up! No outstanding balances.';
  }

  const header = groupName
    ? `💰 *${groupName} — Settlements*`
    : '💰 *Settlements*';

  const lines = balances.map(
    (b) => `→ ${b.fromMemberName} owes ${b.toMemberName} *${fmt(b.amount, b.currency)}*`
  );

  return `${header}\n\n${lines.join('\n')}\n\nType *details* to see all expenses.`;
}

// ─── Detailed Expense List ────────────────────────────────────────────────────

function fmtDate(date: Date): string {
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  // Include year only if different from current year
  return year !== now.getFullYear() ? `${day} ${month} ${year}` : `${day} ${month}`;
}

export function renderDetails(expenses: Expense[]): string {
  if (expenses.length === 0) {
    return '📋 No expenses recorded yet.';
  }

  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const currency = expenses[0].currency;

  const lines = expenses.map((e, i) => {
    const desc = e.description ?? e.category ?? 'expense';
    const splitNames = e.splits.map((s) => s.memberName).join(', ');
    const expDate = fmtDate(e.expenseDate);
    const editedFlag = e.hasEdits ? ' ✏️' : '';

    // Show "recorded X" suffix only when the recording date differs from expense date
    const expDateStr = e.expenseDate.toDateString();
    const createdDateStr = e.createdAt.toDateString();
    const recordedSuffix = expDateStr !== createdDateStr
      ? ` _(recorded ${fmtDate(e.createdAt)})_`
      : '';

    return `#${i + 1}. ${e.payerName} paid *${fmt(e.amount, e.currency)}* for ${desc} • ${expDate}${editedFlag}${recordedSuffix}\n   Split: ${splitNames}`;
  });

  const hint = `\n_edit #N split/amount/payer/date — remove #N — history #N_`;
  return `📋 *All Expenses* (${expenses.length} total)\n\n${lines.join('\n\n')}\n\n*Total: ${fmt(total, currency)}*${hint}`;
}

// ─── Expense Confirmation ─────────────────────────────────────────────────────

export function renderExpenseConfirmation(
  payerName: string,
  amount: number,
  currency: string,
  description: string | undefined,
  splitNames: string[],
  silent = true
): string | null {
  if (silent) return null; // stay quiet for confident expenses

  const desc = description ?? 'expense';
  const splitStr =
    splitNames.length <= 3
      ? splitNames.join(' & ')
      : `${splitNames.length} people`;

  return `✅ Got it — ${payerName} paid *${fmt(amount, currency)}* for ${desc}, split among ${splitStr}.`;
}

// ─── Clarification ────────────────────────────────────────────────────────────

export function renderClarificationQuestion(question: string): string {
  return `🤔 ${question}`;
}

// ─── Correction Confirmation ──────────────────────────────────────────────────

export function renderCorrectionConfirmation(description: string): string {
  return `✅ Updated: ${description}`;
}

export function renderDeleteConfirmation(description: string | null): string {
  return `🗑️ Removed: ${description ?? 'last expense'}`;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export function renderHelp(botName: string): string {
  return `👋 *${botName} — Expense Tracker*

I silently track expenses from your group conversation.

*Commands:*
• \`splits\` — Show who owes what (simplified)
• \`details\` — List all recorded expenses with IDs
• \`remove #N\` — Delete expense #N
• \`remove last\` — Delete the most recent expense
• \`edit #N split Ravi, Priya\` — Change who shares expense #N
• \`edit #N split Ravi:200, Priya:150\` — Unequal exact split
• \`edit #N split Ravi:60%, Priya:40%\` — Percentage split
• \`edit #N add Ravi\` — Add Ravi to expense #N split
• \`edit #N amount 350\` — Correct the amount of expense #N
• \`edit #N payer Supriya\` — Change who paid for expense #N
• \`edit #N remove Priya\` — Remove Priya from expense #N split
• \`edit #N date 1 Apr\` — Correct when the expense actually happened
• \`edit #N description Dinner at Martin's\` — Rename the expense
• \`history #N\` — See full change history for expense #N
• \`settle <name> <amount>\` — Record a payment
• \`help\` — Show this message

*Just chat naturally — I'll handle the rest!*
Examples:
• "Paid ₹2400 for the Airbnb"
• "Ravi and I split a cab — ₹600"
• "Actually split the cab between me and Supriya"`;
}

// ─── Rich Edit Confirmations ─────────────────────────────────────────────────

export function renderSplitChanged(
  desc: string, position: number, actorName: string,
  before: string[], after: string[], amount: number, currency: string
): string {
  const shareAfter = after.length > 0 ? fmt(amount / after.length, currency) : '—';
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\nSplit changed:\n  Before: ${before.join(', ')}\n  After: ${after.join(', ')} (${shareAfter} each)`;
}

export function renderAmountChanged(
  desc: string, position: number, actorName: string,
  oldAmount: number, newAmount: number, currency: string
): string {
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\nAmount: ${fmt(oldAmount, currency)} → *${fmt(newAmount, currency)}*`;
}

export function renderPayerChanged(
  desc: string, position: number, actorName: string,
  oldPayer: string, newPayer: string
): string {
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\nPayer: ${oldPayer} → *${newPayer}*`;
}

export function renderPersonRemoved(
  desc: string, position: number, actorName: string,
  removedName: string, before: string[], after: string[], amount: number, currency: string
): string {
  const shareAfter = after.length > 0 ? fmt(amount / after.length, currency) : '—';
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\n${removedName} removed from split\n  Before: ${before.join(', ')}\n  After: ${after.length > 0 ? `${after.join(', ')} (${shareAfter} each)` : 'nobody'}`;
}

export function renderDateChanged(
  desc: string, position: number, actorName: string,
  oldDate: Date, newDate: Date
): string {
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\nExpense date: ${fmtDate(oldDate)} → *${fmtDate(newDate)}*`;
}

export function renderPersonAdded(
  desc: string, position: number, actorName: string,
  addedName: string, before: string[], after: string[], amount: number, currency: string
): string {
  const shareAfter = after.length > 0 ? fmt(amount / after.length, currency) : '—';
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\n${addedName} added to split\n  Before: ${before.join(', ')}\n  After: ${after.join(', ')} (${shareAfter} each)`;
}

export function renderDescriptionChanged(
  desc: string, position: number, actorName: string,
  oldDesc: string, newDesc: string
): string {
  return `✏️ *${actorName}* updated expense #${position} — ${desc}\n\nDescription: "${oldDesc}" → *"${newDesc}"*`;
}

// ─── Expense History ──────────────────────────────────────────────────────────

export function renderExpenseHistory(
  expense: Expense,
  position: number,
  events: ExpenseEvent[]
): string {
  if (events.length === 0) {
    return `📜 No history found for expense #${position}.`;
  }

  const desc = expense.description ?? expense.category ?? 'expense';
  const header = `📜 *History — #${position} ${desc}* (${fmt(expense.amount, expense.currency)})`;

  const dateLine = expense.expenseDate.toDateString() !== expense.createdAt.toDateString()
    ? `Expense date: ${fmtDate(expense.expenseDate)} • Recorded: ${fmtDate(expense.createdAt)}`
    : `Date: ${fmtDate(expense.expenseDate)}`;

  const lines = events.map((ev) => {
    const time = ev.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    const dateStr = fmtDate(ev.createdAt);
    const p = ev.payload;

    switch (ev.eventType) {
      case 'created':
        return `✅ *Created* by ${ev.actorName} • ${dateStr} ${time}\n   ${p['payer'] ?? ''} paid ${p['amount'] != null ? fmt(p['amount'] as number, p['currency'] as string ?? expense.currency) : ''}\n   Split: ${(p['split'] as string[] | undefined)?.join(', ') ?? ''}`;
      case 'amount_updated':
        return `✏️ *Amount* changed by ${ev.actorName} • ${dateStr} ${time}\n   ${fmt(p['before'] as number, expense.currency)} → ${fmt(p['after'] as number, expense.currency)}`;
      case 'split_changed':
        return `✏️ *Split* changed by ${ev.actorName} • ${dateStr} ${time}\n   ${(p['before'] as string[]).join(', ')} → ${(p['after'] as string[]).join(', ')}`;
      case 'payer_changed':
        return `✏️ *Payer* changed by ${ev.actorName} • ${dateStr} ${time}\n   ${p['before']} → ${p['after']}`;
      case 'person_removed':
        return `✏️ *${p['removed']}* removed from split by ${ev.actorName} • ${dateStr} ${time}`;
      case 'person_added':
        return `✏️ *${p['added']}* added to split by ${ev.actorName} • ${dateStr} ${time}`;
      case 'description_updated':
        return `✏️ *Description* changed by ${ev.actorName} • ${dateStr} ${time}\n   "${p['before']}" → "${p['after']}"`;
      case 'date_updated':
        return `✏️ *Date* changed by ${ev.actorName} • ${dateStr} ${time}\n   ${p['before']} → ${p['after']}`;
      case 'deleted':
        return `🗑️ *Deleted* by ${ev.actorName} • ${dateStr} ${time}`;
      default:
        return `• ${ev.eventType} by ${ev.actorName} • ${dateStr} ${time}`;
    }
  });

  return `${header}\n${dateLine}\n\n${lines.join('\n\n')}`;
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

export function renderWelcome(botName: string): string {
  return `👋 Hey! I'm *${botName}*, your group expense tracker.

Just chat normally — I'll silently track who paid what.

Type \`splits\` anytime to see who owes what, or \`help\` for all commands. 🧾`;
}
