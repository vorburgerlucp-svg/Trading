// Adversarial tests against a real PostgreSQL: the database itself must refuse to corrupt the
// financial history, and NEXUS must detect (and fail closed on) what a privileged attacker can do.

import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { accounts } from '../../src/capital/accounts.js';
import { CapitalEngine } from '../../src/capital/capital-engine.js';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { verifyStoredLedger } from '../../src/capital/ledger-integrity.js';
import { chf, formatChf } from '../../src/money/money.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { assertNonDestructive, loadMigrations, migrate, MigrationError } from '../../src/persistence/postgres/migrator.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { PostgresLedgerStore } from '../../src/persistence/postgres/postgres-ledger-store.js';
import { auditProjector } from '../../src/persistence/postgres/projectors.js';
import { readOnlyCapital } from '../../src/nexus/nexus-brain.js';
import { fixedClock, policy, sequentialIds, T0 } from '../helpers.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

const bank = accounts.bank('ubs');
const ibkr = accounts.brokerCash('ibkr');

async function engineOn(db: TestDatabase, options: { hooks?: NonNullable<Parameters<typeof PostgresLedgerStore.open>[1]['hooks']> } = {}) {
  const store = await PostgresLedgerStore.open(db.extraPool(), { ledgerId: 'main', ...(options.hooks ? { hooks: options.hooks } : {}) });
  const clock = fixedClock();
  const ledger = await CapitalLedger.open(store, { clock: clock.now });
  return { store, ledger, engine: new CapitalEngine(ledger, { policy: policy(), clock: clock.now, newId: sequentialIds('x') }) };
}

