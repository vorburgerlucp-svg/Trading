// Read-only evidence reference validation (fail closed).
//
// A decision may cite a quant run, a scanner run and backtest runs by id. A well-formed id proves
// nothing. Before any cited evidence reaches a model or a decision, every reference must exist in its
// own store, pass its integrity checks, be admissible at the decision asOf, match one instrument and match
// its lineage. Time is checked two ways (see src/persistence/evidence-seal.ts):
//   result availability  the seal's sealedAt <= asOf (the run was committed by asOf)
//   input availability   scanner inputsAvailableAt <= asOf; quant asOf <= asOf (the quant read is point-in-time)
// The Brain reads through the narrow interfaces below. It never saves, deletes or recomputes a run.

import type { BacktestRunStore } from '../backtest/backtest-store.js';
import type { BacktestRunResult } from '../backtest/backtest-types.js';
import { SPLIT_ADJUSTMENT_VERSION } from '../market-data/corporate-actions.js';
import { parseUtc } from '../market-data/time.js';
import type { EvidenceSeal, EvidenceSealKind, Sealed } from '../persistence/evidence-seal.js';
import type { QuantRunStore } from '../quant/quant-run-store.js';
import type { QuantBarProvenance, QuantRunRecord } from '../quant/quant-types.js';
import type { ScannerRunStore } from '../scanner/scanner-store.js';
import type { UniverseEvidence } from '../universe/universe-model.js';
import type { ScannerBarKnowledge, ScannerCandidate, ScannerRun } from '../scanner/scanner-types.js';

/** Version of the lineage object that enters the decision input fingerprint. */
export const EVIDENCE_LINEAGE_VERSION = 'evidence-lineage:v4';

export interface ScannerEvidenceReader {
  getSealed(scannerRunId: string): Promise<Sealed<ScannerRun> | null>;
}
export interface BacktestEvidenceReader {
  getSealed(backtestRunId: string): Promise<Sealed<BacktestRunResult> | null>;
}
export interface QuantEvidenceReader {
  getSealed(quantRunId: string): Promise<Sealed<QuantRunRecord> | null>;
}

export interface EvidenceReaders {
  scanner?: ScannerEvidenceReader;
  backtest?: BacktestEvidenceReader;
  quant?: QuantEvidenceReader;
}

/** Only `getSealed` is exposed: nothing reachable through these can save, delete or recompute a run. */
export function readOnlyScannerEvidence(store: Pick<ScannerRunStore, 'getSealed'>): ScannerEvidenceReader {
  return Object.freeze({ getSealed: (scannerRunId: string) => store.getSealed(scannerRunId) });
}
export function readOnlyBacktestEvidence(store: Pick<BacktestRunStore, 'getSealed'>): BacktestEvidenceReader {
  return Object.freeze({ getSealed: (backtestRunId: string) => store.getSealed(backtestRunId) });
}
export function readOnlyQuantEvidence(store: Pick<QuantRunStore, 'getSealed'>): QuantEvidenceReader {
  return Object.freeze({ getSealed: (quantRunId: string) => store.getSealed(quantRunId) });
}

/** Machine-readable reason codes. Blocking codes refuse the evidence; warnings travel with the decision. */
export const EVIDENCE_REASON_CODES = [
  'EVIDENCE_READER_NOT_CONFIGURED',
  'QUANT_EVIDENCE_NOT_FOUND',
  'QUANT_EVIDENCE_INTEGRITY_FAILED',
  'SCANNER_EVIDENCE_NOT_FOUND',
  'SCANNER_EVIDENCE_INTEGRITY_FAILED',
  'BACKTEST_EVIDENCE_NOT_FOUND',
  'BACKTEST_EVIDENCE_INTEGRITY_FAILED',
  'EVIDENCE_FROM_FUTURE',
  'RESULT_RECORDED_AFTER_ASOF',
  'RESULT_AVAILABILITY_UNPROVEN',
  'DATA_AVAILABILITY_UNPROVEN',
  'CORPORATE_ACTION_TIMING_UNPROVEN',
  'SCANNER_QUANT_LINEAGE_MISMATCH',
  'SCANNER_RANKING_INCOMPLETE',
  'BACKTEST_INVALID',
  'BACKTEST_WARMUP_UNPROVEN',
  'BACKTEST_PREFERRED_WARMUP_NOT_MET',
  'BACKTEST_AVAILABILITY_UNVERIFIABLE',
  'BACKTEST_WEAK_EVIDENCE',
  'BACKTEST_INSUFFICIENT_SAMPLE',
  'BACKTEST_STRONG_EVIDENCE_REQUIRED',
  'WEAK_BACKTEST_EVIDENCE_ONLY',
  'EVIDENCE_INSTRUMENT_UNKNOWN',
  'CROSS_INSTRUMENT_EVIDENCE',
  'BAR_KNOWLEDGE_NOT_PROVEN',
  'BAR_VINTAGE_NOT_CONTEMPORANEOUS',
  'LATEST_BAR_NOT_CONTEMPORANEOUS',
  'SCANNER_RESEARCH_EVIDENCE',
  'UNIVERSE_EVIDENCE_UNPROVEN',
  'UNIVERSE_COVERAGE_INCOMPLETE',
  'UNIVERSE_HISTORICAL_RECONSTRUCTION',
  'UNIVERSE_SOURCE_NOT_PRODUCTION',
] as const;
export type EvidenceReasonCode = (typeof EVIDENCE_REASON_CODES)[number];

