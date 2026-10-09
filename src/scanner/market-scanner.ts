import { hashOf } from '../persistence/canonical-json.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { evaluateScannerFilter, scannerRankingScore } from './scanner-filters.js';
import type { ScannerCandidate, ScannerCoverage, ScannerDefinition, ScannerRun, ScannerSnapshot } from './scanner-types.js';
import type { UniverseSnapshot } from './universe.js';

// v2 adds inputsAvailableAt to the stored run. The version is part of the input fingerprint, so the same inputs get
// a new scannerRunId under v2. A v1 run is never re-stored with different content under its old id.
export const MARKET_SCANNER_VERSION = 'market-scanner:v2';

export function runMarketScanner(definition: ScannerDefinition, universe: UniverseSnapshot, snapshots: readonly ScannerSnapshot[], asOf: string): ScannerRun {
  if (definition.universeId !== universe.universeId) throw new Error('scanner universe does not match universe snapshot');
  if (parseUtc(universe.asOf) !== parseUtc(asOf)) throw new Error('scanner asOf must match universe snapshot asOf');
  const asOfMs = parseUtc(asOf);
  const allowed = new Set(universe.members);
  const rejected: Array<{ instrumentId: string; reasons: string[] }> = [];
  const accepted: Array<{ snapshot: ScannerSnapshot; passed: string[]; failed: string[]; score: number }> = [];
  const auditInputs: Array<[string, string, string, string, string, string | null, string | null]> = [];
  let inputsAvailableMs: number | null = null;

  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (!allowed.has(snapshot.instrumentId)) continue;
    counts.set(snapshot.instrumentId, (counts.get(snapshot.instrumentId) ?? 0) + 1);
  }
  const missingInstruments = [...allowed].filter((id) => !counts.has(id)).sort();
  const duplicateInstruments = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  for (const instrumentId of missingInstruments) rejected.push({ instrumentId, reasons: ['missing scanner snapshot'] });
  for (const instrumentId of duplicateInstruments) rejected.push({ instrumentId, reasons: ['duplicate scanner snapshots'] });

  for (const snapshot of snapshots) {
    if (!allowed.has(snapshot.instrumentId)) continue;
    if ((counts.get(snapshot.instrumentId) ?? 0) !== 1) continue;
    auditInputs.push([
      snapshot.instrumentId,
      snapshot.quant.quantRunId,
      snapshot.quant.inputFingerprint,
      snapshot.lastPrice.toString(),
      snapshot.lastPriceAvailableAt,
      snapshot.averageVolume?.toString() ?? null,
      snapshot.averageVolumeAvailableAt ?? null,
    ]);
    // Every unique in-universe input counts, also a rejected one: a future input stays visible and blocks the run for decisions.
    for (const availableAt of [snapshot.lastPriceAvailableAt, snapshot.averageVolumeAvailableAt]) {
      if (availableAt !== undefined) inputsAvailableMs = Math.max(inputsAvailableMs ?? Number.NEGATIVE_INFINITY, parseUtc(availableAt));
    }
    const reasons: string[] = [];
    if (snapshot.quant.instrumentId !== snapshot.instrumentId) reasons.push('quant instrument mismatch');
    if (snapshot.quant.series.interval !== definition.interval) reasons.push('quant interval does not match scanner interval');
    if (parseUtc(snapshot.asOf) !== asOfMs || parseUtc(snapshot.quant.asOf) !== asOfMs) reasons.push('snapshot/quant asOf does not match scanner asOf');
    if (parseUtc(snapshot.lastPriceAvailableAt) > asOfMs) reasons.push('last price not yet available at scanner asOf');
    if (snapshot.averageVolume !== undefined) {
      if (snapshot.averageVolumeAvailableAt === undefined) reasons.push('average volume availability is missing');
      else if (parseUtc(snapshot.averageVolumeAvailableAt) > asOfMs) reasons.push('average volume not yet available at scanner asOf');
    }
    if (snapshot.quant.mode !== 'final_only') reasons.push('in-progress quant result');
    if (definition.useCase === 'research') {
      // Research: valid data is enough. Reconstructed bars are allowed and are marked on the candidate; nothing is presented as strict.
      if (!snapshot.quant.dataQuality.valid) reasons.push('market data invalid');
    } else {
      if (!snapshot.quant.dataQuality.usableForTrading) reasons.push('market data not usable for trading');
      // A live signal may rest only on revisions NEXUS can prove it held.
      if (!snapshot.quant.barDataProvenance.strictPointInTime) reasons.push('bar revisions not proven point in time: a historical reconstruction cannot back a live signal');
    }

    const evaluations = definition.filters.map((filter) => evaluateScannerFilter(snapshot, filter));
    const failed = evaluations.filter((e) => !e.passed).map((e) => e.code + ': ' + e.reason);
    const passed = evaluations.filter((e) => e.passed).map((e) => e.code);
    reasons.push(...failed);

    if (reasons.length > 0) {
      rejected.push({ instrumentId: snapshot.instrumentId, reasons });
      continue;
    }
    accepted.push({ snapshot, passed, failed, score: scannerRankingScore(snapshot, definition.ranking) });
  }

  accepted.sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    return a.snapshot.instrumentId < b.snapshot.instrumentId ? -1 : a.snapshot.instrumentId > b.snapshot.instrumentId ? 1 : 0;
  });
  rejected.sort((a, b) => {
    const byInstrument = a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
    if (byInstrument !== 0) return byInstrument;
    return a.reasons.join('|').localeCompare(b.reasons.join('|'));
  });
  auditInputs.sort((a, b) => {
    for (let i = 0; i < a.length; i++) {
      const av = a[i] ?? '';
      const bv = b[i] ?? '';
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
  const coverage: ScannerCoverage = {
    universeMembers: allowed.size,
    snapshotsProvided: [...counts.values()].reduce((sum, count) => sum + count, 0),
    evaluatedInstruments: [...counts.values()].filter((count) => count === 1).length,
    missingInstruments,
    duplicateInstruments,
    complete: missingInstruments.length === 0 && duplicateInstruments.length === 0,
  };
  const selected = accepted.slice(0, Math.max(0, definition.maxCandidates));
  const inputFingerprint = hashOf({
    engine: MARKET_SCANNER_VERSION,
    definition,
    universeFingerprint: universe.fingerprint,
    universePointInTimeSafe: universe.pointInTimeSafe,
    asOf,
    coverage,
    inputs: auditInputs,
    rejected,
    ranking: accepted.map((x) => [x.snapshot.instrumentId, x.score]),
  });
  const scannerRunId = 'scan_' + inputFingerprint.slice(0, 40);
  const candidates: ScannerCandidate[] = selected.map((x, index) => ({
    scannerRunId,
    instrumentId: x.snapshot.instrumentId,
    asOf,
    quantRunId: x.snapshot.quant.quantRunId,
    passedFilters: x.passed,
    failedFilters: x.failed,
    rankingScore: x.score,
    rank: index + 1,
    dataQualityStatus: x.snapshot.quant.dataQuality.severity,
    strictPointInTime: x.snapshot.quant.barDataProvenance.strictPointInTime,
  }));

  return {
    scannerRunId,
    inputFingerprint,
    definition: structuredClone(definition),
    definitionId: definition.id,
    definitionVersion: definition.version,
    universeId: universe.universeId,
    universeFingerprint: universe.fingerprint,
    universePointInTimeSafe: universe.pointInTimeSafe,
    asOf,
    coverage,
    rankingComplete: coverage.complete,
    candidates,
    rejected,
    inputsAvailableAt: inputsAvailableMs === null ? null : toUtcIso(inputsAvailableMs),
  };
}
