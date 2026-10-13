// Slim, normalized decision record: identities and references only. The details (model runs,
// consensus, risk, capital proposal, approval) live in audit events referenced by id, and the capital
// state is referenced by its exact ledger position (sequence + hash), so a decision can be rebuilt.

import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore, type LogAppendResult } from '../persistence/append-only-log.js';

export type FinalAction = 'NO_ACTION' | 'WATCH' | 'RECOMMEND' | 'REJECT';
export const FINAL_ACTIONS: readonly FinalAction[] = ['NO_ACTION', 'WATCH', 'RECOMMEND', 'REJECT'];

export interface DecisionRecord {
  decisionId: string;
  taskId: string;
  createdAt: string;
  asOf: string;
  /** Hash over task, question, asOf, evidence versions, capital state ref, quant input and opportunity. */
  inputFingerprint: string;
  evidenceRefs: string[];
  /** Audit event ids of MODEL_RESPONSE_RECEIVED events (one per model call, incl. failures and shadow runs). */
  modelRuns: string[];
  quantResultRef?: string;
  consensusRef?: string;
  riskDecisionRef?: string;
  /** "ledger:<ledgerId>@<sequence>:<hash>#asOf=<iso>" */
  capitalStateRef?: string;
  humanApprovalRef?: string;
  finalAction: FinalAction;
  reasonCodes: string[];
}

export class DecisionRecordError extends Error {
  override readonly name = 'DecisionRecordError';
}

export class DecisionRecordStore {
  private constructor(private readonly log: AppendOnlyLog<DecisionRecord>) {}

  static async open(store: AppendOnlyStore<DecisionRecord> = new InMemoryAppendOnlyStore(), options: { clock?: () => Date } = {}): Promise<DecisionRecordStore> {
    return new DecisionRecordStore(await AppendOnlyLog.open('decisions', store, options));
  }

  async save(record: DecisionRecord): Promise<LogAppendResult<DecisionRecord>> {
    if (!FINAL_ACTIONS.includes(record.finalAction)) throw new DecisionRecordError('invalid finalAction ' + record.finalAction);
    if (!/^[0-9a-f]{64}$/.test(record.inputFingerprint)) throw new DecisionRecordError('inputFingerprint must be a sha256 hex digest');
    if ([record.createdAt, record.asOf].some((t) => Number.isNaN(Date.parse(t)))) throw new DecisionRecordError('timestamps must be ISO');
    if (record.reasonCodes.some((c) => !/^[A-Z][A-Z0-9_]*$/.test(c))) throw new DecisionRecordError('reason codes must be UPPER_SNAKE_CASE');
    return this.log.append(record.decisionId, record);
  }

  get(decisionId: string): DecisionRecord | undefined {
    return this.log.get(decisionId)?.payload;
  }

  byTask(taskId: string): DecisionRecord[] {
    return this.log
      .all()
      .map((r) => r.payload)
      .filter((d) => d.taskId === taskId);
  }

  sync(): Promise<void> {
    return this.log.sync();
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }
}
