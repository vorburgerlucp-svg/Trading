// Market data persistence port + in-memory reference implementation.
//
// Rules shared by every implementation (the PostgreSQL store reuses the planning functions below):
//   * idempotent: re-delivering an identical record changes nothing (status "unchanged")
//   * nothing is overwritten: a different record for the same key becomes a new REVISION
//   * bars: a revision's historical gate (availableAt) is raised to max(given, its knowledge floor, the previous gate) for
//     revisions >= 2. A proven revision is used only from the instant NEXUS held it, in every mode; an unproven one
//     (historical reconstruction, legacy) is labelled, and a strict read refuses it (BAR_VINTAGE_NOT_PROVEN). See bar-replay.ts.
//   * quotes: a revision becomes visible at availableAt, raised to max(availableAt, retrievedAt, previous) for revisions >= 2
//     only (the first revision keeps the provided value; quote finding F10).
//     Corporate actions do not use availableAt at all: their information time is a proven knowledge time (corporate-actions.ts).
//     A provider correction (revision >= 2) therefore never leaks into the past for corporate actions either.
//   * final → in-progress is refused (final_regression); structurally invalid records are quarantined
//   * every stored record gets the next number of a gapless per-instrument ingest sequence.
//     A computation that records `storedThrough` (the sequence it saw) is exactly reproducible,
//     even after later backfills with old availableAt timestamps.

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import {
  barContentHash,
  barKey,
  barProvenanceHash,
  corporateActionContentHash,
  corporateActionProvenanceHash,
  normalizeBar,
  normalizeCorporateAction,
  normalizeQuote,
  quoteContentHash,
  validateBar,
  validateCorporateAction,
  validateQuote,
  type PriceRules,
} from './bar-validation.js';
import { BarVintageNotProvenError, classifyVisibleBar, isProvenKnowledge, knowledgeOf, revisionFloorOf } from './bar-replay.js';
import { selectReplayRevision, type ReplayPurpose } from './corporate-actions.js';
import type {
  BarInterval,
  BarKnowledgeProvenance,
  BarReplayMode,
  BarSession,
  CorporateAction,
  CorporateActionType,
  DataQualityIssue,
  Instrument,
  MarketBar,
  MarketDataSource,
  MarketQuote,
  PriceAdjustment,
  QuarantineRecord,
  StoredBar,
  StoredCorporateAction,
  StoredQuote,
} from './market-data-types.js';
import { parseUtc, toUtcIso } from './time.js';

export type IngestInstrument = Pick<Instrument, 'instrumentId'> & PriceRules;

export interface IngestSummary {
  /** New rows (first revisions and new revisions). */
  inserted: number;
  unchanged: number;
  /** Changed content of a record that was already final (provider correction). */
  providerRevisions: number;
  quarantined: QuarantineRecord[];
  /** Ingest sequence of the instrument after this call. */
  headSeq: number;
}

export interface BarQuery {
  instrumentId: string;
  source: string;
  interval: BarInterval;
  session: BarSession;
  adjustment: PriceAdjustment;
  /** Bar start range [from, to). */
  from?: string;
  to?: string;
  /** Point in time: only revisions with availableAt <= asOf. Required: there is no "whatever is newest" read. */
  asOf: string;
  /** Reproducibility anchor: only rows with ingestSeq <= storedThrough. */
  storedThrough?: number;
  /** Default true: in-progress bars are excluded (no repainting). */
  finalOnly?: boolean;
  /**
   * historical_reconstruction (default): unproven revisions are used at their historical gate, labelled by their provenance.
   * strict_point_in_time: an unproven visible revision makes the read throw BarVintageNotProvenError (fail closed).
   * In both modes a proven revision is used only from the instant NEXUS held it.
   */
  replay?: BarReplayMode;
}

export interface QuoteQuery {
  instrumentId: string;
  source?: string;
  asOf: string;
  storedThrough?: number;
}

export interface CorporateActionQuery {
  instrumentId: string;
  source?: string;
  asOf: string;
  storedThrough?: number;
  types?: CorporateActionType[];
  /**
   * information (default): what was provably known by asOf. Strict; the only purpose that may feed strategy, quant or scanner.
   * economic: what happened, ex-post, labelled by provenance. For accounting only.
   */
  purpose?: ReplayPurpose;
}

