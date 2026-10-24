// O22 Plan B review R3: a privacy-preserving fingerprint of the configured broker ACCESS (the eToro credentials and environment), so
// that a write attempt and a portfolio read can be shown to have used the same configured access.
//
// What it is: HMAC-SHA256 under a separately managed NEXUS key (NEXUS_BROKER_ACCESS_HMAC_KEY, never a broker key) over a fixed,
// versioned message of broker, environment and both eToro keys. Only { version, keyId, fingerprint } is stored. The broker keys,
// the HMAC key and any account data are never stored, logged or returned; the fingerprint cannot be reversed or recomputed without
// the HMAC key, and it does not depend on any account identifier.
//
// What it proves: two records with matching fingerprints were made with the same configured credentials for the same environment.
// What it does NOT prove: that they belong to the same eToro ACCOUNT. NEXUS has no verified account identity (no CID is stored;
// /me's demoCid was never observed live). One account can have several key pairs (other fingerprint: refused, fail closed); the
// fingerprint says nothing about which account a key pair belongs to, and it cannot show that the broker served the same account.
//
// Rotation: every stamp names its keyId. The current key stamps new records; a previous key (with its own id) may be configured so
// that records stamped before a rotation can still be checked. A record whose keyId is neither the current nor the previous one
// cannot be checked: 'unknown_key' (fail closed). A changed broker key pair always gives 'mismatch' (fail closed).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ACCESS_FINGERPRINT_VERSION = 'nexus-broker-access-fingerprint:v1' as const;

/** What a record stores: never a key, only the key id and the HMAC. */
export interface AccessStamp {
  readonly version: typeof ACCESS_FINGERPRINT_VERSION;
  readonly keyId: string;
  /** HMAC-SHA256, lowercase hex (64 characters). */
  readonly fingerprint: string;
}

/**
 * The result of checking a stored stamp against the configured access:
 *   match         made with the configured credentials (under the current or the previous key)
 *   mismatch      made with other credentials or another environment
 *   missing       the record carries no stamp (for example every record made before this check existed, such as O22's)
 *   unknown_key   stamped under a key that is not configured (rotated out): cannot be checked
 *   not_configured  this process has no HMAC key: nothing can be checked
 * Only 'match' passes.
 */
export type AccessVerdict = 'match' | 'mismatch' | 'missing' | 'unknown_key' | 'not_configured';

export interface AccessKey {
  readonly id: string;
  readonly secret: string;
}

/** A key id: short, lowercase, no secret in it. */
export const ACCESS_KEY_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** A key: at least 32 printable characters (for example 64 hex characters of 32 random bytes). */
export const ACCESS_KEY_SECRET = /^[\x21-\x7e]{32,512}$/;

export class AccessFingerprintError extends Error {
  override readonly name = 'AccessFingerprintError';
}

function isStamp(value: unknown): value is AccessStamp {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === ACCESS_FINGERPRINT_VERSION && typeof v.keyId === 'string' && ACCESS_KEY_ID.test(v.keyId) && typeof v.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(v.fingerprint);
}

/** The checks a service needs; a process without an HMAC key has none (every check is 'not_configured'). */
export interface AccessVerifier {
  stamp(): AccessStamp;
  check(stamp: unknown): AccessVerdict;
}

export class BrokerAccessFingerprint implements AccessVerifier {
  private readonly message: string;
  private readonly keys: ReadonlyMap<string, string>;
  private readonly current: AccessKey;

  constructor(input: { broker: 'etoro'; environment: 'demo'; credentials: { apiKey: string; userKey: string }; current: AccessKey; previous?: AccessKey | null }) {
    const keys = [input.current, ...(input.previous ? [input.previous] : [])];
    for (const k of keys) {
      if (!ACCESS_KEY_ID.test(k.id)) throw new AccessFingerprintError('the access key id is invalid');
      if (!ACCESS_KEY_SECRET.test(k.secret)) throw new AccessFingerprintError('the access key must be 32 to 512 printable characters');
      if (k.secret === input.credentials.apiKey || k.secret === input.credentials.userKey) throw new AccessFingerprintError('the access key must not be a broker key');
    }
    if (input.previous && (input.previous.id === input.current.id || input.previous.secret === input.current.secret)) {
      throw new AccessFingerprintError('the previous access key must differ from the current one (id and key)');
    }
    // The keys enter the message only as their SHA-256 digests (fixed length, no separator ambiguity); the message itself is kept in
    // memory only. Domain-separated by version, broker and environment, so a real-money configuration can never match a demo one.
    const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    this.message = [ACCESS_FINGERPRINT_VERSION, input.broker, input.environment, digest(input.credentials.apiKey), digest(input.credentials.userKey)].join('\n');
    this.keys = new Map(keys.map((k) => [k.id, k.secret]));
    this.current = input.current;
  }

  private fingerprintUnder(secret: string): string {
    return createHmac('sha256', secret).update(this.message, 'utf8').digest('hex');
  }

  stamp(): AccessStamp {
    return Object.freeze({ version: ACCESS_FINGERPRINT_VERSION, keyId: this.current.id, fingerprint: this.fingerprintUnder(this.current.secret) });
  }

  check(stamp: unknown): AccessVerdict {
    if (stamp === undefined || stamp === null) return 'missing';
    if (!isStamp(stamp)) return 'mismatch';
    const secret = this.keys.get(stamp.keyId);
    if (secret === undefined) return 'unknown_key';
    const expected = Buffer.from(this.fingerprintUnder(secret), 'hex');
    const given = Buffer.from(stamp.fingerprint, 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given) ? 'match' : 'mismatch';
  }

  /** Never prints a key or the message. */
  toJSON(): { currentKeyId: string; previousKeyId: string | null } {
    return { currentKeyId: this.current.id, previousKeyId: [...this.keys.keys()].find((id) => id !== this.current.id) ?? null };
  }
}

/** The verifier of a process without an HMAC key: it stamps nothing and every check is 'not_configured' (fail closed). */
export const NO_ACCESS_VERIFIER = Object.freeze({
  stamp: (): AccessStamp => {
    throw new AccessFingerprintError('no broker access key is configured');
  },
  check: (): AccessVerdict => 'not_configured',
});

/** The refusal code of a verdict that does not pass, with a fixed prefix (null for 'match'). */
export function accessRefusal(prefix: string, verdict: AccessVerdict): string | null {
  switch (verdict) {
    case 'match':
      return null;
    case 'mismatch':
      return prefix + '_ACCESS_MISMATCH';
    case 'missing':
      return prefix + '_ACCESS_NOT_SHOWN';
    case 'unknown_key':
      return prefix + '_ACCESS_KEY_UNKNOWN';
    case 'not_configured':
      return prefix + '_ACCESS_NOT_CONFIGURED';
  }
}
