import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { simplifyDebts, calculateBalances } from './ledger.js';
import type { Balance } from './schemas.js';

// In-memory SQLite for tests
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE groups (id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, platform_user_id TEXT NOT NULL, display_name TEXT NOT NULL, phone_number TEXT, aliases TEXT NOT NULL DEFAULT '[]', UNIQUE(group_id, platform_user_id));
    CREATE TABLE expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', description TEXT, category TEXT, split_type TEXT NOT NULL DEFAULT 'equal', source_message_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
    CREATE TABLE expense_splits (id TEXT PRIMARY KEY, expense_id TEXT NOT NULL, member_id TEXT NOT NULL, share_amount REAL NOT NULL);
    CREATE TABLE settlements (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, from_member_id TEXT NOT NULL, to_member_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  return db;
}

describe('simplifyDebts', () => {
  it('should return empty array when no balances', () => {
    const result = simplifyDebts([]);
    assert.deepEqual(result, []);
  });

  it('should simplify A→B and B→C to A→C', () => {
    const balances: Balance[] = [
      { fromMemberId: 'a', fromMemberName: 'Alice', toMemberId: 'b', toMemberName: 'Bob', amount: 500, currency: 'INR' },
      { fromMemberId: 'b', fromMemberName: 'Bob', toMemberId: 'c', toMemberName: 'Carol', amount: 500, currency: 'INR' },
    ];
    const simplified = simplifyDebts(balances);
    // Alice should pay Carol directly
    assert.equal(simplified.length, 1);
    assert.equal(simplified[0].fromMemberName, 'Alice');
    assert.equal(simplified[0].toMemberName, 'Carol');
    assert.equal(simplified[0].amount, 500);
  });

  it('should handle 3-way split correctly', () => {
    // Vishak paid 3000, split 3 ways (Vishak, Ravi, Priya)
    // Each owes 1000; Vishak is owed 2000
    const balances: Balance[] = [
      { fromMemberId: 'ravi', fromMemberName: 'Ravi', toMemberId: 'vishak', toMemberName: 'Vishak', amount: 1000, currency: 'INR' },
      { fromMemberId: 'priya', fromMemberName: 'Priya', toMemberId: 'vishak', toMemberName: 'Vishak', amount: 1000, currency: 'INR' },
    ];
    const simplified = simplifyDebts(balances);
    assert.equal(simplified.length, 2);
    const total = simplified.reduce((s, b) => s + b.amount, 0);
    assert.equal(total, 2000);
  });

  it('should handle zero balances gracefully', () => {
    const balances: Balance[] = [
      { fromMemberId: 'a', fromMemberName: 'Alice', toMemberId: 'b', toMemberName: 'Bob', amount: 500, currency: 'INR' },
      { fromMemberId: 'b', fromMemberName: 'Bob', toMemberId: 'a', toMemberName: 'Alice', amount: 500, currency: 'INR' },
    ];
    const simplified = simplifyDebts(balances);
    // They cancel out
    assert.equal(simplified.length, 0);
  });

  it('should keep different currencies separate', () => {
    const balances: Balance[] = [
      { fromMemberId: 'a', fromMemberName: 'Alice', toMemberId: 'b', toMemberName: 'Bob', amount: 500, currency: 'INR' },
      { fromMemberId: 'a', fromMemberName: 'Alice', toMemberId: 'b', toMemberName: 'Bob', amount: 50, currency: 'USD' },
    ];
    const simplified = simplifyDebts(balances);
    assert.equal(simplified.length, 2);
    const currencies = simplified.map((b) => b.currency).sort();
    assert.deepEqual(currencies, ['INR', 'USD']);
  });
});

describe('calculateBalances', () => {
  it('should compute balances correctly for a simple 3-way expense', () => {
    const db = createTestDb();

    // Setup: group and 3 members
    db.prepare("INSERT INTO groups (id, platform) VALUES ('g1', 'telegram')").run();
    db.prepare("INSERT INTO members (id, group_id, platform_user_id, display_name) VALUES ('m_vishak', 'g1', 'u1', 'Vishak')").run();
    db.prepare("INSERT INTO members (id, group_id, platform_user_id, display_name) VALUES ('m_ravi', 'g1', 'u2', 'Ravi')").run();
    db.prepare("INSERT INTO members (id, group_id, platform_user_id, display_name) VALUES ('m_priya', 'g1', 'u3', 'Priya')").run();

    // Vishak paid ₹3000 for dinner, split 3 ways
    db.prepare("INSERT INTO expenses (id, group_id, payer_id, amount, currency) VALUES ('e1', 'g1', 'm_vishak', 3000, 'INR')").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s1', 'e1', 'm_vishak', 1000)").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s2', 'e1', 'm_ravi', 1000)").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s3', 'e1', 'm_priya', 1000)").run();

    const balances = calculateBalances(db, 'g1');

    // Ravi and Priya each owe Vishak ₹1000
    const raviOwes = balances.find((b) => b.fromMemberName === 'Ravi' && b.toMemberName === 'Vishak');
    const priyaOwes = balances.find((b) => b.fromMemberName === 'Priya' && b.toMemberName === 'Vishak');

    assert.ok(raviOwes, 'Ravi should owe Vishak');
    assert.ok(priyaOwes, 'Priya should owe Vishak');
    assert.equal(raviOwes!.amount, 1000);
    assert.equal(priyaOwes!.amount, 1000);

    db.close();
  });

  it('should net out when same pair has multiple expenses', () => {
    const db = createTestDb();

    db.prepare("INSERT INTO groups (id, platform) VALUES ('g2', 'telegram')").run();
    db.prepare("INSERT INTO members (id, group_id, platform_user_id, display_name) VALUES ('a', 'g2', 'u1', 'Alice')").run();
    db.prepare("INSERT INTO members (id, group_id, platform_user_id, display_name) VALUES ('b', 'g2', 'u2', 'Bob')").run();

    // Alice paid 1000, split 2 ways → Bob owes 500
    db.prepare("INSERT INTO expenses (id, group_id, payer_id, amount) VALUES ('e1', 'g2', 'a', 1000)").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s1', 'e1', 'a', 500)").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s2', 'e1', 'b', 500)").run();

    // Bob paid 600, split 2 ways → Alice owes 300
    db.prepare("INSERT INTO expenses (id, group_id, payer_id, amount) VALUES ('e2', 'g2', 'b', 600)").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s3', 'e2', 'a', 300)").run();
    db.prepare("INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES ('s4', 'e2', 'b', 300)").run();

    // Net: Bob owes Alice 500-300=200
    const balances = calculateBalances(db, 'g2');
    const simplified = simplifyDebts(balances);

    assert.equal(simplified.length, 1);
    assert.equal(simplified[0].fromMemberName, 'Bob');
    assert.equal(simplified[0].toMemberName, 'Alice');
    assert.equal(simplified[0].amount, 200);

    db.close();
  });
});
