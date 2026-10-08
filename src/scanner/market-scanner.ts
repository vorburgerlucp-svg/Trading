import { hashOf } from '../persistence/canonical-json.js';
import { parseUtc } from '../market-data/time.js';
import { evaluateScannerFilter, scannerRankingScore } from './scanner-filters.js';
import type { ScannerCandidate, ScannerDefinition, ScannerRun, ScannerSnapshot } from './scanner-types.js';
import type { UniverseSnapshot } from './universe.js';

export const MARKET_SCANNER_VERSION = 'market-scanner:v1';

export function runMarketScanner(definition: ScannerDefinition, universe: UniverseSnapshot, snapshots: readonly ScannerSnapshot[], asOf: string): ScannerRun {
  if (definition.universeId !== universe.universeId) throw new Error('scanner universe does not match universe snapshot');
  if (universe.asOf !== asOf) throw new Error('scanner asOf must match universe snapshot asOf');
  const asOfMs = parseUtc(asOf);
  const allowed = new Set(universe.members);
  const rejected: Array<{ instrumentId: string; reasons: string[] }> = [];
  const accepted: Array<{ snapshot: ScannerSnapshot; passed: string[]; failed: string[]; score: number }> = [];
  const auditInputs: Array<[string, string, string, string, string | null]> = [];

  for (const snapshot of snapshots) {
    if (!allowed.has(snapshot.instrumentId)) continue;
    auditInputs.push([
      snapshot.instrumentId,
      snapshot.quant.quantRunId,
      snapshot.quant.inputFingerprint,
      snapshot.lastPrice.toString(),
      snapshot.averageVolume?.toString() ?? null,
    ]);
    const reasons: string[] = [];
    if (snapshot.quant.instrumentId !== snapshot.instrumentId) reasons.push('quant instrument mismatch');
    if (parseUtc(snapshot.asOf) > asOfMs || parseUtc(snapshot.quant.asOf) > asOfMs) reasons.push('future snapshot');
    if (snapshot.quant.mode !== 'final_only') reasons.push('in-progress quant result');
    if (!snapshot.quant.dataQuality.usableForTrading) reasons.push('market data not usable for trading');

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
  rejected.sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
  auditInputs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const selected = accepted.slice(0, Math.max(0, definition.maxCandidates));
  const inputFingerprint = hashOf({
    engine: MARKET_SCANNER_VERSION,
    definition,
    universeFingerprint: universe.fingerprint,
    universePointInTimeSafe: universe.pointInTimeSafe,
    asOf,
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
    candidates,
    rejected,
  };
}