export interface EvidenceIssue {
  code: EvidenceReasonCode;
  ref: string;
  detail: string;
}

export interface EvidenceRequest {
  asOf: string;
  quantRunId: string | undefined;
  scannerRunId: string | undefined;
  backtestRunIds: readonly string[] | undefined;
  /** opportunity.links.instrumentId, when the opportunity is linked to one. */
  opportunityInstrumentId: string | undefined;
  /** The decision needs the complete universe; an incomplete scanner ranking then blocks it. */
  requiresCompleteUniverse: boolean;
}

/**
 * Identity lineage: Decision → QuantRun → ScannerRun → ScannerCandidate → BacktestRuns. IDs, fingerprints,
 * grades and data times only. It enters the decision input fingerprint. Commit times are NOT in here (see EvidenceSealSummary).
 */
/** The bar knowledge of a run, as the evidence sees it. The two questions stay separate. null when the run predates the model. */
export interface BarKnowledgeLineage {
  decisionTimeKnowledgeProven: boolean;
  allBarsContemporaneousVintage: boolean;
  historicalReconstruction: boolean;
  legacyUnproven: boolean;
  latestFinalBarContemporaneous: boolean;
}

function barKnowledgeOf(provenance: Partial<QuantBarProvenance> | undefined): BarKnowledgeLineage | null {
  if (!provenance) return null;
  return {
    decisionTimeKnowledgeProven: provenance.decisionTimeKnowledgeProven === true,
    allBarsContemporaneousVintage: provenance.allBarsContemporaneousVintage === true,
    historicalReconstruction: provenance.historicalReconstruction === true,
    legacyUnproven: provenance.legacyUnproven === true,
    latestFinalBarContemporaneous: provenance.latestFinalBarContemporaneous === true,
  };
}

/** Identity and derived facts of the universe revision a scanner run ranked over. Never a caller claim. */
export interface UniverseLineage {
  status: 'SELECTED' | 'UNAVAILABLE';
  snapshotKey: string | null;
  snapshotRevisionId: string | null;
  revision: number | null;
  effectiveAt: string | null;
  knownAt: string | null;
  vintage: string | null;
  complete: boolean;
  decisionTimeKnowledgeProven: boolean;
  strictDecisionTime: boolean;
  sourceProduction: boolean;
  historicalReconstruction: boolean;
  fingerprint: string;
}

export interface EvidenceLineage {
  evidenceLineageVersion: typeof EVIDENCE_LINEAGE_VERSION;
  asOf: string;
  instrumentId: string | null;
  quant: { quantRunId: string; instrumentId: string; asOf: string; barKnowledge: BarKnowledgeLineage | null } | null;
  scanner: {
    scannerRunId: string;
    asOf: string;
    rankingComplete: boolean;
    inputFingerprint: string;
    /** Latest input availability (engine-computed, stored with the run). null when unknown or no inputs. */
    inputsAvailableAt: string | null;
    /** live_trading (the default) or research: a research scan is never live evidence. */
    useCase: 'live_trading' | 'research';
    candidate: { instrumentId: string; rank: number; quantRunId: string; barKnowledge: ScannerBarKnowledge | null } | null;
    /** The derived universe evidence the scanner ranked over (docs/PIT_UNIVERSE_V1.md). null only when the run predates it. */
    universe: UniverseLineage | null;
  } | null;
  backtests: {
    backtestRunId: string;
    instrumentId: string;
    strategyId: string;
    strategyVersion: string;
    strategyFingerprint: string;
    inputFingerprint: string;
    grade: BacktestRunResult['quality']['grade'];
    insufficientSample: boolean;
    /** 'strong' only for grade A without insufficient sample. Everything else is weak evidence. */
    strength: 'strong' | 'weak';
    /** Last market availability time the backtest used (last equity point). */
    dataCutoff: string | null;
    /** What the bars were at their simulated use time. null for runs that predate the field (weak). */
    dataProvenance: string | null;
  }[];
}

