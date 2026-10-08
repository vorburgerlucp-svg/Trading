import type { BacktestQuality, BacktestQualityContext } from './backtest-types.js';

export function assessBacktestQuality(context: BacktestQualityContext, tradeCount: number, ambiguousBars: number, zeroCostModel: boolean): BacktestQuality {
  const reasons: string[] = [];
  if (!context.dataComplete) return { grade: 'INVALID', reasons: ['market data is incomplete'], insufficientSample: tradeCount < context.minimumTrades };

  let grade: BacktestQuality['grade'] = 'A';
  const downgrade = (target: 'B' | 'C', reason: string) => {
    reasons.push(reason);
    if (target === 'C' || grade === 'A') grade = target;
  };

  if (!context.pointInTimeUniverse) downgrade('C', 'instrument universe is not point-in-time safe');
  if (context.corporateActions !== 'modeled') downgrade('C', 'corporate actions are not fully modeled');
  if (!context.providerProduction) downgrade('B', 'market data source is not production');
  if (zeroCostModel) downgrade('C', 'zero-cost model is not a realistic execution assumption');
  if (ambiguousBars > 0) downgrade('C', ambiguousBars + ' bar(s) had unresolved intrabar ordering');

  const insufficientSample = tradeCount < context.minimumTrades;
  if (insufficientSample) downgrade('C', 'INSUFFICIENT_SAMPLE: ' + tradeCount + ' trades, minimum ' + context.minimumTrades);
  return { grade, reasons, insufficientSample };
}
