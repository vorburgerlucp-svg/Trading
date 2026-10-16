// Local operator authentication of the O21 demo execution control plane. Loopback is not authentication: every mutating demo
// intent route needs "Authorization: Bearer <token>" with the configured operator token, and the operator identity comes from the
// server configuration, never from a request body.
//
// Only a SHA-256 digest of the token is kept in memory; the comparison is constant time on equal-length digests. The token is never
// logged, persisted, returned or placed in an error.

import { createHash, timingSafeEqual } from 'node:crypto';

export interface OperatorIdentity {
  readonly kind: 'human';
  readonly id: string;
}

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class OperatorAuthenticator {
  private readonly tokenDigest: Buffer;
  private readonly identity: OperatorIdentity;

  constructor(operator: { readonly id: string; readonly token: string }) {
    this.tokenDigest = digest(operator.token);
    this.identity = Object.freeze({ kind: 'human' as const, id: operator.id });
  }

  /** The authenticated operator, or null. A missing, malformed or wrong credential is null; nothing about it is reported. */
  authenticate(authorization: string | undefined): OperatorIdentity | null {
    if (typeof authorization !== 'string') return null;
    const match = BEARER.exec(authorization);
    const presented = digest(match?.[1] ?? '');
    // Compare even for a malformed header, so the timing does not tell a malformed header from a wrong token.
    const equal = timingSafeEqual(presented, this.tokenDigest);
    return match !== null && equal ? this.identity : null;
  }
}
