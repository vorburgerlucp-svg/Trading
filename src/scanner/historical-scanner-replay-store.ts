// O9 replay persistence and integrity (historical-scanner-replay:v1). Every replay is verified before it is saved and again before it is returned.
// The verifier fails closed on any inconsistency and never repairs a record. The in-memory store is the reference implementation of the append-only
// contract; a PostgreSQL store is a follow-up.
//
// What the verifier proves from the stored result: the replay id from the input fingerprint, each scanner run id from its own fingerprint, the canonical
// schedule and anchors, the pinned child anchors, and the internal consistency of every step. What it cannot prove: the input fingerprint itself. The replay
// does not persist the scanner definition, the series or the quant parameters, so the fingerprint is checked in form and through the replay id only.
// The stored payload's hash and its evidence seal bind the record as it was stored; they do not show that the algorithm produced it.

import { parseUtc, toUtcIso } from '../market-data/time.js';
import { hashOf } from '../persistence/canonical-json.js';
import { decodeJson, encodeJson } from '../persistence/json-codec.js';
import { EvidenceSealIntegrityError, isoMs, sealFor, verifySeal, type EvidenceSeal, type Sealed } from '../persistence/evidence-seal.js';
import { HISTORICAL_SCANNER_REPLAY_VERSION, type HistoricalScannerReplayResult } from './historical-scanner-replay.js';

const SEAL_KIND = 'historical_scanner_replay' as const;
const HEX64 = /^[0-9a-f]{64}$/;

export class HistoricalScannerReplayConflictError extends Error {
  override readonly name = 'HistoricalScannerReplayConflictError';
}

export class HistoricalScannerReplayIntegrityError extends Error {
  override readonly name = 'HistoricalScannerReplayIntegrityError';
}

export interface HistoricalScannerReplayStore {
  save(result: HistoricalScannerReplayResult): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  get(replayRunId: string): Promise<HistoricalScannerReplayResult | null>;
  /** The replay with its commit seal. */
  getSealed(replayRunId: string): Promise<Sealed<HistoricalScannerReplayResult> | null>;
}

/** One stored row of the in-memory table: the lossless JSON payload, its hash and its seal. */
export interface HistoricalScannerReplayRow {
  payload: string;
  resultHash: string;
  seal: EvidenceSeal;
}

function fail(message: string): never {
  throw new HistoricalScannerReplayIntegrityError(message);
}

const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isAnchor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isHash = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value);
const compareCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonicalInstantMs(value: unknown, label: string): number {
  if (typeof value !== 'string') fail(label + ' is not a canonical UTC instant');
  let ms: number;
  try {
    ms = parseUtc(value);
  } catch {
    fail(label + ' is not a canonical UTC instant');
  }
  if (toUtcIso(ms) !== value) fail(label + ' is not a canonical UTC instant');
  return ms;
}

/**
 * Recomputes every identity the stored result carries and checks it against the result itself. Any inconsistency throws; nothing is repaired.
 * The ordering rules are the replay's own: scanner members are sorted by code unit, and market anchors by the locale comparison the replay uses.
 */