/** Commit-time proof of one cited run. Audit only: not part of the input fingerprint, so repeated runs stay deterministic. */
export interface EvidenceSealSummary {
  kind: EvidenceSealKind;
  recordId: string;
  /** Read before COMMIT (lower bound). null: no seal. */
  recordedAt: string | null;
  /** Read after COMMIT (upper bound). null: no seal. */
  sealedAt: string | null;
}

export interface EvidenceValidation {
  passed: boolean;
  blocking: EvidenceIssue[];
  warnings: EvidenceIssue[];
  lineage: EvidenceLineage;
  seals: EvidenceSealSummary[];
}

/** Thrown when a decision cites evidence that does not hold up. The refusal itself is recorded (see NexusBrain.decide). */
export class EvidenceReferenceError extends Error {
  override readonly name = 'EvidenceReferenceError';
  readonly codes: EvidenceReasonCode[];

  constructor(readonly validation: EvidenceValidation) {
    super('evidence references rejected (fail closed): ' + validation.blocking.map((i) => i.code + ' ' + i.ref).join('; '));
    this.codes = [...new Set(validation.blocking.map((i) => i.code))];
  }
}

function universeLineageOf(u: UniverseEvidence): UniverseLineage {
  return { status: u.status, snapshotKey: u.snapshotKey, snapshotRevisionId: u.snapshotRevisionId, revision: u.revision, effectiveAt: u.effectiveAt, knownAt: u.knownAt, vintage: u.vintage, complete: u.complete, decisionTimeKnowledgeProven: u.decisionTimeKnowledgeProven, strictDecisionTime: u.strictDecisionTime, sourceProduction: u.sourceProduction, historicalReconstruction: u.historicalReconstruction, fingerprint: u.fingerprint };
}

const byCodeAndRef = (a: EvidenceIssue, b: EvidenceIssue): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads one run through its read-only reader. Missing, unreadable, or mis-keyed runs are blocking issues, never silent. */
async function fetchRun<T>(
  ref: string,
  codes: { notFound: EvidenceReasonCode; integrity: EvidenceReasonCode; kind: string },
  reader: { getSealed(id: string): Promise<Sealed<T> | null> } | undefined,
  idOf: (run: T) => string,
  blocking: EvidenceIssue[],
): Promise<Sealed<T> | null> {
  if (reader === undefined) {
    blocking.push({ code: 'EVIDENCE_READER_NOT_CONFIGURED', ref, detail: codes.kind + ' evidence is referenced but no read-only reader is configured' });
    return null;
  }
  let sealed: Sealed<T> | null;
  try {
    sealed = await reader.getSealed(ref);
  } catch (error) {
    blocking.push({ code: codes.integrity, ref, detail: 'stored ' + codes.kind + ' evidence failed its integrity check: ' + errorMessage(error) });
    return null;
  }
  if (sealed === null) {
    blocking.push({ code: codes.notFound, ref, detail: codes.kind + ' evidence ' + ref + ' does not exist' });
    return null;
  }
  if (idOf(sealed.record) !== ref) {
    blocking.push({ code: codes.integrity, ref, detail: 'store returned ' + codes.kind + ' evidence under a different id' });
    return null;
  }
  return sealed;
}

/**
 * Result availability at asOf. Only sealedAt <= asOf proves the commit happened by asOf. recordedAt > asOf proves it did
 * not. Anything in between, and any run without a seal, is unproven and blocks the evidence.
 */
