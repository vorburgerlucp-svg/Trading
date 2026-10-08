// PostgreSQL market data store. Same rules as the in-memory store (shared planning functions):
// one transaction per ingest, holding the per-instrument head row lock; the latest revisions of
// the delivered keys are read inside the lock, the plan is computed, rows are bulk-inserted in
// ingest order. Triggers re-check sequence, revision chain and OHLC. Every row read back is
// re-hashed; a mismatch fails closed (MARKET_DATA_INTEGRITY_ERROR).

import { Decimal } from '../../money/decimal.js';
import { encodeJson } from '../json-codec.js';
import { barContentHash, barKey, corporateActionContentHash, quoteContentHash } from '../../market-data/bar-validation.js';
import {
  MarketDataStoreError,
  assertIntact,
  corporateActionKey,
  planBars,
  planCorporateActions,
  planQuotes,
  quoteKey,
  sourceHash,
  validateSource,
  type BarQuery,
  type CorporateActionQuery,
  type IngestInstrument,
  type IngestPlan,
  type IngestSummary,
  type MarketDataStore,
  type QuoteQuery,
} from '../../market-data/market-data-store.js';
import type { CorporateAction, MarketBar, MarketDataSource, MarketQuote, QuarantineRecord, StoredBar, StoredCorporateAction, StoredQuote } from '../../market-data/market-data-types.js';
import { canonicalUtc } from '../../market-data/time.js';
import type { PgClient, PgPool } from './pool.js';

const CHUNK = 1000;
const ts = (d: Date) => d.toISOString();
const dec = (v: string | null) => (v === null ? undefined : Decimal.from(v));

interface BarRow {
  instrument_id: string;
  source_id: string;
  bar_interval: MarketBar['interval'];
  session: MarketBar['session'];
  adjustment: MarketBar['adjustment'];
  start_time: Date;
  end_time: Date;
  revision: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  is_final: boolean;
  observed_at: Date;
  available_at: Date;
  retrieved_at: Date;
  ingest_seq_text: string;
  content_hash: string;
}

function toBar(r: BarRow): StoredBar {
  const bar: StoredBar = {
    instrumentId: r.instrument_id,
    source: r.source_id,
    interval: r.bar_interval,
    session: r.session,
    adjustment: r.adjustment,
    startTime: ts(r.start_time),
    endTime: ts(r.end_time),
    open: Decimal.from(r.open),
    high: Decimal.from(r.high),
    low: Decimal.from(r.low),
    close: Decimal.from(r.close),
    isFinal: r.is_final,
    observedAt: ts(r.observed_at),
    availableAt: ts(r.available_at),
    retrievedAt: ts(r.retrieved_at),
    revision: r.revision,
    ingestSeq: Number(r.ingest_seq_text),
    contentHash: r.content_hash,
  };
  if (r.volume !== null) bar.volume = Decimal.from(r.volume);
  return bar;
}

interface QuoteRow {
  instrument_id: string;
  source_id: string;
  observed_at: Date;
  revision: number;
  last_price: string;
  bid: string | null;
  ask: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  previous_close: string | null;
  volume: string | null;
  currency: string | null;
  market_open: boolean | null;
  available_at: Date;
  retrieved_at: Date;
  ingest_seq_text: string;
  content_hash: string;
}

function toQuote(r: QuoteRow): StoredQuote {
  const q: StoredQuote = {
    instrumentId: r.instrument_id,
    source: r.source_id,
    last: Decimal.from(r.last_price),
    observedAt: ts(r.observed_at),
    availableAt: ts(r.available_at),
    retrievedAt: ts(r.retrieved_at),
    revision: r.revision,
    ingestSeq: Number(r.ingest_seq_text),
    contentHash: r.content_hash,
  };
  for (const [field, value] of [['bid', r.bid], ['ask', r.ask], ['open', r.open], ['high', r.high], ['low', r.low], ['previousClose', r.previous_close], ['volume', r.volume]] as const) {
    const d = dec(value);
    if (d !== undefined) q[field] = d;
  }
  if (r.currency !== null) q.currency = r.currency;
  if (r.market_open !== null) q.marketOpen = r.market_open;
  return q;
}

