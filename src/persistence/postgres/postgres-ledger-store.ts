// PostgreSQL implementation of the ledger store.
//
// Serialization strategy (multi-server safe, no reliance on process-local mutexes):
//   BEGIN ISOLATION LEVEL READ COMMITTED
//   SELECT ... FROM ledgers WHERE ledger_id = $1 FOR UPDATE      -- one writer per ledger, cluster-wide
//   SELECT entries with sequence > knownSequence                 -- sees everything committed before the lock
//   decide(newer)  (ledger catches up, checks idempotency + rules, builds the hashed entry)
//   INSERT transaction, INSERT lines 1..n                        -- triggers check link; constraints check shape
//   COMMIT                                                       -- deferred triggers check balance/completeness
// READ COMMITTED (not REPEATABLE READ) is deliberate: after waiting for the row lock, the next
// statement must see the rows committed by the previous lock holder.
// Any error → ROLLBACK: a transaction is stored with all its lines or not at all.

import type { JournalEntry, Posting } from '../../capital/capital-types.js';
import { LedgerError } from '../../capital/ledger-errors.js';
import { BASE_LEDGER_CURRENCY, FinancialIntegrityError } from '../../capital/ledger-integrity.js';
import type { LedgerStore, LedgerWriteDecision } from '../../capital/ledger-store.js';
import { Decimal } from '../../money/decimal.js';
import { rappen } from '../../money/money.js';
import { mapLedgerDbError } from './pg-errors.js';
import type { PgClient, PgPool } from './pool.js';

export interface PostgresLedgerStoreOptions {
  ledgerId: string;
  /** Used only when the ledger row is created. */
  baseCurrency?: string;
  allowedCurrencies?: readonly string[];
  lockTimeoutMs?: number;
  /** TEST / DIAGNOSTICS ONLY: called after each line insert inside the open transaction (fault injection). */
  hooks?: { afterLineInserted?: (lineNo: number, client: PgClient) => Promise<void> | void };
}

interface Row {
  sequence_text: string;
  entry_id: string;
  request_fingerprint: string;
  occurred_at: Date;
  recorded_at: Date;
  type: JournalEntry['type'];
  description: string;
  refs: Record<string, string>;
  source: JournalEntry['source'];
  line_count: number;
  prev_hash: string;
  hash: string;
  line_no: number | null;
  account: string | null;
  amount_minor: string | null;
  currency: string | null;
  quantity: string | null;
}

export class PostgresLedgerStore implements LedgerStore {
  private constructor(
    private readonly pool: PgPool,
    readonly ledgerId: string,
    readonly allowedCurrencies: readonly string[],
    private readonly options: PostgresLedgerStoreOptions,
  ) {}

  /** Opens (and if necessary creates) a ledger. The currency configuration in the database is authoritative. */
  static async open(pool: PgPool, options: PostgresLedgerStoreOptions): Promise<PostgresLedgerStore> {
    const base = options.baseCurrency ?? BASE_LEDGER_CURRENCY;
    const allowed = [...(options.allowedCurrencies ?? [base])];
    await pool.query('INSERT INTO ledgers (ledger_id, base_currency, allowed_currencies) VALUES ($1, $2, $3) ON CONFLICT (ledger_id) DO NOTHING', [options.ledgerId, base, allowed]);
    const row = (await pool.query<{ base_currency: string; allowed_currencies: string[] }>('SELECT base_currency, allowed_currencies FROM ledgers WHERE ledger_id = $1', [options.ledgerId])).rows[0];
    if (!row) throw new LedgerError('store_unavailable', 'ledger ' + options.ledgerId + ' could not be created');
    if (row.base_currency !== base) throw new LedgerError('store_rejected', 'ledger ' + options.ledgerId + ' has base currency ' + row.base_currency + ', expected ' + base);
    return new PostgresLedgerStore(pool, options.ledgerId, Object.freeze([...row.allowed_currencies]), options);
  }

  loadAll(): Promise<readonly JournalEntry[]> {
    return this.loadAfterWith(this.pool, 0);
  }

  loadAfter(sequence: number): Promise<readonly JournalEntry[]> {
    return this.loadAfterWith(this.pool, sequence);
  }

