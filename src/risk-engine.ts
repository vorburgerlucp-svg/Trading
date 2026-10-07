import type { RiskDecision, TradePlan, TradingMode } from './contracts.js';

export interface RiskPolicy {
  mode:TradingMode;
  allowLiveTrading:boolean;
  maxPositionChf:number;
  minConfidence:number;
  minRiskReward:number;
}

export function assessRisk(plan:TradePlan, requestedPositionChf:number, policy:RiskPolicy):RiskDecision {
  const reasons:string[]=[];
  if(plan.decision==='watch'||plan.decision==='no_trade') reasons.push('signal is not executable: '+plan.decision);
  if(plan.confidence<policy.minConfidence) reasons.push('confidence below minimum');
  if(plan.riskReward<policy.minRiskReward) reasons.push('risk/reward below minimum');
  if(requestedPositionChf<=0) reasons.push('position must be positive');
  if(policy.mode==='live'&&!policy.allowLiveTrading) reasons.push('live trading safety lock is OFF');
  const cappedPositionChf=Math.max(0,Math.min(requestedPositionChf,plan.maxPositionChf,policy.maxPositionChf));
  if(cappedPositionChf===0) reasons.push('position cap resolved to zero');
  return {approved:reasons.length===0,reasons,cappedPositionChf};
}
