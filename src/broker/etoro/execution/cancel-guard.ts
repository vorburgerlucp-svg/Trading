// O22 cancel review: what a cancel write needs before it is sent. A pure function; the service gathers the stored facts and runs it
// before the write and again inside the attempt log's lock.
//
// A cancel sends DELETE /orders/{orderId} with the CURRENT configured credentials. Without this check, a process configured with other
// eToro credentials (another account, a new key pair) would send it for an order id taken from the logs. So, fail closed:
//   - the intent has exactly one started open attempt                                 CANCEL_OPEN_ATTEMPT_NOT_UNIQUE
//   - the order to cancel is the one the broker named for exactly that attempt: its open_accepted answer (same request id) or a
//     checked "found" reconciliation of its reference id (the same request id)         CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT
//   - that attempt was sent with the configured broker access                          CANCEL_TARGET_OPEN_ACCESS_MISMATCH / _NOT_SHOWN /
//                                                                                       _KEY_UNKNOWN / _NOT_CONFIGURED
// The access check shows the same configured credentials, not a verified account (etoro-access-fingerprint.ts). There is no exception
// for a risk-reducing cancel; such an exception would be a separate, documented policy that needs its own explicit approval.

import { accessRefusal, type AccessVerdict } from '../etoro-access-fingerprint.js';

export interface CancelFacts {
  /** The order the cancel would name (the intent's broker order id). */
  readonly brokerOrderId: number | null;
  /** The started open attempts of the intent (normally exactly one). */
  readonly openAttempts: readonly { readonly requestId: string | null; readonly access?: unknown }[];
  /** The intent's open_accepted answers. */
  readonly acceptedAnswers: readonly { readonly requestId: string | null; readonly brokerOrderId: number | null }[];
  /** The intent's "found" reconciliations. */
  readonly foundReconciliations: readonly { readonly referenceId: string; readonly brokerOrderId: number | null; readonly checked?: true }[];
  readonly checkAccess: (stamp: unknown) => AccessVerdict;
}

export function cancelRefusals(facts: CancelFacts): string[] {
  if (facts.openAttempts.length !== 1) return ['CANCEL_OPEN_ATTEMPT_NOT_UNIQUE'];
  const attempt = facts.openAttempts[0]!;
  const reasons: string[] = [];
  const order = facts.brokerOrderId;
  const accepted = facts.acceptedAnswers.some((a) => attempt.requestId !== null && a.requestId === attempt.requestId && a.brokerOrderId === order);
  const found = facts.foundReconciliations.some((r) => r.checked === true && attempt.requestId !== null && r.referenceId === attempt.requestId && r.brokerOrderId === order);
  if (order === null || (!accepted && !found)) reasons.push('CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT');
  const access = accessRefusal('CANCEL_TARGET_OPEN', facts.checkAccess(attempt.access ?? null));
  if (access !== null) reasons.push(access);
  return reasons;
}
