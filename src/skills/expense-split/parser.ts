import type { GroupMessage, Member, GroupContext } from '../../types.js';
import {
  ExpenseExtractionSchema,
  CorrectionRequestSchema,
  type ExpenseExtraction,
  type CorrectionRequest,
} from './schemas.js';
import { logger } from '../../core/logger.js';

// ─── Fast Filter ──────────────────────────────────────────────────────────────

// Matches currency signals + numeric amounts
const EXPENSE_REGEX =
  /(?:₹|rs\.?|rupees?|\$|€|£|¥|usd|inr|eur|gbp|jpy)|(?:\b(?:paid|pay|spent|cost|bought|got|covered|split|owe|owes|diye|kharcha|liya)\b)/i;

const NUMBER_REGEX = /\d+/;

export function shouldParseAsExpense(text: string): boolean {
  return EXPENSE_REGEX.test(text) && NUMBER_REGEX.test(text);
}

// Correction signals
const CORRECTION_REGEX =
  /\b(?:actually|wait|no it was|change|update|remove last|undo|delete|wasn'?t there|wasn'?t at|modify|edit|rename|describe|split .{1,30} between|add .{1,20} to|remove .{1,20} from|#\d+)\b/i;

export function looksLikeCorrection(text: string): boolean {
  return CORRECTION_REGEX.test(text);
}

// ─── Context Builder ──────────────────────────────────────────────────────────

function buildExpensePrompt(
  message: GroupMessage,
  members: Member[],
  recentMessages: GroupMessage[],
  skillMd?: string
): { systemPrompt: string; prompt: string } {
  const memberNames = members.map((m) => m.displayName).join(', ');

  // Load few-shot examples from SKILL.md conditionally
  let examples = '';
  if (skillMd) {
    const match = /## Few-Shot Examples([\s\S]*?)## Correction Prompt/i.exec(skillMd);
    if (match) {
      examples = `\n\n## Examples\n${match[1].trim()}`;
    }
  }

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const systemPrompt = `You are an expense parser for a group chat. Extract expense information from messages.

Group members: ${memberNames}
Default currency: INR (Indian Rupees)
Today's date: ${today} (use this to resolve relative dates like "yesterday", "last Tuesday", "last night")
The group speaks English, Hindi, and Hinglish.

Rules:
- Payer is the message sender unless someone else is explicitly named as payer
- If split_among is not specified, use ["all"] meaning everyone in the group
- "all" in split_among means split equally among all group members
- Confidence < 0.7: set needs_clarification=true and provide clarification_question
- False positives: complaints ("too expensive"), hypotheticals ("we need to pay"), expressions ("I have 500 reasons")
- Return is_expense=false for non-expense messages
- For unequal splits: set split_type=exact and populate split_amounts with name→amount. E.g. "Ravi owes 200, Priya owes 150" → {Ravi:200, Priya:150}
- For percentage splits: set split_type=percentage and split_amounts with name→percentage (0-100). E.g. "split 60/40" → {sender:60, other:40}${examples}`;

  // Include recent context messages for multi-message expense detection
  const contextMessages = recentMessages
    .slice(-5)
    .map((m) => `${m.sender.name}: ${m.content.text ?? '[media]'}`)
    .join('\n');

  const prompt = `Recent conversation context:
${contextMessages}

Current message from ${message.sender.name}: "${message.content.text ?? '[media message]'}"

Extract expense data if this is an expense. Return is_expense=false if it is not.`;

  return { systemPrompt, prompt };
}

// ─── Main Parsers ─────────────────────────────────────────────────────────────

export async function parseExpense(
  message: GroupMessage,
  members: Member[],
  context: GroupContext,
  skillMd?: string
): Promise<ExpenseExtraction | null> {
  const text = message.content.text ?? message.content.media?.caption ?? '';

  if (!text && !message.content.media) return null;
  if (text && !shouldParseAsExpense(text)) return null;

  const { systemPrompt, prompt } = buildExpensePrompt(
    message,
    members,
    context.history,
    skillMd
  );

  try {
    const result = await context.llm.extractStructured(
      prompt,
      ExpenseExtractionSchema,
      {
        systemPrompt,
        vision: message.content.media?.type === 'image',
        imageBase64: message.content.media?.buffer?.toString('base64'),
      }
    );

    if (!result.is_expense || result.confidence < 0.4) return null;

    // Resolve "all" in split_among to actual member names
    if (result.split_among?.includes('all') || !result.split_among?.length) {
      result.split_among = members.map((m) => m.displayName);
    }

    // Ensure payer is set to sender if missing
    if (!result.payer) {
      result.payer = message.sender.name;
    }

    logger.debug(
      `Parsed expense: ${result.amount} ${result.currency} by ${result.payer} (confidence: ${result.confidence})`
    );

    return result;
  } catch (err) {
    logger.error('Expense parsing failed:', err);
    return null;
  }
}

export async function parseCorrection(
  message: GroupMessage,
  context: GroupContext
): Promise<CorrectionRequest | null> {
  const text = message.content.text ?? '';
  if (!text) return null;

  const systemPrompt = `You are analyzing a group chat message to detect if it corrects a previously recorded expense.

Correction signals: "actually", "wait", "no it was", "change", "update", "remove last", "undo", "delete", "wasn't there", "wasn't at", "split X between", "add X to", "remove X from", "rename", "#N" references.

For corrections, extract:
- correction_type: update_amount | remove_last | change_split | change_payer | add_person | remove_person | change_description
- expense_position: numeric position (#N) if the user references a specific expense number
- expense_description: keyword identifying WHICH expense (e.g. "cab", "dinner", "hotel") — do NOT set this to the full sentence
- new_amount: corrected amount for update_amount
- new_split_among: new list of people for change_split (include the payer if they share it)
- new_split_amounts: for unequal change_split — maps member name → exact amount or percentage (0-100). E.g. {Ravi:200, Priya:150} or {Ravi:60, Priya:40}
- new_payer: new payer name for change_payer
- remove_person: name of person to remove for remove_person
- add_person: name of person to add to the split for add_person
- new_description: new name/description for change_description

Examples:
- "Add Supriya to split for #3" → correction_type=add_person, add_person="Supriya", expense_position=3
- "add Ravi to the cab" → correction_type=add_person, add_person="Ravi", expense_description="cab"
- "Priya should also be in the dinner split" → correction_type=add_person, add_person="Priya", expense_description="dinner"
- "remove Ravi from #2" → correction_type=remove_person, remove_person="Ravi", expense_position=2
- "Ravi owes 200, Priya owes 150" → correction_type=change_split, new_split_amounts={Ravi:200, Priya:150}
- "split 60/40 between me and Ravi" → correction_type=change_split, new_split_amounts={sender:60, Ravi:40}
- "rename the hotel to Airbnb" → correction_type=change_description, new_description="Airbnb", expense_description="hotel"

IMPORTANT: Use add_person (not change_split) when someone is being ADDED to an existing split.
Use change_split only when the entire split list is being replaced.

Return is_correction=false if the message is NOT a correction.`;

  const recentExpenses = context.history
    .slice(-10)
    .filter((m) => m.content.text)
    .map((m) => `${m.sender.name}: ${m.content.text}`)
    .join('\n');

  const prompt = `Recent messages:
${recentExpenses}

Current message from ${message.sender.name}: "${text}"

Is this correcting a previous expense?`;

  try {
    const result = await context.llm.extractStructured(
      prompt,
      CorrectionRequestSchema,
      { systemPrompt }
    );

    if (!result.is_correction || result.confidence < 0.6) return null;
    return result;
  } catch (err) {
    logger.error('Correction parsing failed:', err);
    return null;
  }
}

// ─── Name Resolution ──────────────────────────────────────────────────────────

export function resolveMemberName(
  name: string,
  members: Member[]
): Member | undefined {
  const lower = name.toLowerCase().trim();

  // Exact match on display name
  const exact = members.find((m) => m.displayName.toLowerCase() === lower);
  if (exact) return exact;

  // Alias match
  const aliasMatch = members.find((m) =>
    m.aliases.some((a) => a.toLowerCase() === lower)
  );
  if (aliasMatch) return aliasMatch;

  // Partial match (starts with)
  const partial = members.find((m) =>
    m.displayName.toLowerCase().startsWith(lower) ||
    lower.startsWith(m.displayName.toLowerCase().split(' ')[0])
  );

  return partial;
}
