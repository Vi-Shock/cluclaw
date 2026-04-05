import * as XLSX from 'xlsx';
import type { Expense, Balance } from '../skills/expense-split/schemas.js';

/**
 * Generates an Excel workbook with two sheets:
 *   1. "Expenses" — all active expenses with splits
 *   2. "Who Owes Whom" — simplified debt summary
 *
 * Returns a Node.js Buffer ready to be sent as a file attachment.
 */
export function generateExpenseExcel(
  expenses: Expense[],
  debts: Balance[]
): Buffer {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Expenses ──────────────────────────────────────────────────────
  const expenseRows = expenses.map((e, i) => ({
    '#': i + 1,
    Date: e.expenseDate.toISOString().split('T')[0],
    Description: e.description ?? e.category ?? '',
    Payer: e.payerName,
    Amount: e.amount,
    Currency: e.currency,
    'Split Among': e.splits.map((s) => s.memberName).join(', '),
    'Split Type': e.splitType,
    'Recorded On': e.createdAt.toISOString().split('T')[0],
  }));

  const ws1 = XLSX.utils.json_to_sheet(expenseRows);

  // Set column widths for readability
  ws1['!cols'] = [
    { wch: 4 },   // #
    { wch: 12 },  // Date
    { wch: 22 },  // Description
    { wch: 14 },  // Payer
    { wch: 10 },  // Amount
    { wch: 8 },   // Currency
    { wch: 30 },  // Split Among
    { wch: 10 },  // Split Type
    { wch: 12 },  // Recorded On
  ];

  XLSX.utils.book_append_sheet(wb, ws1, 'Expenses');

  // ── Sheet 2: Who Owes Whom ─────────────────────────────────────────────────
  const debtRows = debts.length > 0
    ? debts.map((d) => ({
        From: d.fromMemberName,
        To: d.toMemberName,
        Amount: d.amount,
        Currency: d.currency,
      }))
    : [{ From: 'Everyone is settled up!', To: '', Amount: 0, Currency: '' }];

  const ws2 = XLSX.utils.json_to_sheet(debtRows);
  ws2['!cols'] = [
    { wch: 16 },  // From
    { wch: 16 },  // To
    { wch: 10 },  // Amount
    { wch: 8 },   // Currency
  ];

  XLSX.utils.book_append_sheet(wb, ws2, 'Who Owes Whom');

  const arrayBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return Buffer.from(arrayBuffer);
}
