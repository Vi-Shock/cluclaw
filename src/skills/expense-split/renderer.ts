import type { Balance, Expense } from './schemas.js';

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
    const date = fmtDate(e.createdAt);
    return `#${i + 1}. ${e.payerName} paid *${fmt(e.amount, e.currency)}* for ${desc} • ${date}\n   Split: ${splitNames}`;
  });

  const hint = `\n_edit #N split/amount/payer — remove #N_`;
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
• \`edit #N amount 350\` — Correct the amount of expense #N
• \`edit #N payer Supriya\` — Change who paid for expense #N
• \`edit #N remove Priya\` — Remove Priya from expense #N split
• \`settle <name> <amount>\` — Record a payment
• \`help\` — Show this message

*Just chat naturally — I'll handle the rest!*
Examples:
• "Paid ₹2400 for the Airbnb"
• "Ravi and I split a cab — ₹600"
• "Actually split the cab between me and Supriya"`;
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

export function renderWelcome(botName: string): string {
  return `👋 Hey! I'm *${botName}*, your group expense tracker.

Just chat normally — I'll silently track who paid what.

Type \`splits\` anytime to see who owes what, or \`help\` for all commands. 🧾`;
}