export function verifyHistoricalScannerReplayResult(result: HistoricalScannerReplayResult): HistoricalScannerReplayResult {
  if (result.engineVersion !== HISTORICAL_SCANNER_REPLAY_VERSION) fail('engine version is not ' + HISTORICAL_SCANNER_REPLAY_VERSION);
  if (!isHash(result.inputFingerprint)) fail('invalid input fingerprint');
  if (result.replayRunId !== 'hsr_' + result.inputFingerprint.slice(0, 40)) fail('replayRunId does not match the input fingerprint');
  if (!isNonEmpty(result.definitionId) || !isNonEmpty(result.definitionVersion)) fail('scanner definition identity is empty');
  if (!isNonEmpty(result.universeId) || !isNonEmpty(result.universeSourceId)) fail('universe identity is empty');
  if (result.replay !== 'historical_research' && result.replay !== 'decision_time') fail('unknown replay mode');
  if (!isAnchor(result.universeStoredThrough)) fail('universeStoredThrough must be a non-negative safe integer');

  if (!Array.isArray(result.asOf) || result.asOf.length === 0) fail('replay schedule is empty');
  let previous = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < result.asOf.length; index++) {
    const ms = canonicalInstantMs(result.asOf[index], 'asOf[' + index + ']');
    if (ms <= previous) fail('asOf must be strictly increasing (asOf[' + index + '])');
    previous = ms;
  }

  const anchors = result.marketStoredThroughByInstrument;
  if (typeof anchors !== 'object' || anchors === null || Array.isArray(anchors)) fail('market anchors are missing');
  const instrumentIds = Object.keys(anchors);
  for (const instrumentId of instrumentIds) {
    if (!isAnchor(anchors[instrumentId])) fail('market anchor ' + instrumentId + ' must be a non-negative safe integer');
  }
  const canonicalOrder = [...instrumentIds].sort(compareCodeUnit);
  if (instrumentIds.some((instrumentId, index) => instrumentId !== canonicalOrder[index])) fail('market anchor keys are not in canonical order');
  // An own property only: an inherited name such as "constructor" is never a pinned anchor.
  const pinnedAnchor = (instrumentId: string): number | undefined =>
    Object.prototype.hasOwnProperty.call(anchors, instrumentId) ? anchors[instrumentId] : undefined;

  if (!Array.isArray(result.steps) || result.steps.length !== result.asOf.length) fail('number of steps does not match the replay schedule');
  const scannerRunIds = new Set<string>();
  for (let index = 0; index < result.steps.length; index++) {
    const step = result.steps[index]!;
    const at = 'step ' + index;
    if (step.asOf !== result.asOf[index]) fail(at + ' asOf does not match the replay asOf at that position');
    if (!isHash(step.scannerInputFingerprint)) fail(at + ' scanner input fingerprint is invalid');
    if (step.scannerRunId !== 'scan_' + step.scannerInputFingerprint.slice(0, 40)) fail(at + ' scannerRunId does not match its scanner input fingerprint');
    if (scannerRunIds.has(step.scannerRunId)) fail('duplicate scannerRunId ' + step.scannerRunId);
    scannerRunIds.add(step.scannerRunId);
    if (!isHash(step.universeFingerprint)) fail(at + ' universe fingerprint is not a 64-character hash');
    if (step.universeSnapshotRevisionId !== null && !isNonEmpty(step.universeSnapshotRevisionId)) fail(at + ' universe snapshot revision is invalid');
    if (typeof step.rankingComplete !== 'boolean') fail(at + ' ranking flag is not a boolean');

    if (!Array.isArray(step.quantRunIds)) fail(at + ' quant references are missing');
    const quantInstruments = new Set<string>();
    let previousInstrument: string | null = null;
    for (const ref of step.quantRunIds) {
      if (!isNonEmpty(ref?.instrumentId) || !isNonEmpty(ref?.quantRunId)) fail(at + ' has an incomplete quant reference');
      if (quantInstruments.has(ref.instrumentId)) fail('quant instrument ' + ref.instrumentId + ' appears more than once in ' + at);
      if (previousInstrument !== null && ref.instrumentId < previousInstrument) fail(at + ' quantRunIds are not sorted by instrumentId');
      quantInstruments.add(ref.instrumentId);
      previousInstrument = ref.instrumentId;
      const pinned = pinnedAnchor(ref.instrumentId);
      if (pinned === undefined) fail('quant instrument ' + ref.instrumentId + ' has no pinned market anchor');
      if (ref.storedThrough !== pinned) fail('quant instrument ' + ref.instrumentId + ' storedThrough does not match its pinned anchor');
    }

    // Candidates come from the snapshots of this step's quant runs, so each one must have a quant run in the same step. Their order is the rank order,
    // which is not alphabetical: it is kept as produced.
    if (!Array.isArray(step.candidateInstrumentIds)) fail(at + ' candidates are missing');
    const candidates = new Set<string>();
    for (const instrumentId of step.candidateInstrumentIds) {
      if (candidates.has(instrumentId)) fail('duplicate candidate instrument ' + instrumentId + ' in ' + at);
      if (!quantInstruments.has(instrumentId)) fail('candidate ' + instrumentId + ' has no quant run in its step');
      candidates.add(instrumentId);
    }
  }
  return result;
}

