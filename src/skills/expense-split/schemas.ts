import { z } from 'zod';

// ─── LLM Output Schema ────────────────────────────────────────────────────────

export const ExpenseExtractionSchema = z.object({
  is_expense: z.boolean().describe('Whether this message describes an expense'),
  amount: z.number().positive().optional().describe('The expense amount'),
  currency: z.string().default('INR').describe('Currency code: INR, USD, EUR, etc.'),
  payer: z.string().optional().describe('Name of the person who paid'),
  split_among: z
    .array(z.string())
    .optional()
    .describe('Names of people who share this expense (including the payer)'),
  split_type: z
    .enum(['equal', 'exact', 'percentage'])
    .default('equal')
    .describe('How to split: equal shares, exact amounts, or percentages'),
  category: z
    .enum([
      'food', 'transport', 'accommodation', 'drinks', 'entertainment',
      'shopping', 'fuel', 'utilities', 'medical', 'other',
    ])
    .optional()
    .describe('Category of the expense'),
  description: z.string().optional().describe('Brief description of what was purchased'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence that this is a real expense (0-1)'),
  needs_clarification: z
    .boolean()
    .default(false)
    .describe('Whether clarification is needed before recording'),
  clarification_question: z
    .string()
    .optional()
    .describe('The question to ask if needs_clarification is true'),
});

export type ExpenseExtraction = z.infer<typeof ExpenseExtractionSchema>;

export const CorrectionRequestSchema = z.object({
  is_correction: z.boolean().describe('Whether this message is correcting a previous expense'),
  correction_type: z
    .enum(['update_amount', 'remove_last', 'change_split', 'change_payer', 'add_person', 'remove_person'])
    .optional(),
  expense_position: z.number().int().positive().optional().describe('The #N position of the target expense (e.g. 2 from "edit #2")'),
  expense_description: z.string().optional().describe('Description keyword to identify which expense to correct (e.g. "cab", "dinner")'),
  new_amount: z.number().positive().optional(),
  new_split_among: z.array(z.string()).optional().describe('New list of people who should share the expense'),
  new_payer: z.string().optional().describe('New name of the person who paid'),
  remove_person: z.string().optional().describe('Name of the person to remove from the expense split'),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type CorrectionRequest = z.infer<typeof CorrectionRequestSchema>;

// ─── Database Row Schemas ─────────────────────────────────────────────────────

export const ExpenseRowSchema = z.object({
  id: z.string(),
  group_id: z.string(),
  payer_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  split_type: z.string(),
  source_message_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export const ExpenseSplitRowSchema = z.object({
  id: z.string(),
  expense_id: z.string(),
  member_id: z.string(),
  share_amount: z.number(),
});

export const SettlementRowSchema = z.object({
  id: z.string(),
  group_id: z.string(),
  from_member_id: z.string(),
  to_member_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  created_at: z.string(),
});

export type ExpenseRow = z.infer<typeof ExpenseRowSchema>;
export type ExpenseSplitRow = z.infer<typeof ExpenseSplitRowSchema>;
export type SettlementRow = z.infer<typeof SettlementRowSchema>;

// ─── Domain Types ─────────────────────────────────────────────────────────────

export interface Expense {
  id: string;
  groupId: string;
  payerId: string;
  payerName: string;
  amount: number;
  currency: string;
  description?: string;
  category?: string;
  splitType: 'equal' | 'exact' | 'percentage';
  splits: Array<{ memberId: string; memberName: string; shareAmount: number }>;
  sourceMessageId?: string;
  createdAt: Date;
}

export interface Balance {
  fromMemberId: string;
  fromMemberName: string;
  toMemberId: string;
  toMemberName: string;
  amount: number;
  currency: string;
}

export interface MemberAlias {
  groupId: string;
  memberId: string;
  alias: string;
}