describe.skipIf(!pgAvailable)('PostgreSQL adversarial' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  const fresh = async () => (db = await createTestDatabase());
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  it('Datenbank verweigert UPDATE, DELETE und TRUNCATE auf der Finanzhistorie', async () => {
    const d = await fresh();
    const { engine } = await engineOn(d);
    await engine.deposit({ to: bank, amountChf: chf(100), id: 'dep-1' });
    await (await AuditLog.open(await PostgresAppendOnlyStore.open(d.pool, 'audit', { projector: auditProjector }))).record({
      eventId: 'e1',
      type: 'TASK_CREATED',
      occurredAt: T0,
      actor: { kind: 'system', id: 'test' },
      payload: {},
    });
    for (const sql of [
      "UPDATE ledger_lines SET amount_minor = 999999 WHERE ledger_id = 'main'",
      "DELETE FROM ledger_lines WHERE ledger_id = 'main'",
      "UPDATE ledger_transactions SET description = 'rewritten' WHERE ledger_id = 'main'",
      "DELETE FROM ledger_transactions WHERE ledger_id = 'main'",
      'TRUNCATE ledger_lines',
      "UPDATE ledgers SET head_sequence = 0, head_hash = repeat('0', 64) WHERE ledger_id = 'main'",
      "DELETE FROM ledgers WHERE ledger_id = 'main'",
      "UPDATE append_only_records SET payload = '{}'::jsonb",
      'DELETE FROM audit_events',
    ]) {
      await expect(d.pool.query(sql), sql).rejects.toThrow(/NEXUS_(APPEND_ONLY|LEDGER)/);
    }
  });

  it('Datenbank verweigert direkt eingefügte unausgeglichene, unvollständige oder verzweigte Buchungen', async () => {
    const d = await fresh();
    const { ledger, engine } = await engineOn(d);
    await engine.deposit({ to: bank, amountChf: chf(100), id: 'dep-1' });
    const head = ledger.head();
    const insertTx = (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, seq: number, prev: string, lines: number) =>
      client.query(
        `INSERT INTO ledger_transactions (ledger_id, sequence, entry_id, request_fingerprint, occurred_at, recorded_at, type, description, refs, source, line_count, prev_hash, hash)
         VALUES ('main', $1, $2, $3, now(), now(), 'deposit', 'forged', '{}', 'import', $4, $5, $6)`,
        [seq, 'forged-' + seq + '-' + lines, hashOf('fp' + seq), lines, prev, hashOf('h' + seq + lines)],
      );
    const attempt = async (body: (c: import('pg').Client) => Promise<void>) => {
      const c = await d.privilegedClient();
      try {
        await c.query('BEGIN');
        await body(c);
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    const line = (c: import('pg').Client, seq: number, no: number, amount: number, currency = 'CHF') =>
      c.query('INSERT INTO ledger_lines (ledger_id, sequence, line_no, account, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6)', ['main', seq, no, no === 1 ? bank : accounts.contributions, amount, currency]);

    // unbalanced (checked at COMMIT by the deferred trigger)
    await expect(attempt(async (c) => { await insertTx(c, 2, head.hash, 2); await line(c, 2, 1, 1000); await line(c, 2, 2, -999); })).rejects.toThrow(/unbalanced/);
    // incomplete: fewer lines than declared
    await expect(attempt(async (c) => { await insertTx(c, 2, head.hash, 3); await line(c, 2, 1, 1000); await line(c, 2, 2, -1000); })).rejects.toThrow(/has 2 lines, expected 3/);
    // currency not enabled for this CHF-only ledger
    await expect(attempt(async (c) => { await insertTx(c, 2, head.hash, 2); await line(c, 2, 1, 1000, 'USD'); await line(c, 2, 2, -1000, 'USD'); })).rejects.toThrow(/currency that is not enabled/);
    // fork: link to an older head / skip a sequence
    await expect(attempt(async (c) => { await insertTx(c, 2, '0'.repeat(64), 2); })).rejects.toThrow(/prev_hash .* does not match/);
    await expect(attempt(async (c) => { await insertTx(c, 5, head.hash, 2); })).rejects.toThrow(/does not follow head/);
    // a line appended later to an existing transaction
    await expect(attempt(async (c) => { await line(c, 1, 3, 0 + 1); })).rejects.toThrow(/NEXUS_LEDGER/);

    expect((await d.pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE ledger_id = 'main'")).rows[0].n).toBe(1);
    expect((await verifyStoredLedger(await PostgresLedgerStore.open(d.pool, { ledgerId: 'main' }))).ok).toBe(true);
  });

  it('Process Crash: Verbindung stirbt mitten in einer 4-Line-Buchung (nach Line 3) → 0 Teilbuchungen, danach geht es sauber weiter', async () => {
    const d = await fresh();
    const setup = await engineOn(d);
    await setup.engine.deposit({ to: bank, amountChf: chf(500), id: 'dep-1' });
    await setup.engine.transfer({ from: bank, to: ibkr, amountChf: chf(300), id: 'tr-1' });
    await setup.engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 3, grossAmountChf: chf(100), id: 'buy-1' });

    // The sell has 4 lines (proceeds, fee, position, realized P&L); the backend is killed after line 3.
    const crashing = await engineOn(d, {
      hooks: {
        afterLineInserted: async (lineNo, client) => {
          if (lineNo === 3) await client.query('SELECT pg_terminate_backend(pg_backend_pid())');
        },
      },
    });
    await expect(
      crashing.engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(40), feeChf: chf(1), id: 'sell-1' }),
    ).rejects.toThrow();
    const rows = await d.pool.query("SELECT (SELECT count(*) FROM ledger_transactions WHERE ledger_id = 'main')::int AS tx, (SELECT count(*) FROM ledger_lines WHERE ledger_id = 'main')::int AS lines");
    expect(rows.rows[0]).toEqual({ tx: 3, lines: 2 + 2 + 2 }); // only the three committed entries (zero fees create no line)
    expect((await verifyStoredLedger(await PostgresLedgerStore.open(d.pool, { ledgerId: 'main' }))).ok).toBe(true);

    // Retry with the same idempotency key on a healthy server: booked exactly once.
    const healthy = await engineOn(d);
    expect((await healthy.engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(40), feeChf: chf(1), id: 'sell-1' })).status).toBe('APPLIED');
    expect((await healthy.engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(40), feeChf: chf(1), id: 'sell-1' })).status).toBe('ALREADY_APPLIED');
  });

  it('Fehler zwischen Lines (Exception) → vollständiger Rollback', async () => {
    const d = await fresh();
    const failing = await engineOn(d, {
      hooks: {
        afterLineInserted: (lineNo) => {
          if (lineNo === 1) throw new Error('simulated failure after line 1');
        },
      },
    });
    await expect(failing.engine.deposit({ to: bank, amountChf: chf(10), id: 'dep-x' })).rejects.toThrow(/simulated failure/);
    expect((await d.pool.query('SELECT count(*)::int AS n FROM ledger_lines')).rows[0].n).toBe(0);
    expect((await d.pool.query("SELECT head_sequence::int AS h FROM ledgers WHERE ledger_id = 'main'")).rows[0].h).toBe(0);
  });

  it('Tampering mit Superuser-Rechten (Trigger umgangen) wird beim Start erkannt: FINANCIAL_INTEGRITY_ERROR', async () => {
    const d = await fresh();
    const { engine } = await engineOn(d);
    await engine.deposit({ to: bank, amountChf: chf('487.30'), id: 'dep-1' });
    await engine.recordExpense({ category: 'fee', feeKind: 'bank', amountChf: chf('2.00'), paidFrom: bank, id: 'fee-1' });

    const c = await d.privilegedClient();
    await c.query("SET session_replication_role = 'replica'"); // disables triggers: only a superuser can do this
    await c.query("UPDATE ledger_lines SET amount_minor = amount_minor + 1000 WHERE ledger_id = 'main' AND sequence = 1 AND line_no = 1");
    await c.query("UPDATE ledger_lines SET amount_minor = amount_minor - 1000 WHERE ledger_id = 'main' AND sequence = 1 AND line_no = 2");
    await c.end();

    const report = await verifyStoredLedger(await PostgresLedgerStore.open(d.pool, { ledgerId: 'main' }));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('HASH_MISMATCH');
    await expect(CapitalLedger.open(await PostgresLedgerStore.open(d.pool, { ledgerId: 'main' }))).rejects.toMatchObject({ code: 'FINANCIAL_INTEGRITY_ERROR' });
  });

  it('laufender Server erkennt eine gefälschte neue Buchung und blockiert danach jede Kapitalentscheidung', async () => {
    const d = await fresh();
    const running = await engineOn(d);
    await running.engine.deposit({ to: bank, amountChf: chf(100), id: 'dep-1' });
    const head = running.ledger.head();

    // Attacker inserts a structurally valid, correctly linked, balanced transaction with a fake hash.
    const c = await d.privilegedClient();
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO ledger_transactions (ledger_id, sequence, entry_id, request_fingerprint, occurred_at, recorded_at, type, description, refs, source, line_count, prev_hash, hash)
       VALUES ('main', 2, 'forged', $1, now(), now(), 'deposit', 'free money', '{}', 'import', 2, $2, $3)`,
      [hashOf('x'), head.hash, hashOf('not the real content hash')],
    );
    await c.query("INSERT INTO ledger_lines (ledger_id, sequence, line_no, account, amount_minor, currency) VALUES ('main', 2, 1, $1, 1000000, 'CHF'), ('main', 2, 2, 'equity:contributions', -1000000, 'CHF')", [bank]);
    await c.query('COMMIT');
    await c.end();

    await expect(running.engine.deposit({ to: bank, amountChf: chf(1), id: 'dep-2' })).rejects.toMatchObject({ code: 'FINANCIAL_INTEGRITY_ERROR' });
    expect(() => running.engine.capitalState()).toThrow(/FINANCIAL_INTEGRITY_ERROR/);
    const reader = readOnlyCapital(running.engine);
    await expect(reader.refresh?.()).rejects.toMatchObject({ code: 'FINANCIAL_INTEGRITY_ERROR' });
  });

  it('Migrationen: wiederholbar, Prüfsummen geschützt, destruktive Statements verweigert', async () => {
    const d = await fresh();
    expect(await migrate(d.pool)).toEqual({ applied: [], alreadyApplied: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const edited = loadMigrations().map((m) => (m.version === 2 ? { ...m, sql: m.sql + '\n-- edited later', checksum: hashOf('edited') } : m));
    await expect(migrate(d.pool, edited)).rejects.toBeInstanceOf(MigrationError);
    await expect(migrate(d.pool, edited)).rejects.toThrow(/modified after it was applied/);
    expect(() => assertNonDestructive({ version: 4, name: 'bad', sql: 'DELETE FROM ledger_lines;' })).toThrow(/DELETE/);
    expect(() => assertNonDestructive({ version: 4, name: 'bad', sql: 'ALTER TABLE ledger_lines DISABLE TRIGGER ALL;' })).toThrow(/ALTER_DROP/);
  });

  it('confidence ≠ Wahrscheinlichkeit: eine kalibrierte Wahrscheinlichkeit ohne Methode wird von der DB abgelehnt', async () => {
    const d = await fresh();
    const audit = await AuditLog.open(await PostgresAppendOnlyStore.open(d.pool, 'audit', { projector: auditProjector }));
    const run = {
      stepId: 'analysts', role: 'analyst', modelKey: 'openai/test-gpt', provider: 'openai', model: 'test-gpt', shadow: false, status: 'ok',
      promptId: 'nexus.analyst', promptVersion: '1.1.0', requestHash: hashOf('req'), responseHash: hashOf('res'), latencyMs: 12,
      confidenceScore: 0.8, calibratedProbability: 0.71, calibrationMethod: null,
    };
    const event = { eventId: 'd:001:model_response_received', type: 'MODEL_RESPONSE_RECEIVED' as const, occurredAt: T0, decisionId: 'd', taskId: 't', actor: { kind: 'model' as const, id: 'openai/test-gpt' }, payload: run };
    await expect(audit.record(event)).rejects.toThrow(/check/i);
    expect(audit.all()).toEqual([]); // the hash-chained audit record was rolled back together with the projection
    await audit.record({ ...event, payload: { ...run, calibratedProbability: null } });
    const stored = await d.pool.query('SELECT confidence_score::text AS c, calibrated_probability, calibration_method FROM model_runs');
    expect(stored.rows).toEqual([{ c: '0.8', calibrated_probability: null, calibration_method: null }]);
  });

  it('Geldwerte bleiben exakt: BIGINT-Rappen jenseits von 2^53 und NUMERIC-Mengen', async () => {
    const d = await fresh();
    const { engine } = await engineOn(d);
    await engine.deposit({ to: ibkr, amountChf: chf('90071992547409.93'), id: 'big' });
    const row = (await d.pool.query("SELECT amount_minor::text AS a FROM ledger_lines WHERE ledger_id = 'main' AND sequence = 1 AND line_no = 1")).rows[0];
    expect(row.a).toBe('9007199254740993');
    const reopened = await engineOn(d);
    expect(formatChf(reopened.ledger.balance(ibkr).amount)).toBe('90071992547409.93');
  });
});
