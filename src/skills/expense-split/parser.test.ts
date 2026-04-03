import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldParseAsExpense, looksLikeCorrection } from './parser.js';

describe('shouldParseAsExpense — fast regex filter', () => {
  // True positives
  const truePositives = [
    'Paid ₹2400 for the Airbnb',
    'Lunch was ₹1600, I got it',
    'Ravi and I split a cab — ₹400',
    'Beers on me tonight 🍺 ₹900',
    'spent $50 on groceries',
    'cost Rs 500',
    'Maine 200 diye petrol ke liye',
    'paid three hundred for petrol',
    'Hotel cost $120 for the night',
    'owe me 500',
    'she owes ₹200',
    'bought lunch for everyone, 1200 rupees',
    'I covered it, €80',
    'kharcha 300 hua',
    'liya dinner ka bill 2500',
  ];

  for (const msg of truePositives) {
    it(`should detect expense: "${msg}"`, () => {
      assert.equal(shouldParseAsExpense(msg), true);
    });
  }

  // False positives that should NOT trigger LLM
  const falsePositives = [
    'I have 500 reasons to be happy 😄',
    'Hey everyone!',
    'hahaha 😂',
    'What time are we meeting?',
    'I miss home',
    'ok see you at 7',
    'lol good one',
    'Send me the photos',
    'Happy birthday! 🎂',
    'Can you book the cab?',
  ];

  for (const msg of falsePositives) {
    it(`should NOT detect expense: "${msg}"`, () => {
      assert.equal(shouldParseAsExpense(msg), false);
    });
  }
});

describe('looksLikeCorrection', () => {
  const corrections = [
    'actually that dinner was 1800 not 1600',
    'wait, remove last expense',
    'undo',
    'remove last',
    'change that to 500',
    "update the bill, Priya wasn't there",
    "no it was 1200, not 1000",
    'delete that expense',
  ];

  for (const msg of corrections) {
    it(`should detect correction: "${msg}"`, () => {
      assert.equal(looksLikeCorrection(msg), true);
    });
  }

  const notCorrections = [
    'Paid ₹2400 for the Airbnb',
    'splits',
    'who owes what',
    'Lunch was amazing!',
    'OMG yes finally',
  ];

  for (const msg of notCorrections) {
    it(`should NOT detect correction: "${msg}"`, () => {
      assert.equal(looksLikeCorrection(msg), false);
    });
  }
});
