import type { BacktestBarKnowledge, BacktestDataProvenance, BacktestQuality, BacktestQualityContext } from './backtest-types.js';

/**
 * Grade of a backtest. Its data provenance caps the grade; the return never enters.
 *   STRICT_PIT_DATA: every bar was known to NEXUS at the simulated use time AND has contemporaneous vintage. The first condition is
 *                    necessary by the specification; the second is added because a simulated timeline is market history: a
 *                    backfill replayed at its retrieval time does not simulate that history.
 *   HISTORICAL_RECONSTRUCTION: some bar was used before NEXUS held it, or has a historical vintage. Valid research, at most B.
 *   LEGACY_UNPROVEN: some bar was stored without provenance. At most C.
 */
export function assessBacktestQuality(context: BacktestQualityContext, tradeCount: number, ambiguousBars: number, zeroCostModel: boolean, bars: BacktestBarKnowledge): BacktestQuality {
  const reasons: string[] = [];
  const dataProvenance: BacktestDataProvenance =
    bars.legacy > 0 ? 'LEGACY_UNPROVEN' : bars.knownBeforeUse === bars.total && bars.contemporaneousVintage === bars.total ? 'STRICT_PIT_DATA' : 'HISTORICAL_RECONSTRUCTION';
  if (!context.dataComplete) return { grade: 'INVALID', reasons: ['market data is incomplete'], insufficientSample: tradeCount < context.minimumTrades, dataProvenance, barKnowledge: bars };

  let grade: BacktestQuality['grade'] = 'A';
  const downgrade = (target: 'B' | 'C', reason: string) => {
    reasons.push(reason);
    if (target === 'C' || grade === 'A') grade = target;
  };

  if (!context.pointInTimeUniverse) downgrade('C', 'instrument universe is not point-in-time safe');
  if (context.corporateActions !== 'modeled') downgrade('C', 'corporate actions are not fully modeled');
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