  async writeExclusive<R>(knownSequence: number, decide: (newer: readonly JournalEntry[]) => LedgerWriteDecision<R>): Promise<R> {
    const client = await this.pool.connect();
    let failed: unknown;
    // A connection that dies mid-transaction emits 'error' on the client; without a listener that
    // would crash the process. The failure surfaces through the pending query instead.
    const onConnectionError = (error: Error) => {
      failed = failed ?? error;
    };
    client.on('error', onConnectionError);
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.options.lockTimeoutMs ?? 15_000) + 'ms']);
      const head = await client.query('SELECT head_sequence FROM ledgers WHERE ledger_id = $1 FOR UPDATE', [this.ledgerId]);
      if (head.rowCount === 0) throw new LedgerError('store_unavailable', 'unknown ledger ' + this.ledgerId);
      const newer = await this.loadAfterWith(client, knownSequence);
      const decision = decide(newer);
      if (decision.kind === 'append') await this.insert(client, decision.entry);
      await client.query('COMMIT');
      return decision.result;
    } catch (error) {
      failed = error;
      try {
        await client.query('ROLLBACK');
      } catch {
        // the connection may already be gone (crash); PostgreSQL aborts the open transaction itself
      }
      throw mapLedgerDbError(error);
    } finally {
      client.off('error', onConnectionError);
      // A client that saw an error is discarded rather than reused.
      client.release(failed instanceof Error ? failed : undefined);
    }
  }

  private async insert(client: PgClient, entry: JournalEntry): Promise<void> {
    await client.query(
      `INSERT INTO ledger_transactions
         (ledger_id, sequence, entry_id, request_fingerprint, occurred_at, recorded_at, type, description, refs, source, reverses_entry_id, line_count, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        this.ledgerId,
        entry.sequence,
        entry.id,
        entry.requestFingerprint,
        entry.occurredAt,
        entry.recordedAt,
        entry.type,
        entry.description,
        JSON.stringify(entry.refs),
        entry.source,
        entry.refs.reversesEntryId ?? null,
        entry.postings.length,
        entry.prevHash,
        entry.hash,
      ],
    );
    let lineNo = 0;
    for (const posting of entry.postings) {
      lineNo++;
      await client.query(
        'INSERT INTO ledger_lines (ledger_id, sequence, line_no, account, amount_minor, currency, quantity) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::numeric)',
        [this.ledgerId, entry.sequence, lineNo, posting.account, (posting.amount as bigint).toString(), posting.currency ?? BASE_LEDGER_CURRENCY, posting.quantity?.toString() ?? null],
      );
      await this.options.hooks?.afterLineInserted?.(lineNo, client);
    }
  }

  private async loadAfterWith(queryable: PgPool | PgClient, sequence: number): Promise<readonly JournalEntry[]> {
    const { rows } = await queryable.query<Row>(
      `SELECT t.sequence::text AS sequence_text, t.entry_id, t.request_fingerprint, t.occurred_at, t.recorded_at, t.type, t.description, t.refs, t.source,
              t.line_count, t.prev_hash, t.hash, l.line_no, l.account, l.amount_minor::text AS amount_minor, l.currency, l.quantity::text AS quantity
         FROM ledger_transactions t
         LEFT JOIN ledger_lines l ON l.ledger_id = t.ledger_id AND l.sequence = t.sequence
        WHERE t.ledger_id = $1 AND t.sequence > $2
        ORDER BY t.sequence, l.line_no`,
      [this.ledgerId, sequence],
    );
    const entries: JournalEntry[] = [];
    let current: { row: Row; postings: Posting[] } | null = null;
    const flush = () => {
      if (!current) return;
      const { row, postings } = current;
      if (postings.length !== row.line_count) {
        throw new FinancialIntegrityError([{ code: 'INCOMPLETE_TRANSACTION', sequence: Number(row.sequence_text), message: postings.length + ' of ' + row.line_count + ' lines present' }], 'ledger ' + this.ledgerId);
      }
      entries.push({
        sequence: Number(row.sequence_text),
        id: row.entry_id,
        occurredAt: row.occurred_at.toISOString(),
        recordedAt: row.recorded_at.toISOString(),
        type: row.type,
        description: row.description,
        postings,
        refs: row.refs,
        source: row.source,
        requestFingerprint: row.request_fingerprint,
        prevHash: row.prev_hash,
        hash: row.hash,
      });
    };
    for (const row of rows) {
      if (!current || current.row.sequence_text !== row.sequence_text) {
        flush();
        current = { row, postings: [] };
      }
      if (row.line_no !== null && row.account !== null && row.amount_minor !== null && row.currency !== null) {
        current.postings.push({
          account: row.account,
          amount: rappen(BigInt(row.amount_minor)),
          ...(row.quantity !== null ? { quantity: Decimal.from(row.quantity) } : {}),
          ...(row.currency !== BASE_LEDGER_CURRENCY ? { currency: row.currency } : {}),
        });
      }
    }
    flush();
    return entries;
  }
}
