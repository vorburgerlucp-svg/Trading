import type { AppendOnlyStore } from '../persistence/append-only-log.js';
import type {
  KillSwitchResetApproval,
  KillSwitchResetAuthorization,
  KillSwitchResetRequest,
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
  static async open(_store?: AppendOnlyStore<SafetyGovernanceEvent>): Promise<SafetyGovernanceStore> {
    throw new Error('O16 safety governance store not implemented');
  }

  async saveRequest(_request: KillSwitchResetRequest, _currentTripId: string): Promise<void> {
    throw new Error('O16 governance request store not implemented');
  }

  async saveApproval(_approval: KillSwitchResetApproval): Promise<void> {
    throw new Error('O16 governance approval store not implemented');
  }

  async saveAuthorization(_authorization: KillSwitchResetAuthorization): Promise<void> {
    throw new Error('O16 governance authorization store not implemented');
  }

  all(): readonly SafetyGovernanceEvent[] {
    throw new Error('O16 governance read not implemented');
  }
}
