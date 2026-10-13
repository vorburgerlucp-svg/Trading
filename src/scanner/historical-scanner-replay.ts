import type { BarReplayMode, BarInterval, BarSession, PriceAdjustment } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { QuantParameters, QuantRunRecord } from '../quant/quant-types.js';
import type { QuantRunRequest } from '../quant/quant-service.js';
import { runMarketScanner } from './market-scanner.js';
import type { ScannerDefinition, ScannerRun, ScannerSnapshot } from './scanner-types.js';
import type { UniverseSelection } from '../universe/universe-model.js';
import type { UniverseSelectionQuery } from '../universe/universe-store.js';

export const HISTORICAL_SCANNER_REPLAY_VERSION = 'historical-scanner-replay:v1' as const;
export const SCANNER_SNAPSHOT_POLICY_VERSION = 'scanner-snapshot:v1' as const;

export interface HistoricalScannerReplaySeries {
  source: string;
  interval: BarInterval;
  session: BarSession;
  adjustment: PriceAdjustment;
}

export interface HistoricalScannerReplayRequest {
  definition: ScannerDefinition;
  asOf: readonly string[];
  universeId: string;
  universeSourceId: string;
  universeStoredThrough: number;
  marketStoredThroughByInstrument: Readonly<Record<string, number>>;
  series: HistoricalScannerReplaySeries;
  replay: BarReplayMode;
  quantParameters?: Partial<QuantParameters>;
}

export interface HistoricalScannerReplayQuantRef {
  instrumentId: string;
  quantRunId: string;
  storedThrough: number;
}

export interface HistoricalScannerReplayStep {
  asOf: string;
  scannerRunId: string;
  scannerInputFingerprint: string;
  universeFingerprint: string;
  universeSnapshotRevisionId: string | null;
  quantRunIds: HistoricalScannerReplayQuantRef[];
  candidateInstrumentIds: string[];
  rankingComplete: boolean;
}

export interface HistoricalScannerReplayResult {
  replayRunId: string;
  engineVersion: typeof HISTORICAL_SCANNER_REPLAY_VERSION;
  inputFingerprint: string;
  replay: BarReplayMode;
  definitionId: string;
  definitionVersion: string;
  universeId: string;
  universeSourceId: string;
  universeStoredThrough: number;
  marketStoredThroughByInstrument: Readonly<Record<string, number>>;
  asOf: string[];
  steps: HistoricalScannerReplayStep[];
}

export interface HistoricalScannerUniversePort {
  select(query: UniverseSelectionQuery): UniverseSelection | Promise<UniverseSelection>;
}

export interface HistoricalScannerQuantPort {
  run(request: QuantRunRequest): Promise<{ record: QuantRunRecord; status: 'APPLIED' | 'ALREADY_APPLIED' }>;
}

export interface HistoricalScannerSnapshotPort {
  build(input: {
    instrumentId: string;
    asOf: string;
    storedThrough: number;
    replay: BarReplayMode;
    series: HistoricalScannerReplaySeries;
    quant: QuantRunRecord;
  }): Promise<ScannerSnapshot | null>;
}

export interface HistoricalScannerRunPort {
  save(run: ScannerRun): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
}

export interface HistoricalScannerReplayDependencies {
  universe: HistoricalScannerUniversePort;
  quant: HistoricalScannerQuantPort;
  snapshots: HistoricalScannerSnapshotPort;
  scannerRuns: HistoricalScannerRunPort;
}

