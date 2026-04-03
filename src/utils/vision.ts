import { z } from 'zod';
import { extractStructured } from '../core/llm.js';
import { logger } from '../core/logger.js';

const ReceiptSchema = z.object({
  total: z.number().positive().optional(),
  currency: z.string().default('INR'),
  merchant: z.string().optional(),
  items: z
    .array(
      z.object({
        name: z.string(),
        amount: z.number(),
      })
    )
    .optional(),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type ReceiptData = z.infer<typeof ReceiptSchema>;

/**
 * Extract structured data from an image (receipt, bill, etc.)
 */
export async function extractFromImage(
  buffer: Buffer,
  mimeType: string,
  prompt?: string
): Promise<ReceiptData | null> {
  const imageBase64 = buffer.toString('base64');

  const systemPrompt = `You are a receipt parser. Extract the total amount, currency, merchant name, and line items from this image.
If the image is not a receipt or bill, return confidence=0.`;

  const defaultPrompt =
    prompt ??
    'Extract the total amount, itemized list, and merchant name from this receipt or bill.';

  try {
    const result = await extractStructured(defaultPrompt, ReceiptSchema, {
      vision: true,
      imageBase64,
      systemPrompt,
    });

    if (result.confidence < 0.4) {
      logger.debug('Vision: low confidence receipt extraction');
      return null;
    }

    logger.debug(`Vision extracted receipt: ${result.total} ${result.currency} at ${result.merchant}`);
    return result;
  } catch (err) {
    logger.error('Vision extraction failed:', err);
    return null;
  }
}

/**
 * Convert receipt data to a text description suitable for the expense parser
 */
export function receiptToText(receipt: ReceiptData, senderName: string): string {
  const parts: string[] = [];

  if (receipt.merchant) {
    parts.push(`Bill from ${receipt.merchant}`);
  }

  if (receipt.total) {
    const sym = receipt.currency === 'INR' ? '₹' : receipt.currency + ' ';
    parts.push(`Total: ${sym}${receipt.total}`);
  }

  if (receipt.items?.length) {
    const itemStr = receipt.items
      .map((i) => `${i.name}: ${i.amount}`)
      .join(', ');
    parts.push(`Items: ${itemStr}`);
  }

  return parts.length > 0 ? parts.join('. ') : `Receipt paid by ${senderName}`;
}