interface ActionRow {
  instrument_id: string;
  source_id: string;
  action_key: string;
  revision: number;
  type: CorporateAction['type'];
  ex_date_text: string;
  ratio_from: string | null;
  ratio_to: string | null;
  cash_amount: string | null;
  currency: string | null;
  old_symbol: string | null;
  new_symbol: string | null;
  announced_at: Date | null;
  available_at: Date;
  retrieved_at: Date;
  ingest_seq_text: string;
  content_hash: string;
}

function toAction(r: ActionRow): StoredCorporateAction {
  const a: StoredCorporateAction = {
    actionKey: r.action_key,
    instrumentId: r.instrument_id,
    source: r.source_id,
    type: r.type,
    exDate: r.ex_date_text,
    availableAt: ts(r.available_at),
    retrievedAt: ts(r.retrieved_at),
    revision: r.revision,
    ingestSeq: Number(r.ingest_seq_text),
    contentHash: r.content_hash,
  };
  const from = dec(r.ratio_from);
  const to = dec(r.ratio_to);
  const cash = dec(r.cash_amount);
  if (from !== undefined) a.ratioFrom = from;
  if (to !== undefined) a.ratioTo = to;
  if (cash !== undefined) a.cashAmount = cash;
  if (r.currency !== null) a.currency = r.currency;
  if (r.old_symbol !== null) a.oldSymbol = r.old_symbol;
  if (r.new_symbol !== null) a.newSymbol = r.new_symbol;
  if (r.announced_at !== null) a.announcedAt = ts(r.announced_at);
  return a;
}

const BAR_COLUMNS = 'instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq::text AS ingest_seq_text, content_hash';
const QUOTE_COLUMNS = 'instrument_id, source_id, observed_at, revision, last_price, bid, ask, open, high, low, previous_close, volume, currency, market_open, available_at, retrieved_at, ingest_seq::text AS ingest_seq_text, content_hash';
const ACTION_COLUMNS = "instrument_id, source_id, action_key, revision, type, to_char(ex_date, 'YYYY-MM-DD') AS ex_date_text, ratio_from, ratio_to, cash_amount, currency, old_symbol, new_symbol, announced_at, available_at, retrieved_at, ingest_seq::text AS ingest_seq_text, content_hash";

function mapDbError(error: unknown): unknown {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string') return error;
  if (['55P03', '40001', '40P01'].includes(code)) return new MarketDataStoreError('unavailable', 'market data store busy (' + code + '); nothing was written');
  if (['23505', '23503', '23514', '23502', 'P0001'].includes(code)) return new MarketDataStoreError('invalid', 'database rejected market data (' + code + '): ' + (error as Error).message);
  return error;
}

export class PostgresMarketDataStore implements MarketDataStore {
  constructor(
    private readonly pool: PgPool,
    private readonly options: { lockTimeoutMs?: number } = {},
  ) {}

