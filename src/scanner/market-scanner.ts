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

  for (const snapshot of snapshots) {
    if (!allowed.has(snapshot.instrumentId)) continue;
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

  accepted.sort((a, b) => b.score - a.score || (a.snapshot.instrumentId < b.snapshot.instrumentId ? -1 : 1));
  const selected = accepted.slice(0, Math.max(0, definition.maxCandidates));
  const runFingerprint = hashOf({
    engine: MARKET_SCANNER_VERSION,
    definition,
    universeFingerprint: universe.fingerprint,
    asOf,
    inputs: selected.map((x) => [x.snapshot.instrumentId, x.snapshot.quant.quantRunId, x.snapshot.quant.inputFingerprint, x.snapshot.lastPrice.toString(), x.snapshot.averageVolume?.toString() ?? null, x.score]),
  });
  const scannerRunId = 'scan_' + runFingerprint.slice(0, 40);
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
    definitionId: definition.id,
    definitionVersion: definition.version,
    universeId: universe.universeId,
    universeFingerprint: universe.fingerprint,
    asOf,
    candidates,
    rejected,
  };
}