function checkResultAvailability(kind: EvidenceSealKind, ref: string, seal: EvidenceSeal | null, asOf: string, asOfMs: number, blocking: EvidenceIssue[], seals: EvidenceSealSummary[]): void {
  seals.push({ kind, recordId: ref, recordedAt: seal?.recordedAt ?? null, sealedAt: seal?.sealedAt ?? null });
  if (seal === null) {
    blocking.push({ code: 'RESULT_AVAILABILITY_UNPROVEN', ref, detail: kind + ' has no commit seal (stored before sealing, or interrupted before it): its availability at asOf cannot be shown' });
  } else if (Date.parse(seal.recordedAt) > asOfMs) {
    blocking.push({ code: 'RESULT_RECORDED_AFTER_ASOF', ref, detail: kind + ' was being recorded from ' + seal.recordedAt + ', after decision asOf ' + asOf + ': it was not available at asOf' });
  } else if (Date.parse(seal.sealedAt) > asOfMs) {
    blocking.push({ code: 'RESULT_AVAILABILITY_UNPROVEN', ref, detail: 'commit of ' + kind + ' is bounded only by ' + seal.sealedAt + ', after decision asOf ' + asOf + ': availability at asOf cannot be shown' });
  }
}

/**
 * Validates every evidence reference a decision cites. Pure with respect to the decision: it reads
 * the stores, never writes, and its result depends only on the stored runs and the request asOf.
 */