export class HistoricalScannerReplayError extends Error {
  override readonly name = 'HistoricalScannerReplayError';
  constructor(
    readonly code:
      | 'INVALID_REPLAY_SCHEDULE'
      | 'UNIVERSE_ANCHOR_REQUIRED'
      | 'MARKET_ANCHOR_REQUIRED'
      | 'ANCHOR_MISMATCH',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

function exactCanonicalInstant(value: string, index: number): { iso: string; ms: number } {
  let ms: number;
  try {
    ms = parseUtc(value);
  } catch (error) {
    throw new HistoricalScannerReplayError('INVALID_REPLAY_SCHEDULE', 'asOf[' + index + '] is invalid: ' + (error as Error).message);
  }
  const iso = toUtcIso(ms);
  if (iso !== value) {
    throw new HistoricalScannerReplayError('INVALID_REPLAY_SCHEDULE', 'asOf[' + index + '] must be canonical UTC milliseconds (' + iso + ')');
  }
  return { iso, ms };
}

function scheduleOf(values: readonly string[]): string[] {
  if (values.length === 0) throw new HistoricalScannerReplayError('INVALID_REPLAY_SCHEDULE', 'at least one replay instant is required');
  const out: string[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index++) {
    const { iso, ms } = exactCanonicalInstant(values[index]!, index);
    if (ms <= previous) {
      throw new HistoricalScannerReplayError('INVALID_REPLAY_SCHEDULE', 'replay instants must be unique and strictly increasing');
    }
    previous = ms;
    out.push(iso);
  }
  return out;
}

function anchor(value: unknown, code: 'UNIVERSE_ANCHOR_REQUIRED' | 'MARKET_ANCHOR_REQUIRED', label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HistoricalScannerReplayError(code, label + ' must be an explicit non-negative safe integer ingest sequence');
  }
  return value;
}

function seriesMatches(record: QuantRunRecord, request: HistoricalScannerReplayRequest, instrumentId: string, asOf: string, storedThrough: number): void {
  const r = record.result;
  if (record.storedThrough !== storedThrough) {
    throw new HistoricalScannerReplayError(
      'ANCHOR_MISMATCH',
      instrumentId + ' Quant storedThrough ' + String(record.storedThrough) + ' does not match pinned anchor ' + storedThrough,
    );
  }
  if (
    r.instrumentId !== instrumentId ||
    r.asOf !== asOf ||
    r.barReplay !== request.replay ||
    r.series.source !== request.series.source ||
    r.series.interval !== request.series.interval ||
    r.series.session !== request.series.session ||
    r.series.adjustment !== request.series.adjustment
  ) {
    throw new HistoricalScannerReplayError('ANCHOR_MISMATCH', instrumentId + ' Quant result does not match the replay request boundary');
  }
}

function snapshotMatches(snapshot: ScannerSnapshot, record: QuantRunRecord, instrumentId: string, asOf: string): void {
  if (
    snapshot.instrumentId !== instrumentId ||
    snapshot.asOf !== asOf ||
    snapshot.quant.instrumentId !== instrumentId ||
    snapshot.quant.asOf !== asOf ||
    snapshot.quant.quantRunId !== record.result.quantRunId ||
    snapshot.quant.inputFingerprint !== record.result.inputFingerprint
  ) {
    throw new HistoricalScannerReplayError('ANCHOR_MISMATCH', instrumentId + ' snapshot does not match its pinned Quant run');
  }
}

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalMarketAnchors(values: Readonly<Record<string, number>>): Array<[string, number]> {
  return Object.entries(values)
    .sort(([a], [b]) => compareCodeUnit(a, b))
    .map(([instrumentId, value]) => [
      instrumentId,
      anchor(value, 'MARKET_ANCHOR_REQUIRED', 'marketStoredThroughByInstrument[' + instrumentId + ']'),
    ]);
}

/**
 * Runs an immutable historical scanner timeline. The service coordinates existing point-in-time
 * universe selection, QuantService-compatible runs and snapshot construction; it does not duplicate
 * indicator or scanner mathematics.
 */
export async function runHistoricalScannerReplay(
  request: HistoricalScannerReplayRequest,
  deps: HistoricalScannerReplayDependencies,
): Promise<HistoricalScannerReplayResult> {
  const schedule = scheduleOf(request.asOf);
  const universeStoredThrough = anchor(request.universeStoredThrough, 'UNIVERSE_ANCHOR_REQUIRED', 'universeStoredThrough');
  if (request.definition.universeId !== request.universeId) {
    throw new HistoricalScannerReplayError('ANCHOR_MISMATCH', 'scanner definition universeId does not match replay universeId');
  }

  // Canonicalize every supplied market anchor up front for identity. A selected member still must
  // have one at the step where it appears; no fallback to a current head is permitted.
  const marketAnchorEntries = canonicalMarketAnchors(request.marketStoredThroughByInstrument);
  const marketAnchors = new Map(marketAnchorEntries);
  const steps: HistoricalScannerReplayStep[] = [];

  for (const asOf of schedule) {
    const universe = await deps.universe.select({
      universeId: request.universeId,
      sourceId: request.universeSourceId,
      asOf,
      mode: request.replay,
      storedThrough: universeStoredThrough,
    });

    const members = [...universe.members].sort(compareCodeUnit);
    const snapshots: ScannerSnapshot[] = [];
    const quantRunIds: HistoricalScannerReplayQuantRef[] = [];

    for (const instrumentId of members) {
      const storedThroughValue = marketAnchors.get(instrumentId);
      if (storedThroughValue === undefined) {
        throw new HistoricalScannerReplayError(
          'MARKET_ANCHOR_REQUIRED',
          'selected universe member ' + instrumentId + ' has no market storedThrough anchor',
        );
      }
      const storedThrough = anchor(
        storedThroughValue,
        'MARKET_ANCHOR_REQUIRED',
        'marketStoredThroughByInstrument[' + instrumentId + ']',
      );

      const quantRequest: QuantRunRequest = {
        instrumentId,
        source: request.series.source,
        interval: request.series.interval,
        session: request.series.session,
        adjustment: request.series.adjustment,
        asOf,
        storedThrough,
        replay: request.replay,
        ...(request.quantParameters ? { parameters: request.quantParameters } : {}),
      };
      const { record } = await deps.quant.run(quantRequest);
      seriesMatches(record, request, instrumentId, asOf, storedThrough);
      quantRunIds.push({ instrumentId, quantRunId: record.result.quantRunId, storedThrough });

      const snapshot = await deps.snapshots.build({
        instrumentId,
        asOf,
        storedThrough,
        replay: request.replay,
        series: request.series,
        quant: record,
      });
      if (snapshot !== null) {
        snapshotMatches(snapshot, record, instrumentId, asOf);
        snapshots.push(snapshot);
      }
    }

    const scannerRun = runMarketScanner(request.definition, universe, snapshots, asOf);
    await deps.scannerRuns.save(scannerRun);
    steps.push({
      asOf,
      scannerRunId: scannerRun.scannerRunId,
      scannerInputFingerprint: scannerRun.inputFingerprint,
      universeFingerprint: scannerRun.universeFingerprint,
      universeSnapshotRevisionId: scannerRun.universeEvidence.snapshotRevisionId,
      quantRunIds,
      candidateInstrumentIds: scannerRun.candidates.map((candidate) => candidate.instrumentId),
      rankingComplete: scannerRun.rankingComplete,
    });
  }

  const resolvedIdentity = {
    engine: HISTORICAL_SCANNER_REPLAY_VERSION,
    snapshotPolicy: SCANNER_SNAPSHOT_POLICY_VERSION,
    definition: request.definition,
    replay: request.replay,
    asOf: schedule,
    universe: {
      universeId: request.universeId,
      sourceId: request.universeSourceId,
      storedThrough: universeStoredThrough,
    },
    marketStoredThroughByInstrument: marketAnchorEntries,
    series: request.series,
    quantParameters: request.quantParameters ?? null,
    // These immutable child identities make corruption/non-deterministic dependency output visible
    // at the replay level instead of letting the orchestration manifest keep the same id.
    steps: steps.map((step) => ({
      asOf: step.asOf,
      scannerRunId: step.scannerRunId,
      scannerInputFingerprint: step.scannerInputFingerprint,
      universeFingerprint: step.universeFingerprint,
      universeSnapshotRevisionId: step.universeSnapshotRevisionId,
      quantRunIds: step.quantRunIds,
    })),
  };
  const inputFingerprint = hashOf(resolvedIdentity);

  return {
    replayRunId: 'hsr_' + inputFingerprint.slice(0, 40),
    engineVersion: HISTORICAL_SCANNER_REPLAY_VERSION,
    inputFingerprint,
    replay: request.replay,
    definitionId: request.definition.id,
    definitionVersion: request.definition.version,
    universeId: request.universeId,
    universeSourceId: request.universeSourceId,
    universeStoredThrough,
    marketStoredThroughByInstrument: Object.fromEntries(marketAnchorEntries),
    asOf: schedule,
    steps,
  };
}
