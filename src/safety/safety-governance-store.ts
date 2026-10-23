import {
  AppendOnlyLog,
  InMemoryAppendOnlyStore,
  type AppendOnlyStore,
} from '../persistence/append-only-log.js';
import {
  KILL_SWITCH_RESET_APPROVAL_VERSION,
  KILL_SWITCH_RESET_AUTHORIZATION_VERSION,
  KILL_SWITCH_RESET_REQUEST_VERSION,
  verifyKillSwitchResetApprovalArtifact,
  verifyKillSwitchResetAuthorizationArtifact,
  verifyKillSwitchResetRequestArtifact,
  type KillSwitchResetApproval,
  type KillSwitchResetAuthorization,
  type KillSwitchResetRequest,
} from './kill-switch-reset-authorization.js';

export const SAFETY_GOVERNANCE_EVENT_VERSION = 'safety-governance-event:v1' as const;

export type SafetyGovernanceEvent =
  | { version: typeof SAFETY_GOVERNANCE_EVENT_VERSION; type: 'RESET_REQUESTED'; artifact: KillSwitchResetRequest }
  | { version: typeof SAFETY_GOVERNANCE_EVENT_VERSION; type: 'RESET_APPROVED'; artifact: KillSwitchResetApproval }
  | { version: typeof SAFETY_GOVERNANCE_EVENT_VERSION; type: 'RESET_REJECTED'; artifact: KillSwitchResetApproval }
  | { version: typeof SAFETY_GOVERNANCE_EVENT_VERSION; type: 'RESET_AUTHORIZED'; artifact: KillSwitchResetAuthorization };