export async function validateEvidenceReferences(request: EvidenceRequest, readers: EvidenceReaders): Promise<EvidenceValidation> {
  const blocking: EvidenceIssue[] = [];
  const warnings: EvidenceIssue[] = [];
  const seals: EvidenceSealSummary[] = [];
  const block = (code: EvidenceReasonCode, ref: string, detail: string) => void blocking.push({ code, ref, detail });
  const warn = (code: EvidenceReasonCode, ref: string, detail: string) => void warnings.push({ code, ref, detail });
  // Decision time as an instant. Date.parse accepts offsets exactly like the evidence store does. An unreadable asOf
  // must not make every future check pass silently, so it fails closed.
  const asOfMs = Date.parse(request.asOf);
  if (Number.isNaN(asOfMs)) throw new Error('evidence validation needs an ISO asOf, got "' + request.asOf.slice(0, 40) + '"');

  // Quant run: the instrument anchor of the decision. Its asOf is the point-in-time read of its bars (engine-attested).
  const quant = request.quantRunId === undefined
    ? null
    : await fetchRun(request.quantRunId, { notFound: 'QUANT_EVIDENCE_NOT_FOUND', integrity: 'QUANT_EVIDENCE_INTEGRITY_FAILED', kind: 'quant' }, readers.quant, (r) => r.result.quantRunId, blocking);
  if (quant !== null) {
    const id = quant.record.result.quantRunId;
    checkResultAvailability('quant_run', id, quant.seal, request.asOf, asOfMs, blocking, seals);
    if (Date.parse(quant.record.result.asOf) > asOfMs) block('EVIDENCE_FROM_FUTURE', id, 'quant asOf ' + quant.record.result.asOf + ' is after decision asOf ' + request.asOf);
    // A split-adjusted series is only point-in-time under the information gate of the current derivation. A run without that
    // derivation version (stored before it was versioned, or computed under another policy) cannot show when its splits were known.
    if (quant.record.result.series.adjustment === 'split_adjusted') {
      const version = quant.record.result.algorithmVersions['split-adjust'];
      if (version !== SPLIT_ADJUSTMENT_VERSION) {
        block('CORPORATE_ACTION_TIMING_UNPROVEN', id, 'split-adjusted quant run has split-adjust version ' + (version ?? 'none') + ', not ' + SPLIT_ADJUSTMENT_VERSION + ': when its splits were known cannot be shown');
      }
    }
  }

  // Bar knowledge of the quant run. Decision-time knowledge gates the evidence. Vintage is reported and never claimed as contemporaneous.
  if (quant !== null) {
    const provenance = quant.record.result.barDataProvenance as Partial<QuantBarProvenance> | undefined;
    if (provenance?.decisionTimeKnowledgeProven !== true) {
      block('BAR_KNOWLEDGE_NOT_PROVEN', quant.record.result.quantRunId, provenance === undefined ? 'the run predates the bar knowledge model: its bar knowledge cannot be shown' : 'NEXUS did not hold every bar of the run at asOf, or a bar is legacy');
    } else if (provenance.allBarsContemporaneousVintage !== true) {
      warn('BAR_VINTAGE_NOT_CONTEMPORANEOUS', quant.record.result.quantRunId, 'every bar was held by NEXUS at asOf, but some bars have a historical vintage: their market-time value is not proven');
    }
  }

  // Scanner run and lineage: the candidate must come from exactly the cited quant run.
  const scanner = request.scannerRunId === undefined
    ? null
    : await fetchRun(request.scannerRunId, { notFound: 'SCANNER_EVIDENCE_NOT_FOUND', integrity: 'SCANNER_EVIDENCE_INTEGRITY_FAILED', kind: 'scanner' }, readers.scanner, (r) => r.scannerRunId, blocking);
  let candidate: ScannerCandidate | null = null;
  if (scanner !== null) {
    const run = scanner.record;
    checkResultAvailability('scanner_run', run.scannerRunId, scanner.seal, request.asOf, asOfMs, blocking, seals);
    if (Date.parse(run.asOf) > asOfMs) block('EVIDENCE_FROM_FUTURE', run.scannerRunId, 'scanner asOf ' + run.asOf + ' is after decision asOf ' + request.asOf);
    if (run.inputsAvailableAt === undefined || run.inputsAvailableAt === null) {
      block('DATA_AVAILABILITY_UNPROVEN', run.scannerRunId, 'scanner run has no input availability time (stored before market-scanner:v2, or without inputs): its inputs cannot be shown available at asOf');
    } else if (Date.parse(run.inputsAvailableAt) > asOfMs) {
      block('EVIDENCE_FROM_FUTURE', run.scannerRunId, 'scanner input available at ' + run.inputsAvailableAt + ', after decision asOf ' + request.asOf);
    }
    if (!run.rankingComplete) {
      const detail = 'ranking covers ' + run.coverage.evaluatedInstruments + ' of ' + run.coverage.universeMembers + ' universe members; it is not a ranking of the full universe';
      if (request.requiresCompleteUniverse) block('SCANNER_RANKING_INCOMPLETE', run.scannerRunId, detail);
      else warn('SCANNER_RANKING_INCOMPLETE', run.scannerRunId, detail);
    }
    if (request.quantRunId !== undefined) {
      candidate = run.candidates.find((c) => c.quantRunId === request.quantRunId) ?? null;
      if (candidate === null) block('SCANNER_QUANT_LINEAGE_MISMATCH', run.scannerRunId, 'no candidate of this scanner run was produced by quant run ' + request.quantRunId);
      if (quant !== null && parseUtc(quant.record.result.asOf) !== parseUtc(run.asOf)) {
        block('SCANNER_QUANT_LINEAGE_MISMATCH', run.scannerRunId, 'quant run asOf ' + quant.record.result.asOf + ' differs from scanner asOf ' + run.asOf);
      }
      // The universe: a scanner run without derived universe evidence cannot be promoted, and an unproven or incomplete universe blocks a
      // decision that needs the complete universe. A historical reconstruction is always a visible warning, never described as strict.
      const universe = run.universeEvidence;
      if (universe === undefined || universe === null) {
        block('UNIVERSE_EVIDENCE_UNPROVEN', run.scannerRunId, 'scanner run predates universe evidence: its universe cannot be shown');
      } else {
        // An unavailable universe is never acceptable: no revision was known, so nothing can be shown. The other facts are then moot.
        if (universe.status === 'UNAVAILABLE') {
          block('UNIVERSE_EVIDENCE_UNPROVEN', run.scannerRunId, 'no universe revision was known at asOf');
        } else {
          if (!universe.decisionTimeKnowledgeProven) {
            const detail = 'the universe revision was not known at asOf';
            if (request.requiresCompleteUniverse) block('UNIVERSE_EVIDENCE_UNPROVEN', run.scannerRunId, detail);
            else warn('UNIVERSE_EVIDENCE_UNPROVEN', run.scannerRunId, detail);
          }
          if (!universe.complete) {
            if (request.requiresCompleteUniverse) block('UNIVERSE_COVERAGE_INCOMPLETE', run.scannerRunId, 'the universe source snapshot is not complete');
            else warn('UNIVERSE_COVERAGE_INCOMPLETE', run.scannerRunId, 'the universe source snapshot is not complete');
          }
          if (!universe.sourceProduction) {
            if (request.requiresCompleteUniverse) block('UNIVERSE_SOURCE_NOT_PRODUCTION', run.scannerRunId, 'the universe source is not production');
            else warn('UNIVERSE_SOURCE_NOT_PRODUCTION', run.scannerRunId, 'the universe source is not production');
          }
          if (universe.historicalReconstruction) warn('UNIVERSE_HISTORICAL_RECONSTRUCTION', run.scannerRunId, 'the universe membership is a historical reconstruction, not strict point-in-time evidence');
        }
      }
      if (candidate !== null) {
        // The candidate's bars must be known at asOf in every case. A live candidate also needs a contemporaneous signal bar.
        const k = candidate.barKnowledge as Partial<ScannerBarKnowledge> | undefined;
        if (k?.decisionTimeKnowledgeProven !== true) block('BAR_KNOWLEDGE_NOT_PROVEN', run.scannerRunId, 'the candidate does not prove decision-time knowledge of its bars' + (k === undefined ? ' (it predates the bar knowledge model)' : ''));
        if (run.definition.useCase === 'research') {
          warn('SCANNER_RESEARCH_EVIDENCE', run.scannerRunId, 'research scan: its candidates may rest on historical reconstructions; it is not live evidence');
        } else if (k?.latestFinalBarContemporaneous !== true) {
          block('LATEST_BAR_NOT_CONTEMPORANEOUS', run.scannerRunId, 'a live candidate needs a contemporaneous signal bar (the latest final bar)');
        }
      }
    }
  }

  // Instrument identity: only from persisted lineage or the opportunity link. Never guessed.
  const claims: { source: string; instrumentId: string }[] = [];
  if (quant !== null) claims.push({ source: 'quant run', instrumentId: quant.record.result.instrumentId });
  if (candidate !== null) claims.push({ source: 'scanner candidate', instrumentId: candidate.instrumentId });
  if (request.opportunityInstrumentId !== undefined) claims.push({ source: 'opportunity', instrumentId: request.opportunityInstrumentId });
  const knownInstruments = [...new Set(claims.map((c) => c.instrumentId))].sort();
  if (knownInstruments.length > 1) {
    block('CROSS_INSTRUMENT_EVIDENCE', request.quantRunId ?? request.scannerRunId ?? 'decision', 'instrument claims disagree: ' + claims.map((c) => c.source + '=' + c.instrumentId).join(', '));
  }
  const instrumentId = knownInstruments.length === 1 ? (knownInstruments[0] ?? null) : null;

  // Backtests: each run must exist, be sealed before asOf, be valid, be admissible at asOf and belong to the decision instrument.
  const backtests: EvidenceLineage['backtests'] = [];
  for (const ref of [...new Set(request.backtestRunIds ?? [])].sort()) {
    const sealed = await fetchRun(ref, { notFound: 'BACKTEST_EVIDENCE_NOT_FOUND', integrity: 'BACKTEST_EVIDENCE_INTEGRITY_FAILED', kind: 'backtest' }, readers.backtest, (r) => r.backtestRunId, blocking);
    if (sealed === null) continue;
    const run = sealed.record;
    checkResultAvailability('backtest_run', ref, sealed.seal, request.asOf, asOfMs, blocking, seals);
    const grade = run.quality.grade;
    if (grade === 'INVALID') block('BACKTEST_INVALID', ref, 'quality INVALID cannot support a decision: ' + run.quality.reasons.join('; '));
    // A v1 run had no warm-up gate: its first decisions may rest on too little history, so it cannot be shown admissible.
    if (run.warmup === undefined) block('BACKTEST_WARMUP_UNPROVEN', ref, 'backtest-engine:v1 run without a warm-up gate: its early decisions cannot be shown to have had enough history');
    else if (!run.warmup.preferredWarmupMet) warn('BACKTEST_PREFERRED_WARMUP_NOT_MET', ref, 'some evaluations had fewer than preferredBars ' + run.warmup.preferredBars + ' bars of history; the result stays admissible but is marked');
    const dataCutoff = run.equityCurve.at(-1)?.at ?? null;
    if (dataCutoff === null) block('BACKTEST_AVAILABILITY_UNVERIFIABLE', ref, 'backtest has no equity series, so its data window cannot be placed in time');
    else if (parseUtc(dataCutoff) > asOfMs) block('EVIDENCE_FROM_FUTURE', ref, 'backtest data runs to ' + dataCutoff + ', after decision asOf ' + request.asOf);
    if (run.quality.insufficientSample) warn('BACKTEST_INSUFFICIENT_SAMPLE', ref, run.metrics.numberOfTrades + ' trade(s): weak evidence only, no probability may be derived from it');
    // Strong evidence needs grade A, a sufficient sample and STRICT_PIT_DATA. A run without the field is weak.
    const dataProvenance = run.quality.dataProvenance ?? null;
    const strong = grade === 'A' && !run.quality.insufficientSample && dataProvenance === 'STRICT_PIT_DATA';
    if (!strong && grade !== 'INVALID') warn('BACKTEST_WEAK_EVIDENCE', ref, 'quality ' + grade + ', data ' + (dataProvenance ?? 'unknown (run predates data provenance)') + ': supporting evidence only, never strong proof');
    backtests.push({
      backtestRunId: run.backtestRunId,
      instrumentId: run.instrumentId,
      strategyId: run.strategyId,
      strategyVersion: run.strategyVersion,
      strategyFingerprint: run.strategyFingerprint,
      inputFingerprint: run.inputFingerprint,
      grade,
      insufficientSample: run.quality.insufficientSample,
      strength: strong ? 'strong' : 'weak',
      dataCutoff,
      dataProvenance,
    });
  }
  if (backtests.length > 0) {
    const backtestInstruments = [...new Set(backtests.map((b) => b.instrumentId))].sort();
    if (backtestInstruments.length > 1) block('CROSS_INSTRUMENT_EVIDENCE', 'backtests', 'backtests belong to different instruments: ' + backtestInstruments.join(', '));
    if (instrumentId === null) {
      block('EVIDENCE_INSTRUMENT_UNKNOWN', 'backtests', 'backtest evidence needs a decision instrument to be matched; it comes from a quant run, scanner candidate lineage or an opportunity link');
    } else {
      for (const b of backtests) {
        if (b.instrumentId !== instrumentId) block('CROSS_INSTRUMENT_EVIDENCE', b.backtestRunId, 'backtest is for ' + b.instrumentId + ' but the decision is for ' + instrumentId);
      }
    }
  }

  const lineage: EvidenceLineage = {
    evidenceLineageVersion: EVIDENCE_LINEAGE_VERSION,
    asOf: request.asOf,
    instrumentId,
    quant: quant === null ? null : { quantRunId: quant.record.result.quantRunId, instrumentId: quant.record.result.instrumentId, asOf: quant.record.result.asOf, barKnowledge: barKnowledgeOf(quant.record.result.barDataProvenance as Partial<QuantBarProvenance> | undefined) },
    scanner: scanner === null
      ? null
      : {
          scannerRunId: scanner.record.scannerRunId,
          asOf: scanner.record.asOf,
          rankingComplete: scanner.record.rankingComplete,
          inputFingerprint: scanner.record.inputFingerprint,
          inputsAvailableAt: scanner.record.inputsAvailableAt ?? null,
          useCase: scanner.record.definition.useCase ?? 'live_trading',
          candidate: candidate === null ? null : { instrumentId: candidate.instrumentId, rank: candidate.rank, quantRunId: candidate.quantRunId, barKnowledge: candidate.barKnowledge ?? null },
          universe: scanner.record.universeEvidence ? universeLineageOf(scanner.record.universeEvidence) : null,
        },
    backtests: backtests.sort((a, b) => (a.backtestRunId < b.backtestRunId ? -1 : a.backtestRunId > b.backtestRunId ? 1 : 0)),
  };
  return {
    passed: blocking.length === 0,
    blocking: blocking.sort(byCodeAndRef),
    warnings: warnings.sort(byCodeAndRef),
    lineage,
    seals: seals.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)),
  };
}

/**
 * What the validated evidence may do to the decision. Weak evidence is never counted into strength: any number of
 * weak backtests is still weak. Citing backtests without a strong one blocks RECOMMEND, and so does a requirement
 * for strong evidence that is not met. The thresholds themselves (minimum trades, grades) are the caller's
 * BacktestQualityContext; this function adds no weights of its own.
 */
export function evidenceDecisionImpact(lineage: EvidenceLineage, requiresStrongBacktest: boolean): EvidenceReasonCode[] {
  const strong = lineage.backtests.some((b) => b.strength === 'strong');
  const impact: EvidenceReasonCode[] = [];
  if (requiresStrongBacktest && !strong) impact.push('BACKTEST_STRONG_EVIDENCE_REQUIRED');
  if (lineage.backtests.length > 0 && !strong) impact.push('WEAK_BACKTEST_EVIDENCE_ONLY');
  return impact;
}