/** A stored row is decoded, hashed and verified again. A row that no longer matches its hash, or sits under another id, is refused, never repaired. */
function loadRow(replayRunId: string, row: HistoricalScannerReplayRow): HistoricalScannerReplayResult {
  let record: HistoricalScannerReplayResult;
  try {
    record = decodeJson(JSON.parse(row.payload)) as HistoricalScannerReplayResult;
  } catch {
    fail('stored payload is not valid JSON');
  }
  let recomputed: string;
  try {
    recomputed = hashOf(record);
  } catch {
    fail('stored payload cannot be hashed');
  }
  if (recomputed !== row.resultHash) fail('stored payload hash mismatch (the record was altered after it was stored)');
  if (record.replayRunId !== replayRunId) fail('stored record is not stored under its own replayRunId');
  return verifyHistoricalScannerReplayResult(record);
}

function sealOf(replayRunId: string, row: HistoricalScannerReplayRow): EvidenceSeal {
  try {
    return verifySeal(row.seal, { kind: SEAL_KIND, recordId: replayRunId, resultHash: row.resultHash });
  } catch (error) {
    if (error instanceof EvidenceSealIntegrityError) fail(error.message);
    throw error;
  }
}

/**
 * Append-only in memory. The first save stores a lossless JSON payload and a seal. The same content again is ALREADY_APPLIED. A different result under
 * the same replayRunId is a conflict. Reads decode a fresh copy, so no caller can change the stored record.
 */
export class InMemoryHistoricalScannerReplayStore implements HistoricalScannerReplayStore {
  private readonly rows: Map<string, HistoricalScannerReplayRow>;
  private readonly clock: () => Date;

  /** `rows` is the table itself. A caller that passes it can read or alter the rows directly; the tests use it to prove that reads detect tampering. */
  constructor(options: { clock?: () => Date; rows?: Map<string, HistoricalScannerReplayRow> } = {}) {
    this.rows = options.rows ?? new Map();
    this.clock = options.clock ?? (() => new Date());
  }

  async save(result: HistoricalScannerReplayResult): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyHistoricalScannerReplayResult(result);
    const resultHash = hashOf(result);
    const existing = this.rows.get(result.replayRunId);
    if (existing) {
      // The stored row is verified before it is compared, so a tampered row is never reported as already applied.
      loadRow(result.replayRunId, existing);
      sealOf(result.replayRunId, existing);
      if (existing.resultHash !== resultHash) throw new HistoricalScannerReplayConflictError('historical scanner replay already exists with different content');
      return 'ALREADY_APPLIED';
    }
    // Test double for the database: recordedAt is read before the "commit", sealedAt after it (see evidence-seal.ts).
    const recordedAt = isoMs(this.clock());
    const payload = JSON.stringify(encodeJson(result));
    const sealedAt = isoMs(this.clock());
    const seal = sealFor({ kind: SEAL_KIND, recordId: result.replayRunId, resultHash, recordedAt, sealedAt });
    this.rows.set(result.replayRunId, { payload, resultHash, seal });
    return 'APPLIED';
  }

  async getSealed(replayRunId: string): Promise<Sealed<HistoricalScannerReplayResult> | null> {
    const row = this.rows.get(replayRunId);
    if (!row) return null;
    return { record: loadRow(replayRunId, row), seal: sealOf(replayRunId, row) };
  }

  async get(replayRunId: string): Promise<HistoricalScannerReplayResult | null> {
    return (await this.getSealed(replayRunId))?.record ?? null;
  }
}
