import type { BarProvenanceCounts } from '../market-data/bar-replay.js';
import type { BacktestDataProvenance, BacktestQuality, BacktestQualityContext } from './backtest-types.js';

/**
 * Grade of a backtest. Its data provenance caps the grade; the return never enters: a large return on reconstructed bars is
 * still only as good as its data. STRICT_PIT_DATA: every bar was a proven revision NEXUS held before the engine used it.
 * HISTORICAL_RECONSTRUCTION: some bars have no proof of their vintage (valid research, grade at most B). LEGACY_UNPROVEN: some
 * bars were stored without provenance (grade at most C).
 */
export function assessBacktestQuality(context: BacktestQualityContext, tradeCount: number, ambiguousBars: number, zeroCostModel: boolean, bars: BarProvenanceCounts): BacktestQuality {
  const reasons: string[] = [];
  const dataProvenance: BacktestDataProvenance = bars.legacy > 0 ? 'LEGACY_UNPROVEN' : bars.historical > 0 ? 'HISTORICAL_RECONSTRUCTION' : 'STRICT_PIT_DATA';
  if (!context.dataComplete) return { grade: 'INVALID', reasons: ['market data is incomplete'], insufficientSample: tradeCount < context.minimumTrades, dataProvenance };

  let grade: BacktestQuality['grade'] = 'A';
  const downgrade = (target: 'B' | 'C', reason: string) => {
    reasons.push(reason);
    if (target === 'C' || grade === 'A') grade = target;
  };

  if (!context.pointInTimeUniverse) downgrade('C', 'instrument universe is not point-in-time safe');
  if (context.corporateActions !== 'modeled') downgrade('C', 'corporate actions are not fully modeled');
  if (!context.providerProduction) downgrade('B', 'market data source is not production');
  if (bars.legacy > 0) downgrade('C', bars.legacy + ' bar(s) stored without provenance: revision knowledge is unproven');
  if (bars.historical > 0) downgrade('B', bars.historical + ' bar(s) are historical reconstructions: bar vintages are not proven');
  if (zeroCostModel) downgrade('C', 'zero-cost model is not a realistic execution assumption');
  if (ambiguousBars > 0) downgrade('C', ambiguousBars + ' bar(s) had unresolved intrabar ordering');

  const insufficientSample = tradeCount < context.minimumTrades;
  if (insufficientSample) downgrade('C', 'INSUFFICIENT_SAMPLE: ' + tradeCount + ' trades, minimum ' + context.minimumTrades);
  return { grade, reasons, insufficientSample, dataProvenance };
}
