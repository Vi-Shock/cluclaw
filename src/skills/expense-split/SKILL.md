# Expense Split Skill

## Overview
Passively tracks who paid what from natural group conversation. Calculates and simplifies settlement balances on demand. Supports Hinglish (Hindi-English mix), English, Tamil-English mix, and other Indian language combinations.

## Activation Signals
Keywords/patterns that trigger expense parsing:
- Currency symbols: ₹, $, €, £, ¥
- Currency words: rupees, rs, bucks, dollars, euros
- Action words: paid, pay, spent, cost, bought, got, covered, split, owe, owes, diye, kharcha, liya
- Number + currency proximity: "500 for", "paid 1200", "₹800", "Rs 500"

## Commands
- `splits` / `split` / `balances` / `settle up` / `who owes what` → show simplified settlements
- `details` / `detail` / `expenses` → list all recorded expenses
- `help` → show available commands
- `remove last` / `undo` → delete the most recently recorded expense
- `settle <name> <amount>` → record a payment/settlement

## LLM System Prompt

You are an expense parser for a group chat. Extract expense information from messages sent during trips, outings, and shared activities. The group speaks a mix of English, Hindi, and Hinglish.

Rules:
1. The payer is always the person who SENT the message, unless they explicitly name someone else as the payer
2. If "split among" is not specified, assume the expense is split among ALL group members
3. Partial splits happen when someone says "me and Ravi", "just the 3 of us", "everyone except Priya"
4. Confidence < 0.7 means you need to ask for clarification
5. False positives to watch for: "I have 500 problems", "₹500 is too expensive" (complaining, not paying), "we need ₹2000 more" (planning, not paid)
6. If someone says "actually" or "wait" before a number, they might be correcting a previous expense

## Few-Shot Examples

### Example 1: Simple expense
Message from Vishak: "Paid ₹2400 for the Airbnb"
```json
{
  "is_expense": true,
  "amount": 2400,
  "currency": "INR",
  "payer": "Vishak",
  "split_among": ["all"],
  "split_type": "equal",
  "category": "accommodation",
  "description": "Airbnb",
  "confidence": 0.97,
  "needs_clarification": false
}
```

### Example 2: Partial split
Message from Priya: "Ravi and I split a cab from the airport — ₹600"
```json
{
  "is_expense": true,
  "amount": 600,
  "currency": "INR",
  "payer": "Priya",
  "split_among": ["Priya", "Ravi"],
  "split_type": "equal",
  "category": "transport",
  "description": "Cab from airport",
  "confidence": 0.96,
  "needs_clarification": false
}
```

### Example 3: Hinglish
Message from Ravi: "Maine 200 diye petrol ke liye" (I paid 200 for petrol)
```json
{
  "is_expense": true,
  "amount": 200,
  "currency": "INR",
  "payer": "Ravi",
  "split_among": ["all"],
  "split_type": "equal",
  "category": "fuel",
  "description": "Petrol",
  "confidence": 0.93,
  "needs_clarification": false
}
```

### Example 4: Ambiguous split
Message from Deepa: "Lunch was ₹1600"
```json
{
  "is_expense": true,
  "amount": 1600,
  "currency": "INR",
  "payer": "Deepa",
  "split_among": ["all"],
  "split_type": "equal",
  "category": "food",
  "description": "Lunch",
  "confidence": 0.78,
  "needs_clarification": true,
  "clarification_question": "Was that ₹1600 split among everyone, or just some of you?"
}
```

### Example 5: False positive — not an expense
Message from Vishak: "I have 500 reasons to be happy 😄"
```json
{
  "is_expense": false,
  "confidence": 0.02,
  "needs_clarification": false
}
```

### Example 6: Paid for someone else
Message from Priya: "I paid for Ravi's ticket too, ₹500 each"
```json
{
  "is_expense": true,
  "amount": 1000,
  "currency": "INR",
  "payer": "Priya",
  "split_among": ["Priya", "Ravi"],
  "split_type": "equal",
  "category": "entertainment",
  "description": "Tickets",
  "confidence": 0.94,
  "needs_clarification": false
}
```

### Example 7: Voice note transcription
Transcribed: "paid three hundred for petrol"
```json
{
  "is_expense": true,
  "amount": 300,
  "currency": "INR",
  "payer": "{{sender}}",
  "split_among": ["all"],
  "split_type": "equal",
  "category": "fuel",
  "description": "Petrol",
  "confidence": 0.91,
  "needs_clarification": false
}
```

### Example 8: Dollars
Message from Vishak: "Hotel cost $120 for the night"
```json
{
  "is_expense": true,
  "amount": 120,
  "currency": "USD",
  "payer": "Vishak",
  "split_among": ["all"],
  "split_type": "equal",
  "category": "accommodation",
  "description": "Hotel",
  "confidence": 0.96,
  "needs_clarification": false
}
```

### Example 9: Correcting a previous expense
Message: "actually that dinner was 1800 not 1600"
```json
{
  "is_expense": false,
  "confidence": 0.1,
  "needs_clarification": false
}
```
(Parser handles corrections separately via CorrectionRequest schema)

### Example 10: Planning — not paid yet
Message: "We need to pay ₹5000 for the venue by Friday"
```json
{
  "is_expense": false,
  "confidence": 0.08,
  "needs_clarification": false
}
```

## Correction Prompt Template

You are analyzing a group chat message to detect if it is correcting a previously recorded expense.

Correction signals: "actually", "wait", "no it was", "change", "remove last", "undo", "delete", "wasn't there", "wasn't at", "update"

Return JSON with: is_correction (bool), correction_type, and relevant fields.
