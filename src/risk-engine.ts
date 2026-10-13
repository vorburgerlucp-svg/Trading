import type { AllocationProposal } from './capital/capital-allocator.js';
import type { ReallocationProposal } from './capital/capital-reallocation.js';
import type { CapitalState, PortfolioSnapshot } from './capital/capital-types.js';
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

/** Result of the capital risk gate. `passed` never replaces a required human approval. */
export interface CapitalGateDecision {
  passed:boolean;
  requiresHumanApproval:boolean;
  reasons:string[];
}

/**
 * Independent re-check of an allocation proposal against the CURRENT capital state.
 * Catches stale proposals (state changed since proposing) and allocator bugs (defense in depth).
 */
export function assessAllocationProposal(proposal:AllocationProposal, current:CapitalState):CapitalGateDecision {
  const reasons:string[]=[];
  if(proposal.status!=='proposed') reasons.push('proposal is not in status proposed');
  if(proposal.basis.availableCapitalChf!==current.availableCapitalChf) reasons.push('capital state changed since the proposal was made; re-run the allocator');
  if(current.capitalShortfallChf>0n) reasons.push('safety reserve shortfall: no new allocations');
  let total=0n;
  const ids=new Set<string>();
  for(const allocation of proposal.allocations){
    if(allocation.amountChf<=0n) reasons.push('non-positive amount for '+allocation.opportunityId);
    if(ids.has(allocation.opportunityId)) reasons.push('duplicate allocation for '+allocation.opportunityId);
    ids.add(allocation.opportunityId);
    total+=allocation.amountChf;
  }
  if(total!==proposal.allocatedChf) reasons.push('allocation total does not match allocatedChf');
  if(total>current.availableCapitalChf) reasons.push('allocations exceed available capital');
  if(total>proposal.budgetChf) reasons.push('allocations exceed the proposal budget');
  return {passed:reasons.length===0,requiresHumanApproval:proposal.requiresHumanApproval,reasons};
}

/** Independent re-check of a reallocation proposal. Reallocations always require a human. */
export function assessReallocationProposal(proposal:ReallocationProposal, snapshot:PortfolioSnapshot):CapitalGateDecision {
  const reasons:string[]=[];
  if(proposal.status!=='proposed') reasons.push('proposal is not in status proposed');
  if(proposal.requiresHumanApproval!==true) reasons.push('reallocations must require human approval');
  const position=snapshot.positions.find(p=>p.isOpen&&p.brokerId===proposal.from.brokerId&&p.instrumentId===proposal.from.instrumentId);
  if(!position) reasons.push('source position is not open');
  else if(position.marketValueChf===null) reasons.push('DATA NOT CONNECTED: source position has no fresh market price');
  else if(proposal.from.reduceByChf>position.marketValueChf) reasons.push('reduction exceeds position market value');
  if(proposal.from.reduceByChf<=0n||proposal.to.amountChf<=0n) reasons.push('amounts must be positive');
  if(proposal.to.amountChf>proposal.from.reduceByChf-proposal.economics.exitCosts.totalChf) reasons.push('target amount exceeds net proceeds after exit costs');
  if(proposal.economics.netAdvantageChf<proposal.economics.requiredAdvantageChf) reasons.push('net advantage below hurdle');
  return {passed:reasons.length===0,requiresHumanApproval:true,reasons};
}