export class SafetyGovernanceStoreError extends Error {
  override readonly name = 'SafetyGovernanceStoreError';
  constructor(
    readonly code:
      | 'INVALID_EVENT'
      | 'UNKNOWN_REQUEST'
      | 'TERMINAL_EXISTS'
      | 'AUTHORIZATION_NOT_ALLOWED'
      | 'STALE_TRIP',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export class SafetyGovernanceStore {
  private constructor(private readonly log: AppendOnlyLog<SafetyGovernanceEvent>) {}

  static async open(
    store: AppendOnlyStore<SafetyGovernanceEvent> = new InMemoryAppendOnlyStore<SafetyGovernanceEvent>(),
  ): Promise<SafetyGovernanceStore> {
    const instance = new SafetyGovernanceStore(
      await AppendOnlyLog.open<SafetyGovernanceEvent>('safety-governance', store),
    );
    instance.validateHistory();
    return instance;
  }

  async saveRequest(request: KillSwitchResetRequest, currentTripId: string): Promise<void> {
    try {
      verifyKillSwitchResetRequestArtifact(request);
    } catch (error) {
      throw new SafetyGovernanceStoreError('INVALID_EVENT', error instanceof Error ? error.message : String(error));
    }
    if (request.tripId !== currentTripId) {
      throw new SafetyGovernanceStoreError('STALE_TRIP', 'reset request does not reference the current persisted trip');
    }
    await this.log.append(request.requestId, {
      version: SAFETY_GOVERNANCE_EVENT_VERSION,
      type: 'RESET_REQUESTED',
      artifact: request,
    });
  }

  async saveApproval(approval: KillSwitchResetApproval): Promise<void> {
    try {
      verifyKillSwitchResetApprovalArtifact(approval);
    } catch (error) {
      throw new SafetyGovernanceStoreError('INVALID_EVENT', error instanceof Error ? error.message : String(error));
    }

    await this.log.append(approval.approvalId, {
      version: SAFETY_GOVERNANCE_EVENT_VERSION,
      type: approval.decision === 'APPROVE' ? 'RESET_APPROVED' : 'RESET_REJECTED',
      artifact: approval,
    }, {
      precondition: () => {
        const request = this.requestEvent(approval.requestId);
        if (!request) throw new SafetyGovernanceStoreError('UNKNOWN_REQUEST', 'approval references an unknown request');
        if (request.artifact.requestFingerprint !== approval.requestFingerprint) {
          throw new SafetyGovernanceStoreError('INVALID_EVENT', 'approval request fingerprint does not match stored request');
        }
        if (this.terminalFor(approval.requestId)) {
          throw new SafetyGovernanceStoreError('TERMINAL_EXISTS', 'reset request already has a terminal human decision');
        }
      },
    });
  }

  async saveAuthorization(authorization: KillSwitchResetAuthorization): Promise<void> {
    try {
      verifyKillSwitchResetAuthorizationArtifact(authorization);
    } catch (error) {
      throw new SafetyGovernanceStoreError('INVALID_EVENT', error instanceof Error ? error.message : String(error));
    }

    await this.log.append(authorization.authorizationId, {
      version: SAFETY_GOVERNANCE_EVENT_VERSION,
      type: 'RESET_AUTHORIZED',
      artifact: authorization,
    }, {
      precondition: () => {
        const request = this.requestEvent(authorization.requestId);
        if (!request) throw new SafetyGovernanceStoreError('UNKNOWN_REQUEST', 'authorization references an unknown request');
        if (request.artifact.tripId !== authorization.tripId) {
          throw new SafetyGovernanceStoreError('STALE_TRIP', 'authorization trip differs from stored request');
        }
        const terminal = this.terminalFor(authorization.requestId);
        if (!terminal || terminal.type !== 'RESET_APPROVED') {
          throw new SafetyGovernanceStoreError('AUTHORIZATION_NOT_ALLOWED', 'authorization requires one stored APPROVE decision');
        }
        if (terminal.artifact.approvalId !== authorization.approvalId) {
          throw new SafetyGovernanceStoreError('AUTHORIZATION_NOT_ALLOWED', 'authorization approval differs from stored approval');
        }
        if (this.authorizationFor(authorization.requestId)) {
          throw new SafetyGovernanceStoreError('AUTHORIZATION_NOT_ALLOWED', 'reset request is already authorized');
        }
      },
    });
  }

  all(): readonly SafetyGovernanceEvent[] {
    return this.log.all().map((record) => record.payload);
  }

  sync(): Promise<void> {
    return this.log.sync().then(() => this.validateHistory());
  }

  private requestEvent(requestId: string): Extract<SafetyGovernanceEvent, { type: 'RESET_REQUESTED' }> | undefined {
    return this.all().find(
      (event): event is Extract<SafetyGovernanceEvent, { type: 'RESET_REQUESTED' }> =>
        event.type === 'RESET_REQUESTED' && event.artifact.requestId === requestId,
    );
  }

  private terminalFor(requestId: string):
    | Extract<SafetyGovernanceEvent, { type: 'RESET_APPROVED' | 'RESET_REJECTED' }>
    | undefined {
    return this.all().find(
      (event): event is Extract<SafetyGovernanceEvent, { type: 'RESET_APPROVED' | 'RESET_REJECTED' }> =>
        (event.type === 'RESET_APPROVED' || event.type === 'RESET_REJECTED') &&
        event.artifact.requestId === requestId,
    );
  }

  private authorizationFor(requestId: string): Extract<SafetyGovernanceEvent, { type: 'RESET_AUTHORIZED' }> | undefined {
    return this.all().find(
      (event): event is Extract<SafetyGovernanceEvent, { type: 'RESET_AUTHORIZED' }> =>
        event.type === 'RESET_AUTHORIZED' && event.artifact.requestId === requestId,
    );
  }

  private validateHistory(): void {
    const requests = new Map<string, KillSwitchResetRequest>();
    const terminals = new Set<string>();
    const authorizations = new Set<string>();

    for (const event of this.all()) {
      if (!event || event.version !== SAFETY_GOVERNANCE_EVENT_VERSION) {
        throw new SafetyGovernanceStoreError('INVALID_EVENT', 'stored governance event version is invalid');
      }
      try {
        if (event.type === 'RESET_REQUESTED') {
          if (event.artifact.version !== KILL_SWITCH_RESET_REQUEST_VERSION) throw new Error('request version mismatch');
          verifyKillSwitchResetRequestArtifact(event.artifact);
          if (requests.has(event.artifact.requestId)) throw new Error('duplicate request');
          requests.set(event.artifact.requestId, event.artifact);
          continue;
        }
        if (event.type === 'RESET_APPROVED' || event.type === 'RESET_REJECTED') {
          if (event.artifact.version !== KILL_SWITCH_RESET_APPROVAL_VERSION) throw new Error('approval version mismatch');
          verifyKillSwitchResetApprovalArtifact(event.artifact);
          const request = requests.get(event.artifact.requestId);
          if (!request) throw new Error('approval before request');
          if (request.requestFingerprint !== event.artifact.requestFingerprint) throw new Error('approval request fingerprint mismatch');
          if (terminals.has(event.artifact.requestId)) throw new Error('duplicate terminal decision');
          if ((event.type === 'RESET_APPROVED') !== (event.artifact.decision === 'APPROVE')) throw new Error('approval event type mismatch');
          terminals.add(event.artifact.requestId);
          continue;
        }
        if (event.type === 'RESET_AUTHORIZED') {
          if (event.artifact.version !== KILL_SWITCH_RESET_AUTHORIZATION_VERSION) throw new Error('authorization version mismatch');
          verifyKillSwitchResetAuthorizationArtifact(event.artifact);
          const request = requests.get(event.artifact.requestId);
          if (!request) throw new Error('authorization before request');
          const terminal = this.all().find(
            (candidate) =>
              candidate.type === 'RESET_APPROVED' &&
              candidate.artifact.requestId === event.artifact.requestId &&
              candidate.artifact.approvalId === event.artifact.approvalId,
          );
          if (!terminal) throw new Error('authorization without matching approval');
          if (authorizations.has(event.artifact.requestId)) throw new Error('duplicate authorization');
          authorizations.add(event.artifact.requestId);
          continue;
        }
        throw new Error('unknown governance event type');
      } catch (error) {
        throw new SafetyGovernanceStoreError('INVALID_EVENT', error instanceof Error ? error.message : String(error));
      }
    }
  }
}
