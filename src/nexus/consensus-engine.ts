// Consensus Engine: does not average answers. It separates facts, calculations, forecasts and
// opinions, makes contradictions explicit and keeps MARKET VIEW (direction) apart from ACTION
// (execution). "Everyone is bullish" can still end in NO_ACTION (event risk, stale data, no quant).
//
// Rules, in order:
//  1. too few valid independent opinions                      → insufficient, NO_ACTION
//  2. bullish and bearish analysts                            → contested, NO_ACTION (no invented agreement)
//  3. analysts recommend different actions (unanimity rule)   → NO_ACTION
//  4. quant required but missing / contradicting              → NO_ACTION
//  5. stale or missing key evidence                           → NO_ACTION (not a current decision)
//  6. quarantined external input                              → NO_ACTION, human review
//  7. verified blocking finding (critic / counter / analyst)  → NO_ACTION, direction kept
//  8. strict mode (critical depth): any major finding         → NO_ACTION
//  9. only a unanimous "buy"/"sell" proceeds to the risk engine; hold/no_trade → NO_ACTION

import type { ModelKey, ModelOpinion } from '../ai/model-types.js';
import type { BlackboardEntry } from '../blackboard/blackboard-types.js';
import type { AuthoredRiskFlag, ConsensusResult, Contradiction, QuantAssessment, TaskPlan } from './nexus-types.js';

export interface ConsensusInput {
  plan: TaskPlan;
  analysts: { modelKey: ModelKey; opinion: ModelOpinion }[];
  findings: AuthoredRiskFlag[];
  quant: QuantAssessment | null;
  requiresQuant: boolean;
  staleKeyEvidence: string[];
  missingKeyEvidence: string[];
  quarantinedEvidence: string[];
  insufficientAnalysis: string[];
  entries: BlackboardEntry[];
}

export function buildConsensus(input: ConsensusInput): ConsensusResult {
  const blocking: string[] = [];
  const codes = new Set<string>();
  const block = (code: string, reason: string) => {
    codes.add(code);
    blocking.push(reason);
  };
  for (const reason of input.insufficientAnalysis) block('INSUFFICIENT_ANALYSIS', reason);
  const contradictions: Contradiction[] = [];
  const voting = input.analysts.filter((a) => a.opinion.stance !== 'insufficient_data');
  const votes = voting.map((a) => ({ modelKey: a.modelKey, stance: a.opinion.stance, recommendation: a.opinion.recommendation, confidence: a.opinion.confidence }));

  let direction: ConsensusResult['direction'];
  if (voting.length < input.plan.minIndependentOpinions) {
    direction = 'insufficient';
    block('INSUFFICIENT_ANALYSIS', 'insufficient analysis: ' + voting.length + ' valid independent opinions, ' + input.plan.minIndependentOpinions + ' required');
  } else {
    const bulls = voting.filter((v) => v.opinion.stance === 'bullish');
    const bears = voting.filter((v) => v.opinion.stance === 'bearish');
    if (bulls.length > 0 && bears.length > 0) {
      direction = 'contested';
      contradictions.push({
        between: [...bulls, ...bears].map((v) => v.modelKey),
        about: 'direction',
        statements: [...bulls, ...bears].map((v) => v.modelKey + ': ' + v.opinion.stance + ' / ' + v.opinion.recommendation),
      });
      block('CONTRADICTION_DIRECTION', 'contradiction: analysts disagree on direction');
    } else {
      direction = bulls.length > 0 ? 'bullish' : bears.length > 0 ? 'bearish' : 'neutral';
    }
  }

  const actions = new Set(voting.map((v) => v.opinion.recommendation));
  let recommendation: ConsensusResult['recommendation'] = actions.size === 1 ? ([...actions][0] ?? null) : null;
  if (actions.size > 1) {
    recommendation = null;
    if (!contradictions.some((c) => c.about === 'direction')) {
      contradictions.push({ between: voting.map((v) => v.modelKey), about: 'action', statements: voting.map((v) => v.modelKey + ': ' + v.opinion.recommendation) });
    }
    if (input.plan.requireUnanimity) block('NO_UNANIMOUS_ACTION', 'no unanimous action: ' + [...actions].join(' vs '));
  }

  if (input.requiresQuant) {
    if (input.quant === null || input.quant.status === 'not_available') {
      block('QUANT_NOT_AVAILABLE', 'quant verification not available (Quant Engine not connected)');
    } else if (input.quant.status === 'contradicts' || (input.quant.direction && (direction === 'bullish' || direction === 'bearish') && input.quant.direction !== direction)) {
      contradictions.push({ between: ['quant', ...votes.map((v) => v.modelKey)], about: 'quant_vs_ai', statements: ['quant: ' + (input.quant.direction ?? input.quant.status), 'council: ' + direction] });
      block('QUANT_DISAGREES', 'quant does not confirm the council');
    }
  }

  if (input.staleKeyEvidence.length > 0) block('STALE_KEY_EVIDENCE', 'stale market data (' + input.staleKeyEvidence.join(', ') + '): not releasable as a current trading decision');
  if (input.missingKeyEvidence.length > 0) block('MISSING_KEY_EVIDENCE', 'key evidence missing or not available at decision time: ' + input.missingKeyEvidence.join(', '));
  if (input.quarantinedEvidence.length > 0) block('PROMPT_INJECTION_SUSPECTED', 'suspected prompt injection in external input (' + input.quarantinedEvidence.join(', ') + '): human review required');

  const findings = {
    blocking: input.findings.filter((f) => f.effectiveSeverity === 'blocking'),
    major: input.findings.filter((f) => f.effectiveSeverity === 'major'),
    minor: input.findings.filter((f) => f.effectiveSeverity === 'minor'),
  };
  for (const f of findings.blocking) block('BLOCKING_FINDING_' + f.check.toUpperCase(), f.check + ' (' + f.role + ' ' + f.modelKey + '): ' + f.statement);
  if (input.plan.strictRisk) for (const f of findings.major) block('STRICT_MODE_MAJOR_FINDING', 'strict mode, unresolved ' + f.check + ' (' + f.modelKey + '): ' + f.statement);

  if (blocking.length === 0 && (recommendation === 'hold' || recommendation === 'no_trade')) block('COUNCIL_RECOMMENDS_' + recommendation.toUpperCase(), 'council recommends ' + recommendation);

  const confidences = votes.map((v) => v.confidence);
  const confidenceRange = confidences.length === 0 ? null : { min: Math.min(...confidences), max: Math.max(...confidences) };
  const uncertainty: ConsensusResult['uncertainty'] =
    direction === 'contested' || direction === 'insufficient' || findings.blocking.length > 0 || (confidenceRange !== null && confidenceRange.max - confidenceRange.min > 0.3)
      ? 'high'
      : findings.major.length > 0 || votes.length === 1
        ? 'medium'
        : 'low';

  const ids = (...categories: BlackboardEntry['category'][]) =>
    input.entries.filter((e) => !e.author.shadow && categories.includes(e.category)).map((e) => e.id);

  return {
    direction,
    execution: blocking.length === 0 && (recommendation === 'buy' || recommendation === 'sell') ? 'PROCEED_TO_RISK' : 'NO_ACTION',
    recommendation,
    votes,
    confidenceRange,
    contradictions,
    knowledge: {
      facts: ids('fact'),
      calculations: ids('calculation'),
      forecasts: ids('hypothesis', 'catalyst'),
      opinions: ids('recommendation'),
      risks: ids('risk', 'critique'),
      contradictions: ids('contradiction'),
    },
    findings,
    uncertainty,
    blockingReasons: blocking,
    blockingCodes: [...codes],
  };
}