  async registerSource(source: MarketDataSource): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    validateSource(source);
    const hash = sourceHash(source);
    const inserted = await this.pool.query(
      'INSERT INTO market_data_sources (source_id, provider, dataset, environment, license_class, license_note, source_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (source_id) DO NOTHING',
      [source.sourceId, source.provider, source.dataset, source.environment, source.license, source.licenseNote ?? null, hash],
    );
    if (inserted.rowCount === 1) return 'APPLIED';
    const existing = await this.pool.query<{ source_hash: string }>('SELECT source_hash FROM market_data_sources WHERE source_id = $1', [source.sourceId]);
    if (existing.rows[0]?.source_hash !== hash) throw new MarketDataStoreError('source_conflict', 'source ' + source.sourceId + ' is already registered with different metadata');
    return 'ALREADY_APPLIED';
  }

  async getSource(sourceId: string): Promise<MarketDataSource | null> {
    const row = (
      await this.pool.query<{ source_id: string; provider: string; dataset: string; environment: MarketDataSource['environment']; license_class: MarketDataSource['license']; license_note: string | null }>(
        'SELECT source_id, provider, dataset, environment, license_class, license_note FROM market_data_sources WHERE source_id = $1',
        [sourceId],
      )
    ).rows[0];
    if (!row) return null;
    return { sourceId: row.source_id, provider: row.provider, dataset: row.dataset, environment: row.environment, license: row.license_class, ...(row.license_note !== null ? { licenseNote: row.license_note } : {}) };
  }

  /** One locked transaction per ingest call (per instrument). */
  private async ingest<T>(instrumentId: string, sourceIds: string[], work: (client: PgClient, head: number, sources: Set<string>) => Promise<IngestPlan<T>>, insert: (client: PgClient, rows: T[]) => Promise<void>): Promise<IngestSummary> {
    const client = await this.pool.connect();
    let failed: unknown;
    const onError = (error: Error) => {
      failed = failed ?? error;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.options.lockTimeoutMs ?? 15_000) + 'ms']);
      await client.query('INSERT INTO market_data_heads (instrument_id) VALUES ($1) ON CONFLICT (instrument_id) DO NOTHING', [instrumentId]);
      const head = Number((await client.query<{ h: string }>('SELECT head_seq::text AS h FROM market_data_heads WHERE instrument_id = $1 FOR UPDATE', [instrumentId])).rows[0]!.h);
      const sources = new Set((await client.query<{ source_id: string }>('SELECT source_id FROM market_data_sources WHERE source_id = ANY($1::text[])', [sourceIds])).rows.map((r) => r.source_id));
      const plan = await work(client, head, sources);
      const rows = plan.rows.map((r) => r.row);
      for (let i = 0; i < rows.length; i += CHUNK) await insert(client, rows.slice(i, i + CHUNK));
      await this.insertQuarantine(client, plan.quarantined);
      await client.query('COMMIT');
      const last = rows.length > 0 ? (rows[rows.length - 1] as unknown as { ingestSeq: number }).ingestSeq : head;
      return { inserted: rows.length, unchanged: plan.unchanged, providerRevisions: plan.providerRevisions, quarantined: plan.quarantined, headSeq: last };
    } catch (error) {
      failed = error;
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapDbError(error);
    } finally {
      client.off('error', onError);
      client.release(failed instanceof Error ? failed : undefined);
    }
  }

  private async insertQuarantine(client: PgClient, records: readonly QuarantineRecord[]): Promise<void> {
    for (const q of records) {
      await client.query('INSERT INTO market_data_quarantine (kind, instrument_id, source_id, received_at, reasons, raw) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)', [
        q.kind,
        q.instrumentId,
        q.source,
        q.receivedAt,
        JSON.stringify(encodeJson(q.reasons)),
        JSON.stringify(encodeJson(q.raw)),
      ]);
    }
  }

  ingestBars(instrument: IngestInstrument, bars: readonly MarketBar[], receivedAt: string): Promise<IngestSummary> {
    const sourceIds = [...new Set(bars.map((b) => (typeof b?.source === 'string' ? b.source : '')))];
    return this.ingest<StoredBar>(
      instrument.instrumentId,
      sourceIds,
      async (client, head, sources) => {
        const keys = bars.filter((b) => b && typeof b.startTime === 'string' && typeof b.source === 'string');
        const latest = new Map<string, StoredBar>();
        if (keys.length > 0) {
          const starts: string[] = [];
          for (const b of keys) {
            try {
              starts.push(canonicalUtc(b.startTime));
            } catch {
              // invalid timestamps are quarantined by the planner
            }
          }
          const { rows } = await client.query<BarRow>(
            'SELECT DISTINCT ON (source_id, bar_interval, session, adjustment, start_time) ' + BAR_COLUMNS +
              ' FROM market_bars WHERE instrument_id = $1 AND start_time = ANY($2::timestamptz[]) ORDER BY source_id, bar_interval, session, adjustment, start_time, revision DESC',
            [instrument.instrumentId, starts],
          );
          for (const r of rows) {
            const bar = toBar(r);
            latest.set(barKey(bar), bar);
          }
        }
        return planBars(instrument, bars, receivedAt, (key) => latest.get(key), sources, head);
      },
      async (client, rows) => {
        const col = <K extends keyof StoredBar>(k: K) => rows.map((r) => r[k]);
        await client.query(
          `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::int[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::boolean[], $15::timestamptz[], $16::timestamptz[], $17::timestamptz[], $18::bigint[], $19::text[])
           AS t(instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
           ORDER BY ingest_seq`,
          [
            col('instrumentId'),
            col('source'),
            col('interval'),
            col('session'),
            col('adjustment'),
            col('startTime'),
            col('endTime'),
            col('revision'),
            rows.map((r) => r.open.toString()),
            rows.map((r) => r.high.toString()),
            rows.map((r) => r.low.toString()),
            rows.map((r) => r.close.toString()),
            rows.map((r) => (r.volume === undefined ? null : r.volume.toString())),
            col('isFinal'),
            col('observedAt'),
            col('availableAt'),
            col('retrievedAt'),
            rows.map((r) => String(r.ingestSeq)),
            col('contentHash'),
          ],
        );
      },
    );
  }

  async readBars(q: BarQuery): Promise<StoredBar[]> {
    const params: unknown[] = [q.instrumentId, q.source, q.interval, q.session, q.adjustment, canonicalUtc(q.asOf), q.storedThrough ?? null, q.from === undefined ? null : canonicalUtc(q.from), q.to === undefined ? null : canonicalUtc(q.to), q.finalOnly ?? true];
    const { rows } = await this.pool.query<BarRow>(
      `SELECT * FROM (
         SELECT DISTINCT ON (start_time) ${BAR_COLUMNS} FROM market_bars
          WHERE instrument_id = $1 AND source_id = $2 AND bar_interval = $3 AND session = $4 AND adjustment = $5
            AND available_at <= $6 AND ($7::bigint IS NULL OR ingest_seq <= $7::bigint)
            AND ($8::timestamptz IS NULL OR start_time >= $8::timestamptz) AND ($9::timestamptz IS NULL OR start_time < $9::timestamptz)
          ORDER BY start_time, revision DESC
       ) v WHERE (NOT $10::boolean OR v.is_final) ORDER BY v.start_time`,
      params,
    );
    return rows.map((r) => {
      const bar = toBar(r);
      assertIntact('bar', barKey(bar), barContentHash(bar), bar.contentHash);
      return bar;
    });
  }

  ingestQuotes(instrument: IngestInstrument, quotes: readonly MarketQuote[], receivedAt: string): Promise<IngestSummary> {
    const sourceIds = [...new Set(quotes.map((q) => (typeof q?.source === 'string' ? q.source : '')))];
    return this.ingest<StoredQuote>(
      instrument.instrumentId,
      sourceIds,
      async (client, head, sources) => {
        const observed: string[] = [];
        for (const q of quotes) {
          try {
            observed.push(canonicalUtc(q.observedAt));
          } catch {
            // quarantined by the planner
          }
        }
        const { rows } = await client.query<QuoteRow>(
          'SELECT DISTINCT ON (source_id, observed_at) ' + QUOTE_COLUMNS + ' FROM market_quotes WHERE instrument_id = $1 AND observed_at = ANY($2::timestamptz[]) ORDER BY source_id, observed_at, revision DESC',
          [instrument.instrumentId, observed],
        );
        const latest = new Map(rows.map((r) => [quoteKey(toQuote(r)), { ...toQuote(r), isFinal: true }]));
        return planQuotes(instrument, quotes, receivedAt, (key) => latest.get(key), sources, head);
      },
      async (client, rows) => {
        for (const r of rows) {
          await client.query(
            'INSERT INTO market_quotes (instrument_id, source_id, observed_at, revision, last_price, bid, ask, open, high, low, previous_close, volume, currency, market_open, available_at, retrieved_at, ingest_seq, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
            [
              r.instrumentId,
              r.source,
              r.observedAt,
              r.revision,
              r.last.toString(),
              r.bid?.toString() ?? null,
              r.ask?.toString() ?? null,
              r.open?.toString() ?? null,
              r.high?.toString() ?? null,
              r.low?.toString() ?? null,
              r.previousClose?.toString() ?? null,
              r.volume?.toString() ?? null,
              r.currency ?? null,
              r.marketOpen ?? null,
              r.availableAt,
              r.retrievedAt,
              String(r.ingestSeq),
              r.contentHash,
            ],
          );
        }
      },
    );
  }

  async latestQuote(q: QuoteQuery): Promise<StoredQuote | null> {
    const { rows } = await this.pool.query<QuoteRow>(
      `SELECT * FROM (
         SELECT DISTINCT ON (source_id, observed_at) ${QUOTE_COLUMNS} FROM market_quotes
          WHERE instrument_id = $1 AND ($2::text IS NULL OR source_id = $2::text) AND available_at <= $3 AND ($4::bigint IS NULL OR ingest_seq <= $4::bigint)
          ORDER BY source_id, observed_at, revision DESC
       ) v ORDER BY v.observed_at DESC, v.source_id LIMIT 1`,
      [q.instrumentId, q.source ?? null, canonicalUtc(q.asOf), q.storedThrough ?? null],
    );
    if (!rows[0]) return null;
    const quote = toQuote(rows[0]);
    assertIntact('quote', quoteKey(quote), quoteContentHash(quote), quote.contentHash);
    return quote;
  }

  ingestCorporateActions(instrument: IngestInstrument, actions: readonly CorporateAction[], receivedAt: string): Promise<IngestSummary> {
    const sourceIds = [...new Set(actions.map((a) => (typeof a?.source === 'string' ? a.source : '')))];
    return this.ingest<StoredCorporateAction>(
      instrument.instrumentId,
      sourceIds,
      async (client, head, sources) => {
        const { rows } = await client.query<ActionRow>(
          'SELECT DISTINCT ON (source_id, action_key) ' + ACTION_COLUMNS + ' FROM corporate_actions WHERE instrument_id = $1 AND action_key = ANY($2::text[]) ORDER BY source_id, action_key, revision DESC',
          [instrument.instrumentId, actions.map((a) => (typeof a?.actionKey === 'string' ? a.actionKey : ''))],
        );
        const latest = new Map(rows.map((r) => [corporateActionKey(toAction(r)), { ...toAction(r), isFinal: true }]));
        return planCorporateActions(instrument, actions, receivedAt, (key) => latest.get(key), sources, head);
      },
      async (client, rows) => {
        for (const a of rows) {
          await client.query(
            'INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, cash_amount, currency, old_symbol, new_symbol, announced_at, available_at, retrieved_at, ingest_seq, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)',
            [
              a.instrumentId,
              a.source,
              a.actionKey,
              a.revision,
              a.type,
              a.exDate,
              a.ratioFrom?.toString() ?? null,
              a.ratioTo?.toString() ?? null,
              a.cashAmount?.toString() ?? null,
              a.currency ?? null,
              a.oldSymbol ?? null,
              a.newSymbol ?? null,
              a.announcedAt ?? null,
              a.availableAt,
              a.retrievedAt,
              String(a.ingestSeq),
              a.contentHash,
            ],
          );
        }
      },
    );
  }

  async readCorporateActions(q: CorporateActionQuery): Promise<StoredCorporateAction[]> {
    const { rows } = await this.pool.query<ActionRow>(
      `SELECT * FROM (
         SELECT DISTINCT ON (source_id, action_key) ${ACTION_COLUMNS} FROM corporate_actions
          WHERE instrument_id = $1 AND ($2::text IS NULL OR source_id = $2::text) AND available_at <= $3 AND ($4::bigint IS NULL OR ingest_seq <= $4::bigint)
          ORDER BY source_id, action_key, revision DESC
       ) v WHERE ($5::text[] IS NULL OR v.type = ANY($5::text[])) ORDER BY v.ex_date_text, v.action_key`,
      [q.instrumentId, q.source ?? null, canonicalUtc(q.asOf), q.storedThrough ?? null, q.types ?? null],
    );
    return rows.map((r) => {
      const a = toAction(r);
      assertIntact('corporate action', corporateActionKey(a), corporateActionContentHash(a), a.contentHash);
      return a;
    });
  }

  async quarantined(instrumentId?: string): Promise<QuarantineRecord[]> {
    const { rows } = await this.pool.query<{ kind: QuarantineRecord['kind']; instrument_id: string; source_id: string; received_at: Date; reasons: QuarantineRecord['reasons']; raw: unknown }>(
      'SELECT kind, instrument_id, source_id, received_at, reasons, raw FROM market_data_quarantine WHERE ($1::text IS NULL OR instrument_id = $1::text) ORDER BY quarantine_id',
      [instrumentId ?? null],
    );
    return rows.map((r) => ({ kind: r.kind, instrumentId: r.instrument_id, source: r.source_id, receivedAt: ts(r.received_at), reasons: r.reasons, raw: r.raw }));
  }

  async head(instrumentId: string): Promise<number> {
    const row = (await this.pool.query<{ h: string }>('SELECT head_seq::text AS h FROM market_data_heads WHERE instrument_id = $1', [instrumentId])).rows[0];
    return row ? Number(row.h) : 0;
  }
}
