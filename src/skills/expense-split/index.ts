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
} from './ledger.js';
import {
  renderSplitsSummary,
  renderDetails,
  renderClarificationQuestion,
  renderCorrectionConfirmation,
  renderDeleteConfirmation,
  renderHelp,
  renderWelcome,
} from './renderer.js';
import { getGroupDb } from '../../memory/store.js';

const SKILL_NAME = 'expense-split';

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
            if (correction.new_amount) {
              const last = getLastExpense(db, message.groupId);
              if (last) {
                updateExpenseAmount(db, last.id, correction.new_amount);
                return {
                  text: renderCorrectionConfirmation(
                    `${last.description ?? 'expense'} is now ${correction.new_amount}`
                  ),
                };
              }
            }
            break;
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
