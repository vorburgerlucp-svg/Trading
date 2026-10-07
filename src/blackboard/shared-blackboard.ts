// Shared Blackboard: structured, append-only working memory of a decision. Models, Quant, the
// system and humans post typed entries instead of chatting. The evidence policy runs on every post:
//  - a "fact" needs verified evidence (known, visible, trusted, fresh); otherwise it is a hypothesis
//  - "calculation" belongs to the Quant Engine / system; a model's calculation is a hypothesis
//  - citing evidence that was not yet available at decision time is rejected (look-ahead)
//  - instruction-like text in model output is withheld before any other model can read it

import { randomUUID } from 'node:crypto';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import { scanForInjection } from '../security/untrusted-input.js';
import type { BlackboardEntry, BlackboardEntryInput, EntryEvidenceStatus } from './blackboard-types.js';

export class BlackboardError extends Error {
  override readonly name = 'BlackboardError';
}

export class SharedBlackboard {
  private constructor(
    private readonly log: AppendOnlyLog<BlackboardEntry>,
    private readonly evidence: EvidenceStore,
    private readonly newId: () => string,
  ) {}

  static async open(
    evidence: EvidenceStore,
    store: AppendOnlyStore<BlackboardEntry> = new InMemoryAppendOnlyStore(),
    options: { clock?: () => Date; newId?: () => string } = {},
  ): Promise<SharedBlackboard> {
    const log = await AppendOnlyLog.open<BlackboardEntry>('blackboard', store, options.clock ? { clock: options.clock } : {});
    // IDs come from a globally unique source, never a per-process counter (several NEXUS servers share the log).
    return new SharedBlackboard(log, evidence, options.newId ?? randomUUID);
  }

  /** Posts an entry as of decision time `asOf` and returns it with the category NEXUS accepted. */
  async post(input: BlackboardEntryInput, asOf: string): Promise<BlackboardEntry> {
    if (input.statement.trim() === '') throw new BlackboardError('statement is required');
    if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1)) throw new BlackboardError('confidence must be within 0..1');

    const assessments = input.evidenceRefs.map((id) => this.evidence.assess(id, asOf));
    const lookAhead = assessments.filter((a) => a.status === 'not_yet_available').map((a) => a.id);
    if (lookAhead.length > 0) throw new BlackboardError('look-ahead: evidence not available at ' + asOf + ': ' + lookAhead.join(', '));

    let evidenceStatus: EntryEvidenceStatus = 'verified';
    if (assessments.length === 0) evidenceStatus = 'missing';
    else if (assessments.some((a) => a.status === 'unknown')) evidenceStatus = 'unknown';
    else if (assessments.some((a) => !a.trusted)) evidenceStatus = 'untrusted';
    else if (assessments.some((a) => a.status === 'stale')) evidenceStatus = 'stale';

    let category = input.category;
    let statement = input.statement;
    let downgradeReason: string | undefined;
    // Second-order injection: a model influenced by external text must not pass instructions on to
    // the next model through the blackboard. Instruction-like model output is withheld.
    const injection = input.author.type === 'model' ? scanForInjection(input.statement) : [];
    if (injection.length > 0) {
      statement = '[QUARANTINED model output: instruction-like text withheld (' + injection.map((f) => f.rule).join(', ') + ')]';
      category = 'hypothesis';
      downgradeReason = 'instruction-like text in model output';
    } else if (input.category === 'calculation' && input.author.type === 'model') {
      category = 'hypothesis';
      downgradeReason = 'calculations are owned by the Quant Engine; a model calculation is a hypothesis';
    } else if ((input.category === 'fact' || input.category === 'calculation') && evidenceStatus !== 'verified') {
      category = 'hypothesis';
      downgradeReason = 'claimed as ' + input.category + ' but evidence is ' + evidenceStatus;
    }

    const id = input.taskId + ':bb:' + this.newId();
    const entry: BlackboardEntry = {
      ...input,
      statement,
      evidenceRefs: [...input.evidenceRefs],
      id,
      createdAt: asOf,
      requestedCategory: input.category,
      category,
      evidenceStatus,
      ...(downgradeReason !== undefined ? { downgradeReason } : {}),
    };
    return (await this.log.append(id, entry)).record.payload;
  }

  entries(taskId: string): BlackboardEntry[] {
    return this.log
      .all()
      .map((r) => r.payload)
      .filter((e) => e.taskId === taskId);
  }

  /**
   * Context a plan step may see. Non-model entries (system, quant, human) are always visible;
   * model entries only from the listed steps and never shadow output. Independent steps pass [].
   */
  visibleTo(taskId: string, visibleSteps: readonly string[]): BlackboardEntry[] {
    return this.entries(taskId).filter((e) => {
      if (e.author.type !== 'model') return true;
      return !e.author.shadow && e.author.stepId !== undefined && visibleSteps.includes(e.author.stepId);
    });
  }

  /** Catches up with records written by other NEXUS processes (verified). */
  sync(): Promise<void> {
    return this.log.sync();
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }
}
