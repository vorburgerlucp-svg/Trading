import type { BacktestBarKnowledge, BacktestDataProvenance, BacktestQuality, BacktestQualityContext, CorporateActionReasonCode } from './backtest-types.js';
import { CORPORATE_ACTION_REASON_TEXT } from './corporate-action-engine.js';
import type { UniverseEvidence } from '../universe/universe-model.js';

/**
 * Grade of a backtest. Its data provenance caps the grade; the return never enters.
 *   STRICT_PIT_DATA: every bar was known to NEXUS at the simulated use time AND has contemporaneous vintage. The first condition is
 *                    necessary by the specification; the second is added because a simulated timeline is market history: a
 *                    backfill replayed at its retrieval time does not simulate that history.
 *   HISTORICAL_RECONSTRUCTION: some bar was used before NEXUS held it, or has a historical vintage. Valid research, at most B.
 *   LEGACY_UNPROVEN: some bar was stored without provenance. At most C.
 */
export function assessBacktestQuality(
  context: BacktestQualityContext,
  tradeCount: number,
  ambiguousBars: number,
  zeroCostModel: boolean,
  bars: BacktestBarKnowledge,
  /** The corporate-action limitations the engine recorded. Each is reported under its own code, never merged. */
  corporateActionReasons: readonly CorporateActionReasonCode[] = [],
  /** The derived universe evidence the run cites (BacktestInput.universe). A caller boolean never reaches this. null/undefined: none cited. */
  universe?: UniverseEvidence | null,
): BacktestQuality {
  const reasons: string[] = [];
  const dataProvenance: BacktestDataProvenance =
    bars.legacy > 0 ? 'LEGACY_UNPROVEN' : bars.knownBeforeUse === bars.total && bars.contemporaneousVintage === bars.total ? 'STRICT_PIT_DATA' : 'HISTORICAL_RECONSTRUCTION';
  if (!context.dataComplete) return { grade: 'INVALID', reasons: ['market data is incomplete'], insufficientSample: tradeCount < context.minimumTrades, dataProvenance, barKnowledge: bars };

  let grade: BacktestQuality['grade'] = 'A';
  const downgrade = (target: 'B' | 'C', reason: string) => {
    reasons.push(reason);
    if (target === 'C' || grade === 'A') grade = target;
  };

  // The universe is proven by evidence or it is not proven. A caller's pointInTimeUniverse flag is never trusted (docs/PIT_UNIVERSE_V1.md).
  if (universe === undefined || universe === null) {
    downgrade('C', 'UNIVERSE_EVIDENCE_NOT_PROVIDED: no universe evidence is cited, so the universe is not proven');
    if (context.pointInTimeUniverse) downgrade('C', 'CALLER_UNIVERSE_CLAIM_NOT_PROVEN: a caller asserted point-in-time safety without evidence');
  } else if (universe.status === 'UNAVAILABLE') {
    downgrade('C', 'UNIVERSE_EVIDENCE_UNPROVEN: no universe revision was known at asOf');
  } else {
    if (!universe.complete) downgrade('C', 'UNIVERSE_COVERAGE_INCOMPLETE: the universe source snapshot is not complete');
    if (!universe.sourceProduction) downgrade('C', 'UNIVERSE_SOURCE_NOT_PRODUCTION: the universe source is not a production source');
    if (universe.historicalReconstruction) downgrade('B', 'UNIVERSE_HISTORICAL_RECONSTRUCTION: the universe membership is a historical reconstruction, not strict point-in-time evidence');
  }
  if (context.corporateActions !== 'modeled' || corporateActionReasons.length > 0) downgrade('C', 'corporate actions are not fully modeled');
  for (const code of corporateActionReasons) downgrade('C', code + ': ' + CORPORATE_ACTION_REASON_TEXT[code]);
  if (!context.providerProduction) downgrade('B', 'market data source is not production');
  if (bars.legacy > 0) downgrade('C', bars.legacy + ' bar(s) stored without provenance: their knowledge is unproven');
  else if (dataProvenance === 'HISTORICAL_RECONSTRUCTION') {
    if (bars.historicalVintage > 0) downgrade('B', bars.historicalVintage + ' bar(s) with historical reconstruction vintage: their market-time value is not proven');
    const early = bars.total - bars.knownBeforeUse;
    if (early > 0) downgrade('B', early + ' bar(s) were used before NEXUS held their revision');
  }
  if (zeroCostModel) downgrade('C', 'zero-cost model is not a realistic execution assumption');
  if (ambiguousBars > 0) downgrade('C', ambiguousBars + ' bar(s) had unresolved intrabar ordering');

  const insufficientSample = tradeCount < context.minimumTrades;
  if (insufficientSample) downgrade('C', 'INSUFFICIENT_SAMPLE: ' + tradeCount + ' trades, minimum ' + context.minimumTrades);
  return { grade, reasons, insufficientSample, dataProvenance, barKnowledge: bars };
}
