// Critic / Devil's Advocate is a ROLE (any provider can be assigned by the router).
// The critic sees the analysts' work and searches for reasons it is wrong; the counter-analyst builds
// the opposite case independently. Their risk flags are evidence-checked here:
// a "blocking" flag only blocks when its evidence is verified; otherwise it counts as "major".

import { CRITIC_CHECKS } from '../ai/model-types.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import type { AttemptRecord, AuthoredRiskFlag } from './nexus-types.js';

export const CRITIC_CHECKLIST = CRITIC_CHECKS;

export function assessRiskFlags(attempts: readonly AttemptRecord[], evidence: EvidenceStore, asOf: string): AuthoredRiskFlag[] {
  const flags: AuthoredRiskFlag[] = [];
  for (const attempt of attempts) {
    if (attempt.status !== 'ok' || attempt.shadow || !attempt.opinion) continue;
    for (const flag of attempt.opinion.riskFlags) {
      const verified =
        flag.evidenceRefIds.length > 0 &&
        flag.evidenceRefIds.every((id) => {
          const a = evidence.assess(id, asOf);
          return a.trusted && (a.status === 'fresh' || a.status === 'timeless');
        });
      flags.push({
        ...flag,
        modelKey: attempt.modelKey,
        role: attempt.role,
        verified,
        effectiveSeverity: flag.severity === 'blocking' && !verified ? 'major' : flag.severity,
      });
    }
  }
  return flags;
}