export interface MarketDataStore {
  registerSource(source: MarketDataSource): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  getSource(sourceId: string): Promise<MarketDataSource | null>;
  ingestBars(instrument: IngestInstrument, bars: readonly MarketBar[], receivedAt: string): Promise<IngestSummary>;
  readBars(query: BarQuery): Promise<StoredBar[]>;
  ingestQuotes(instrument: IngestInstrument, quotes: readonly MarketQuote[], receivedAt: string): Promise<IngestSummary>;
  latestQuote(query: QuoteQuery): Promise<StoredQuote | null>;
  ingestCorporateActions(instrument: IngestInstrument, actions: readonly CorporateAction[], receivedAt: string): Promise<IngestSummary>;
  readCorporateActions(query: CorporateActionQuery): Promise<StoredCorporateAction[]>;
  quarantined(instrumentId?: string): Promise<QuarantineRecord[]>;
  /** Current ingest sequence of an instrument (0 = nothing stored). Use it as storedThrough. */
  head(instrumentId: string): Promise<number>;
}

export class MarketDataStoreError extends Error {
  override readonly name = 'MarketDataStoreError';
  constructor(
    readonly code: 'unknown_source' | 'source_conflict' | 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** A stored record no longer matches its content hash: fail closed. */
export class MarketDataIntegrityError extends Error {
  override readonly name = 'MarketDataIntegrityError';
  readonly code = 'MARKET_DATA_INTEGRITY_ERROR' as const;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;

export function validateSource(source: MarketDataSource): void {
  if (!source || !SOURCE_ID.test(source.sourceId)) throw new MarketDataStoreError('invalid', 'sourceId must match ' + SOURCE_ID.source);
  if (typeof source.provider !== 'string' || source.provider.trim() === '' || typeof source.dataset !== 'string' || source.dataset.trim() === '') throw new MarketDataStoreError('invalid', 'provider and dataset are required');
  if (!['production', 'demo', 'test_fixture'].includes(source.environment)) throw new MarketDataStoreError('invalid', 'unknown environment');
  if (!['internal_use', 'display_allowed', 'redistributable', 'not_redistributable', 'unreviewed'].includes(source.license)) throw new MarketDataStoreError('invalid', 'unknown license class');
}

export function sourceHash(source: MarketDataSource): string {
  return hashOf({ sourceId: source.sourceId, provider: source.provider, dataset: source.dataset, environment: source.environment, license: source.license, licenseNote: source.licenseNote ?? null });
}

/** JSON-safe, bounded copy of an untrusted record for the quarantine (never interpreted). */
export function toRawData(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Decimal) return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(/\u0000/g, '').slice(0, 1000);
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => toRawData(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[k.slice(0, 100)] = toRawData(v, depth + 1);
    return out;
  }
  return String(value).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Shared ingest planning
// ---------------------------------------------------------------------------

export interface Revisioned {
  revision: number;
  availableAt: string;
  contentHash: string;
}

export interface PlannedRow<T> {
  key: string;
  row: T;
}

export interface IngestPlan<T> {
  rows: PlannedRow<T>[];
  unchanged: number;
  providerRevisions: number;
  quarantined: QuarantineRecord[];
}

interface PlanSpec<In, Out> {
  kind: QuarantineRecord['kind'];
  instrument: IngestInstrument;
  receivedAt: string;
  validate: (record: In) => DataQualityIssue[];
  normalize: (record: In) => In;
  instrumentOf: (record: In) => string;
  sourceOf: (record: In) => string;
  keyOf: (record: In) => string;
  hashOf: (record: In) => string;
  isFinal: (record: In) => boolean;
  sortValue: (record: In) => number;
  /** Availability of a later revision (default: max(given, retrievedAt, previous)). Bars floor it by their revision knowledge. */
  revisionAvailability?: (record: In, previous: Revisioned) => string;
  /** Extra checks against the previous revision of the same key; issues quarantine the new revision. */
  againstPrevious?: (record: In, previous: Revisioned & { isFinal: boolean }) => DataQualityIssue[];
  build: (record: In, revision: number, availableAt: string, contentHash: string, ingestSeq: number) => Out;
}

/** Decides what to store; `latest` returns the newest stored revision of a key (or undefined). */
export function planIngest<In extends { availableAt: string; retrievedAt: string }, Out>(
  records: readonly In[],
  latest: (key: string) => (Revisioned & { isFinal: boolean }) | undefined,
  knownSources: ReadonlySet<string>,
  nextSeq: number,
  spec: PlanSpec<In, Out>,
): IngestPlan<Out> {
  const quarantined: QuarantineRecord[] = [];
  const quarantine = (record: unknown, reasons: DataQualityIssue[], source = '?') =>
    quarantined.push({ kind: spec.kind, instrumentId: spec.instrument.instrumentId, source, receivedAt: spec.receivedAt, reasons, raw: toRawData(record) });

  // 1. structure, ownership, source
  const candidates: In[] = [];
  for (const record of records) {
    const issues = spec.validate(record);
    if (issues.length > 0) {
      const claimedSource = (record as unknown as { source?: unknown } | null)?.source;
      quarantine(record, issues, typeof claimedSource === 'string' ? claimedSource.slice(0, 128) : '?');
      continue;
    }
    const normalized = spec.normalize(record);
    if (spec.instrumentOf(normalized) !== spec.instrument.instrumentId) {
      quarantine(record, [{ code: 'mixed_series', severity: 'critical', message: 'record belongs to another instrument' }], spec.sourceOf(normalized));
      continue;
    }
    if (!knownSources.has(spec.sourceOf(normalized))) throw new MarketDataStoreError('unknown_source', 'register source ' + spec.sourceOf(normalized) + ' before ingesting its data');
    candidates.push(normalized);
  }

  // 2. duplicates inside the batch: identical → once; conflicting → all quarantined (no guessing)
  const byKey = new Map<string, In[]>();
  for (const r of candidates) {
    const k = spec.keyOf(r);
    const group = byKey.get(k);
    if (group) group.push(r);
    else byKey.set(k, [r]);
  }
  const accepted: In[] = [];
  for (const [, group] of byKey) {
    const hashes = new Set(group.map(spec.hashOf));
    if (hashes.size > 1) {
      for (const r of group) quarantine(r, [{ code: 'conflicting_duplicate', severity: 'critical', message: 'the same delivery contains different versions of this record' }], spec.sourceOf(r));
      continue;
    }
    accepted.push(group[0]!);
  }
  accepted.sort((a, b) => spec.sortValue(a) - spec.sortValue(b) || (spec.keyOf(a) < spec.keyOf(b) ? -1 : 1));

  // 3. against storage
  const rows: PlannedRow<Out>[] = [];
  let unchanged = 0;
  let providerRevisions = 0;
  let seq = nextSeq;
  for (const r of accepted) {
    const key = spec.keyOf(r);
    const contentHash = spec.hashOf(r);
    const prev = latest(key);
    if (prev && prev.contentHash === contentHash) {
      unchanged++;
      continue;
    }
    if (prev && prev.isFinal && !spec.isFinal(r)) {
      quarantine(r, [{ code: 'final_regression', severity: 'critical', message: 'a final record cannot be replaced by an in-progress version' }], spec.sourceOf(r));
      continue;
    }
    if (prev && spec.againstPrevious) {
      const conflicts = spec.againstPrevious(r, prev);
      if (conflicts.length > 0) {
        quarantine(r, conflicts, spec.sourceOf(r));
        continue;
      }
    }
    let availableAt = r.availableAt;
    if (prev) {
      // A new revision is only known from the moment NEXUS retrieved it (or, when it proves more, from that proof).
      availableAt = spec.revisionAvailability ? spec.revisionAvailability(r, prev) : toUtcIso(Math.max(parseUtc(r.availableAt), parseUtc(r.retrievedAt), parseUtc(prev.availableAt)));
      if (prev.isFinal) providerRevisions++;
    }
    rows.push({ key, row: spec.build(r, prev ? prev.revision + 1 : 1, availableAt, contentHash, ++seq) });
  }
  return { rows, unchanged, providerRevisions, quarantined };
}

export function planBars(instrument: IngestInstrument, bars: readonly MarketBar[], receivedAt: string, latest: (key: string) => StoredBar | undefined, sources: ReadonlySet<string>, nextSeq: number): IngestPlan<StoredBar> {
  return planIngest<MarketBar, StoredBar>(bars, latest, sources, nextSeq, {
    kind: 'bar',
    instrument,
    receivedAt,
    validate: (b) => validateBar(b, instrument, { ingest: true }),
    normalize: (b) => normalizeBar(b),
    instrumentOf: (b) => b.instrumentId,
    sourceOf: (b) => b.source,
    keyOf: barKey,
    hashOf: barContentHash,
    isFinal: (b) => b.isFinal,
    sortValue: (b) => parseUtc(b.startTime),
    // A later revision is visible from the later of its own gate, its knowledge floor and the previous revision.
    revisionAvailability: (b, previous) => toUtcIso(Math.max(parseUtc(b.availableAt), parseUtc(revisionFloorOf(b)), parseUtc(previous.availableAt))),
    againstPrevious: (b, previous) => knowledgeRegression(b, previous as StoredBar),
    build: (b, revision, availableAt, contentHash, ingestSeq) => storedBar({ ...stripBar(b), availableAt, revision, contentHash, ingestSeq }),
  });
}

/** A proven revision cannot be known before an earlier proven revision of the same bar: knowledge only moves forward. */
function knowledgeRegression(record: MarketBar, previous: StoredBar): DataQualityIssue[] {
  const now = knowledgeOf(record);
  const before = knowledgeOf(previous);
  if (isProvenKnowledge(now) && isProvenKnowledge(before) && parseUtc(now.revisionKnownAt!) < parseUtc(before.revisionKnownAt!)) {
    return [{ code: 'invalid_time', severity: 'critical', message: 'a later revision cannot be known before an earlier proven revision (knowledge would move backwards)' }];
  }
  return [];
}

function storedBar(stored: Omit<StoredBar, 'provenanceHash'>): StoredBar {
  const withoutHash: Omit<StoredBar, 'provenanceHash'> = stored;
  return { ...withoutHash, provenanceHash: barProvenanceHash(withoutHash) };
}

/** Integrity of the provenance fields of a stored bar. Rows without a hash (legacy) have nothing to verify. */
export function assertBarProvenanceIntact(b: StoredBar): void {
  if (b.provenanceHash === null) return;
  assertIntact('bar provenance', barKey(b), barProvenanceHash(b), b.provenanceHash);
}

export function quoteKey(q: Pick<MarketQuote, 'instrumentId' | 'source' | 'observedAt'>): string {
  return [q.instrumentId, q.source, q.observedAt].join('|');
}

export function planQuotes(instrument: IngestInstrument, quotes: readonly MarketQuote[], receivedAt: string, latest: (key: string) => (StoredQuote & { isFinal: boolean }) | undefined, sources: ReadonlySet<string>, nextSeq: number): IngestPlan<StoredQuote> {
  return planIngest<MarketQuote, StoredQuote>(quotes, latest, sources, nextSeq, {
    kind: 'quote',
    instrument,
    receivedAt,
    validate: (q) => validateQuote(q, instrument),
    normalize: (q) => normalizeQuote(q),
    instrumentOf: (q) => q.instrumentId,
    sourceOf: (q) => q.source,
    keyOf: quoteKey,
    hashOf: quoteContentHash,
    isFinal: () => true,
    sortValue: (q) => parseUtc(q.observedAt),
    build: (q, revision, availableAt, contentHash, ingestSeq) => ({ ...q, availableAt, revision, contentHash, ingestSeq }),
  });
}

export function corporateActionKey(a: Pick<CorporateAction, 'instrumentId' | 'source' | 'actionKey'>): string {
  return [a.instrumentId, a.source, a.actionKey].join('|');
}

/** The planner's view of a corporate action: the record plus its storage time (never a knowledge time). */
type PlannedCorporateAction = CorporateAction & { availableAt: string };

/**
 * Storage visibility of a NEW record is its retrieval: NEXUS holds it from then on. Provider claims never set it (the earlier
 * `min(retrievedAt, exDate)` rule did, and made late-retrieved actions look known on their ex-date: review finding F1).
 * The shared planner works on that storage time; it is stored as storedAvailableAt and is never used as knowledge.
 */
export function planCorporateActions(
  instrument: IngestInstrument,
  actions: readonly CorporateAction[],
  receivedAt: string,
  latest: (key: string) => (StoredCorporateAction & { isFinal: boolean }) | undefined,
  sources: ReadonlySet<string>,
  nextSeq: number,
): IngestPlan<StoredCorporateAction> {
  const planned: PlannedCorporateAction[] = actions.map((a) => ({ ...a, availableAt: a.retrievedAt }));
  const latestPlanned = (key: string) => {
    const prev = latest(key);
    return prev === undefined ? undefined : { ...prev, availableAt: prev.storedAvailableAt };
  };
  return planIngest<PlannedCorporateAction, StoredCorporateAction>(planned, latestPlanned, sources, nextSeq, {
    kind: 'corporate_action',
    instrument,
    receivedAt,
    validate: (a) => {
      const issues = validateCorporateAction(a);
      // The capture cannot be later than the moment NEXUS stored it: that would make its knowledge time a future claim.
      if (parseUtc(a.retrievedAt) > parseUtc(receivedAt)) issues.push({ code: 'future_timestamp', severity: 'critical', message: 'retrievedAt is after the time the record was received' });
      return issues;
    },
    normalize: (a) => {
      const n = normalizeCorporateAction(a);
      return { ...n, availableAt: n.retrievedAt };
    },
    instrumentOf: (a) => a.instrumentId,
    sourceOf: (a) => a.source,
    keyOf: corporateActionKey,
    hashOf: corporateActionContentHash,
    isFinal: () => true,
    sortValue: (a) => Date.parse(a.exDate + 'T00:00:00Z'),
    build: (a, revision, storageAt, contentHash, ingestSeq) => storedCorporateAction(a, storageAt, revision, contentHash, ingestSeq),
  });
}

function storedCorporateAction(planned: PlannedCorporateAction, storedAvailableAt: string, revision: number, contentHash: string, ingestSeq: number): StoredCorporateAction {
  const { availableAt: _storageInput, ...economic } = planned;
  const stored: StoredCorporateAction = { ...economic, storedAvailableAt, revision, contentHash, ingestSeq, provenanceHash: null };
  return { ...stored, provenanceHash: corporateActionProvenanceHash(stored) };
}

/** Integrity of the retrieval and knowledge fields of a stored record. Legacy rows (no provenance hash) have nothing to verify. */
export function assertProvenanceIntact(a: StoredCorporateAction): void {
  if (a.provenanceHash === null) return;
  assertIntact('corporate action provenance', corporateActionKey(a), corporateActionProvenanceHash(a), a.provenanceHash);
}

/** Keeps only the MarketBar fields (callers may pass StoredBar or richer objects). */
function stripBar(b: MarketBar): MarketBar {
  return {
    instrumentId: b.instrumentId,
    interval: b.interval,
    startTime: b.startTime,
    endTime: b.endTime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ...(b.volume !== undefined ? { volume: b.volume } : {}),
    source: b.source,
    session: b.session,
    adjustment: b.adjustment,
    isFinal: b.isFinal,
    observedAt: b.observedAt,
    availableAt: b.availableAt,
    retrievedAt: b.retrievedAt,
    knowledge: { provenance: b.knowledge.provenance, revisionKnownAt: b.knowledge.revisionKnownAt },
  };
}

/** Point-in-time selection: per key the newest revision visible at asOf/storedThrough. */
export function visibleRevision<T extends { revision: number; availableAt: string; ingestSeq: number }>(revisions: readonly T[], asOfMs: number, storedThrough: number): T | undefined {
  let best: T | undefined;
  for (const r of revisions) {
    if (r.ingestSeq > storedThrough || parseUtc(r.availableAt) > asOfMs) continue;
    if (!best || r.revision > best.revision) best = r;
  }
  return best;
}

/** Re-checks a stored row against its content hash (fail closed on tampering). */
export function assertIntact(kind: string, key: string, actual: string, expected: string): void {
  if (actual !== expected) throw new MarketDataIntegrityError(kind + ' ' + key + ' does not match its content hash (stored data was altered)');
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface InstrumentData {
  seq: number;
  bars: Map<string, StoredBar[]>;
  quotes: Map<string, StoredQuote[]>;
  actions: Map<string, StoredCorporateAction[]>;
}

export class InMemoryMarketDataStore implements MarketDataStore {
  private readonly sources = new Map<string, MarketDataSource>();
  private readonly data = new Map<string, InstrumentData>();
  private readonly quarantine: QuarantineRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private exclusive<R>(work: () => R): Promise<R> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private of(instrumentId: string): InstrumentData {
    let d = this.data.get(instrumentId);
    if (!d) {
      d = { seq: 0, bars: new Map(), quotes: new Map(), actions: new Map() };
      this.data.set(instrumentId, d);
    }
    return d;
  }

  registerSource(source: MarketDataSource): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    return this.exclusive(() => {
      validateSource(source);
      const existing = this.sources.get(source.sourceId);
      if (existing) {
        if (sourceHash(existing) !== sourceHash(source)) throw new MarketDataStoreError('source_conflict', 'source ' + source.sourceId + ' is already registered with different metadata');
        return 'ALREADY_APPLIED';
      }
      this.sources.set(source.sourceId, { ...source });
      return 'APPLIED';
    });
  }

  async getSource(sourceId: string): Promise<MarketDataSource | null> {
    const s = this.sources.get(sourceId);
    return s ? { ...s } : null;
  }

  private commit<T extends { ingestSeq: number }>(target: Map<string, T[]>, d: InstrumentData, plan: IngestPlan<T>): IngestSummary {
    for (const { key, row } of plan.rows) {
      const revisions = target.get(key);
      if (revisions) revisions.push(Object.freeze({ ...row }));
      else target.set(key, [Object.freeze({ ...row })]);
      d.seq = row.ingestSeq;
    }
    this.quarantine.push(...plan.quarantined);
    return { inserted: plan.rows.length, unchanged: plan.unchanged, providerRevisions: plan.providerRevisions, quarantined: plan.quarantined, headSeq: d.seq };
  }

  ingestBars(instrument: IngestInstrument, bars: readonly MarketBar[], receivedAt: string): Promise<IngestSummary> {
    return this.exclusive(() => {
      const d = this.of(instrument.instrumentId);
      const plan = planBars(instrument, bars, receivedAt, (key) => d.bars.get(key)?.at(-1), new Set(this.sources.keys()), d.seq);
      return this.commit(d.bars, d, plan);
    });
  }

  async readBars(q: BarQuery): Promise<StoredBar[]> {
    const d = this.data.get(q.instrumentId);
    if (!d) return [];
    const asOf = parseUtc(q.asOf);
    const storedThrough = q.storedThrough ?? Number.POSITIVE_INFINITY;
    const replay = q.replay ?? 'historical_reconstruction';
    const from = q.from === undefined ? Number.NEGATIVE_INFINITY : parseUtc(q.from);
    const to = q.to === undefined ? Number.POSITIVE_INFINITY : parseUtc(q.to);
    const out: StoredBar[] = [];
    const refused: Array<{ instrumentId: string; startTime: string; provenance: BarKnowledgeProvenance }> = [];
    for (const revisions of d.bars.values()) {
      const first = revisions[0]!;
      if (first.source !== q.source || first.interval !== q.interval || first.session !== q.session || first.adjustment !== q.adjustment) continue;
      const start = parseUtc(first.startTime);
      if (start < from || start >= to) continue;
      const v = visibleRevision(revisions, asOf, storedThrough);
      if (!v) continue;
      assertIntact('bar', barKey(v), barContentHash(v), v.contentHash);
      assertBarProvenanceIntact(v);
      if ((q.finalOnly ?? true) && !v.isFinal) continue;
      const state = classifyVisibleBar(v, asOf);
      if (state === 'not_yet_held') continue;
      if (state === 'unproven' && replay === 'strict_point_in_time') {
        refused.push({ instrumentId: v.instrumentId, startTime: v.startTime, provenance: knowledgeOf(v).provenance });
        continue;
      }
      out.push(v);
    }
    if (refused.length > 0) throw new BarVintageNotProvenError(refused);
    return out.sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
  }

  ingestQuotes(instrument: IngestInstrument, quotes: readonly MarketQuote[], receivedAt: string): Promise<IngestSummary> {
    return this.exclusive(() => {
      const d = this.of(instrument.instrumentId);
      const plan = planQuotes(instrument, quotes, receivedAt, (key) => withFinal(d.quotes.get(key)?.at(-1)), new Set(this.sources.keys()), d.seq);
      return this.commit(d.quotes, d, plan);
    });
  }

  async latestQuote(q: QuoteQuery): Promise<StoredQuote | null> {
    const d = this.data.get(q.instrumentId);
    if (!d) return null;
    const asOf = parseUtc(q.asOf);
    let best: StoredQuote | null = null;
    for (const revisions of d.quotes.values()) {
      if (q.source !== undefined && revisions[0]!.source !== q.source) continue;
      const v = visibleRevision(revisions, asOf, q.storedThrough ?? Number.POSITIVE_INFINITY);
      if (v && (!best || parseUtc(v.observedAt) > parseUtc(best.observedAt))) best = v;
    }
    if (best) assertIntact('quote', quoteKey(best), quoteContentHash(best), best.contentHash);
    return best;
  }

  ingestCorporateActions(instrument: IngestInstrument, actions: readonly CorporateAction[], receivedAt: string): Promise<IngestSummary> {
    return this.exclusive(() => {
      const d = this.of(instrument.instrumentId);
      const plan = planCorporateActions(instrument, actions, receivedAt, (key) => {
        const prev = d.actions.get(key)?.at(-1);
        return prev === undefined ? undefined : { ...prev, isFinal: true };
      }, new Set(this.sources.keys()), d.seq);
      return this.commit(d.actions, d, plan);
    });
  }

  async readCorporateActions(q: CorporateActionQuery): Promise<StoredCorporateAction[]> {
    const d = this.data.get(q.instrumentId);
    if (!d) return [];
    const out: StoredCorporateAction[] = [];
    for (const revisions of d.actions.values()) {
      if (q.source !== undefined && revisions[0]!.source !== q.source) continue;
      const v = selectReplayRevision(revisions, { asOf: q.asOf, storedThrough: q.storedThrough ?? Number.POSITIVE_INFINITY, purpose: q.purpose ?? 'information' });
      if (!v || (q.types && !q.types.includes(v.type))) continue;
      assertIntact('corporate action', corporateActionKey(v), corporateActionContentHash(v), v.contentHash);
      assertProvenanceIntact(v);
      out.push(v);
    }
    return out.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : a.actionKey < b.actionKey ? -1 : 1));
  }

  async quarantined(instrumentId?: string): Promise<QuarantineRecord[]> {
    return this.quarantine.filter((r) => instrumentId === undefined || r.instrumentId === instrumentId).map((r) => ({ ...r }));
  }

  async head(instrumentId: string): Promise<number> {
    return this.data.get(instrumentId)?.seq ?? 0;
  }

  /** TEST ONLY: simulates a privileged write that alters a stored bar behind NEXUS' back. */
  tamperBarForTest(instrumentId: string, startTime: string, replace: (bar: StoredBar) => StoredBar): void {
    for (const revisions of this.data.get(instrumentId)?.bars.values() ?? []) {
      const i = revisions.length - 1;
      if (revisions[i]!.startTime === startTime) revisions[i] = replace(revisions[i]!);
    }
  }
}

function withFinal<T extends Revisioned>(row: T | undefined): (T & { isFinal: boolean }) | undefined {
  return row ? { ...row, isFinal: true } : undefined;
}
