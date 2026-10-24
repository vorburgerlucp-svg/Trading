// O22 Plan B review R3: the broker access fingerprint. HMAC-SHA256 under a separately managed NEXUS key over the configured eToro
// credentials and environment; only { version, keyId, fingerprint } is stored. It shows the same configured CREDENTIALS, never the
// same eToro ACCOUNT. Unit tests of the primitive, the configuration, and its use in the execution service and the attestation
// (account switch, key rotation, missing stamps, a restart). No network. Two processes on PostgreSQL: o22-access-fingerprint.pg.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: filledOpen() exercises the write path, so this module replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { ACCESS_FINGERPRINT_VERSION, AccessFingerprintError, BrokerAccessFingerprint, NO_ACCESS_VERIFIER, accessRefusal } from '../../../src/broker/etoro/etoro-access-fingerprint.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig } from '../../../src/runtime/config.js';
import { API_KEY_MARKER, CREATOR, HUMAN, TEST_ACCESS, TEST_ACCESS_KEY, USER_KEY_MARKER, closeInput, filledOpen, o21Fixture, openInput, testAccess, type Fixture } from './o21-fixture.js';
import { POSITION, closureProcess, filledThenClosedByHand, inMemoryEtoroStores } from './o22-external-closure-scenario.js';

const OTHER_USER_KEY = 'O22-OTHER-ACCOUNT-USER-KEY-MARKER-000000000000000000000000003';
const K2 = Object.freeze({ id: 'test-k2', secret: 'O22-TEST-ACCESS-HMAC-KEY-MARKER-ROTATED-fedcba9876543210' });

async function reasons(promise: Promise<unknown>): Promise<readonly string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return error.reasons;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('R3: the fingerprint primitive', () => {
  it('is deterministic, versioned, names its key id, and contains no key', () => {
    const stamp = TEST_ACCESS.stamp();
    expect(stamp).toEqual({ version: ACCESS_FINGERPRINT_VERSION, keyId: 'test-k1', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(testAccess().stamp()).toEqual(stamp);
    const everything = JSON.stringify({ stamp, verifier: TEST_ACCESS });
    for (const secret of [API_KEY_MARKER, USER_KEY_MARKER, TEST_ACCESS_KEY.secret]) expect(everything).not.toContain(secret);
    expect(JSON.parse(JSON.stringify(TEST_ACCESS))).toEqual({ currentKeyId: 'test-k1', previousKeyId: null });
  });

  it('other credentials (an account switch, or a new key pair of the same account) do not match', () => {
    const other = testAccess({ userKey: OTHER_USER_KEY });
    expect(other.stamp().fingerprint).not.toBe(TEST_ACCESS.stamp().fingerprint);
    expect(TEST_ACCESS.check(other.stamp())).toBe('mismatch');
    expect(other.check(TEST_ACCESS.stamp())).toBe('mismatch');
  });

  it('the same credentials under another HMAC key give another fingerprint (not linkable without the key)', () => {
    expect(testAccess({ current: K2 }).stamp().fingerprint).not.toBe(TEST_ACCESS.stamp().fingerprint);
  });

  it('the environment is part of the message: a stamp of another environment does not match', () => {
    const real = new BrokerAccessFingerprint({ broker: 'etoro', environment: 'real' as 'demo', credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, current: TEST_ACCESS_KEY });
    expect(TEST_ACCESS.check(real.stamp())).toBe('mismatch');
  });

  it('rotation: a previous key checks old stamps; without it they cannot be checked (unknown_key); a changed key pair never matches', () => {
    const old = TEST_ACCESS.stamp();
    const rotated = testAccess({ current: K2, previous: TEST_ACCESS_KEY });
    expect(rotated.stamp().keyId).toBe('test-k2');
    expect(rotated.check(old)).toBe('match');
    expect(rotated.check(rotated.stamp())).toBe('match');
    expect(testAccess({ current: K2 }).check(old)).toBe('unknown_key');
    expect(testAccess({ current: K2, previous: TEST_ACCESS_KEY, userKey: OTHER_USER_KEY }).check(old)).toBe('mismatch');
    // Before the rotation, a process that only knows k1 cannot check a k2 stamp.
    expect(TEST_ACCESS.check(rotated.stamp())).toBe('unknown_key');
  });

  it('missing, malformed and forged stamps', () => {
    expect(TEST_ACCESS.check(undefined)).toBe('missing');
    expect(TEST_ACCESS.check(null)).toBe('missing');
    expect(TEST_ACCESS.check({ version: ACCESS_FINGERPRINT_VERSION, keyId: 'test-k1' })).toBe('mismatch');
    expect(TEST_ACCESS.check({ ...TEST_ACCESS.stamp(), version: 'v0' })).toBe('mismatch');
    expect(TEST_ACCESS.check({ ...TEST_ACCESS.stamp(), fingerprint: '0'.repeat(64) })).toBe('mismatch');
    expect(TEST_ACCESS.check('a string')).toBe('mismatch');
  });

  it('a process without a key checks nothing (not_configured) and stamps nothing', () => {
    expect(NO_ACCESS_VERIFIER.check()).toBe('not_configured');
    expect(() => NO_ACCESS_VERIFIER.stamp()).toThrow(AccessFingerprintError);
  });

  it('refuses a short key, a key that is a broker key, an invalid id, and a previous key equal to the current one', () => {
    const make = (current: { id: string; secret: string }, previous: { id: string; secret: string } | null = null) =>
      () => new BrokerAccessFingerprint({ broker: 'etoro', environment: 'demo', credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, current, previous });
    expect(make({ id: 'k', secret: 'short' })).toThrow(AccessFingerprintError);
    expect(make({ id: 'k', secret: USER_KEY_MARKER })).toThrow(AccessFingerprintError);
    expect(make({ id: 'K UPPER', secret: TEST_ACCESS_KEY.secret })).toThrow(AccessFingerprintError);
    expect(make(TEST_ACCESS_KEY, { id: 'test-k1', secret: K2.secret })).toThrow(AccessFingerprintError);
    expect(make(TEST_ACCESS_KEY, { id: 'other', secret: TEST_ACCESS_KEY.secret })).toThrow(AccessFingerprintError);
    try {
      make({ id: 'k', secret: USER_KEY_MARKER })();
    } catch (error) {
      expect(String(error)).not.toContain(USER_KEY_MARKER);
    }
  });

  it('fixed refusal codes per verdict', () => {
    expect(accessRefusal('X', 'match')).toBeNull();
    expect(['mismatch', 'missing', 'unknown_key', 'not_configured'].map((v) => accessRefusal('X', v as never))).toEqual(['X_ACCESS_MISMATCH', 'X_ACCESS_NOT_SHOWN', 'X_ACCESS_KEY_UNKNOWN', 'X_ACCESS_NOT_CONFIGURED']);
  });
});

describe('R3: the configuration of the key (separately managed, rotation, never printed)', () => {
  const BASE = { DATABASE_URL: 'postgres://nexus:pw-r3-hidden@127.0.0.1:5432/nexus', PORT: '3000', ETORO_ENABLED: '1', ETORO_API_KEY: 'ETORO-KEY-R3-0001', ETORO_USER_KEY: 'ETORO-USER-R3-0002' };
  const KEY = 'R3-ACCESS-KEY-0123456789abcdef0123456789abcdef';
  const OLD = 'R3-ACCESS-KEY-OLD-fedcba9876543210fedcba9876543210';
  const err = (env: Record<string, string>): string | null => {
    try {
      loadRuntimeConfig({ ...BASE, ...env });
      return null;
    } catch (error) {
      if (error instanceof RuntimeConfigError) return error.message;
      throw error;
    }
  };

  it('no key by default: not configured', () => {
    const config = loadRuntimeConfig(BASE);
    expect(config.brokerAccess).toEqual({ current: null, previous: null });
    expect(summarizeRuntimeConfig(config)).toMatchObject({ brokerAccess: 'not_configured', brokerAccessKeyIds: { current: null, previous: null } });
  });

  it('current and previous key: the summary names the key ids only', () => {
    const config = loadRuntimeConfig({ ...BASE, NEXUS_BROKER_ACCESS_KEY_ID: 'k2', NEXUS_BROKER_ACCESS_KEY: KEY, NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_PREVIOUS_KEY: OLD });
    expect(config.brokerAccess).toEqual({ current: { id: 'k2', secret: KEY }, previous: { id: 'k1', secret: OLD } });
    const summary = JSON.stringify(summarizeRuntimeConfig(config));
    expect(summary).toContain('"brokerAccess":"configured"');
    expect(summary).not.toContain(KEY);
    expect(summary).not.toContain(OLD);
  });

  it('refusals name the variable, never the value', () => {
    const cases: [Record<string, string>, string][] = [
      [{ NEXUS_BROKER_ACCESS_KEY: KEY }, 'must be set together'],
      [{ NEXUS_BROKER_ACCESS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_KEY: 'too-short' }, '32 to 512'],
      [{ NEXUS_BROKER_ACCESS_KEY_ID: 'K 1', NEXUS_BROKER_ACCESS_KEY: KEY }, 'NEXUS_BROKER_ACCESS_KEY_ID'],
      [{ NEXUS_BROKER_ACCESS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_KEY: 'ETORO-USER-R3-0002-padding-to-32-chars-xx', ETORO_USER_KEY: 'ETORO-USER-R3-0002-padding-to-32-chars-xx' }, 'must not be a broker key'],
      [{ NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_PREVIOUS_KEY: OLD }, 'needs a current'],
      [{ NEXUS_BROKER_ACCESS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_KEY: KEY, NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_PREVIOUS_KEY: OLD }, 'must differ'],
      [{ NEXUS_BROKER_ACCESS_KEY_ID: 'k2', NEXUS_BROKER_ACCESS_KEY: KEY, NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID: 'k1', NEXUS_BROKER_ACCESS_PREVIOUS_KEY: KEY }, 'must differ'],
    ];
    for (const [env, text] of cases) {
      const message = err(env);
      expect(message, JSON.stringify(Object.keys(env))).toContain(text);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(OLD);
    }
  });
});

describe('R3: opens, closes and attestations are bound to the configured access', () => {
  it('every successful sync and every started write attempt is stamped; no key appears in any record', async () => {
    const p = await closureProcess();
    const { open } = await filledThenClosedByHand(p);
    const syncs = p.syncs.all().map((r) => r.payload).filter((s) => s.outcome === 'success');
    expect(syncs.length).toBeGreaterThan(0);
    for (const s of syncs) expect(s.outcome === 'success' && s.access).toEqual(TEST_ACCESS.stamp());
    const started = p.f.attempts.all().map((r) => r.payload).filter((a) => a.phase === 'started');
    expect(started.map((a) => [a.intentId === open, a.access])).toEqual([[true, TEST_ACCESS.stamp()]]);
    const everything = JSON.stringify([p.syncs.all(), p.f.attempts.all(), p.f.intents.all(), p.f.confirmations.all()]);
    for (const secret of [API_KEY_MARKER, USER_KEY_MARKER, TEST_ACCESS_KEY.secret]) expect(everything).not.toContain(secret);
  });

  it('account switch: a newer snapshot read with other credentials refuses every open, the close and the attestation', async () => {
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ etoroStores });
    const { open } = await filledThenClosedByHand(p);
    // Another process, configured with other eToro credentials, reads the portfolio (it is empty there: another account).
    const switched = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker, access: testAccess({ userKey: OTHER_USER_KEY }), seed: false });
    switched.f.clock.now = new Date(p.f.clock.now.getTime() + 10_000);
    const foreign = await switched.sync('without_position');
    p.f.advance(10_000);
    const next = await p.f.service.create({ ...openInput({ strategyRunId: 'run-r3-switch' }), createdAt: p.f.clock.now.toISOString(), expiresAt: new Date(p.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(next.gateReasons).toContain('BROKER_SNAPSHOT_ACCESS_MISMATCH');
    expect(await reasons(p.attest(open, foreign))).toContain('EVIDENCE_SNAPSHOT_ACCESS_MISMATCH');
    // The switched process itself cannot close NEXUS's position: the open was sent with other credentials.
    const close = await switched.f.service.create({ ...closeInput(open), createdAt: switched.f.clock.now.toISOString(), expiresAt: new Date(switched.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(close.gateReasons).toContain('CLOSE_TARGET_OPEN_ACCESS_MISMATCH');
  });

  it('a process without an access key refuses every open and close (fail closed), and cannot attest', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const bare = await closureProcess({ stores: p.f.stores, broker: p.f.broker, access: null });
    bare.f.clock.now = new Date(p.f.clock.now.getTime());
    const next = await bare.f.service.create({ ...openInput({ strategyRunId: 'run-r3-bare' }), createdAt: bare.f.clock.now.toISOString(), expiresAt: new Date(bare.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(next.gateReasons).toContain('BROKER_SNAPSHOT_ACCESS_NOT_CONFIGURED');
    expect(await reasons(bare.attest(open, closedSnapshot))).toEqual(expect.arrayContaining(['OPEN_ATTEMPT_ACCESS_NOT_CONFIGURED']));
  });

  it('snapshots without a stamp (as every O22 record) are never filled in: an open on them is refused', async () => {
    const etoroStores = inMemoryEtoroStores();
    // A process without a key stores an unstamped read, as the code before review R3 did.
    const legacy = await closureProcess({ etoroStores, access: null, seed: false });
    await legacy.sync('without_position');
    expect(legacy.syncs.all().map((r) => r.payload).every((s) => s.outcome !== 'success' || s.access === undefined)).toBe(true);
    // A process with the key does not treat it as its own read: refused, and the record stays as it is.
    const keyed = await closureProcess({ stores: legacy.f.stores, etoroStores, broker: legacy.f.broker, seed: false });
    const next = await keyed.f.service.create(openInput(), CREATOR);
    expect(next.gateReasons).toEqual(['BROKER_SNAPSHOT_ACCESS_NOT_SHOWN']);
    expect(keyed.syncs.all().map((r) => r.payload).every((s) => s.outcome !== 'success' || s.access === undefined)).toBe(true);
  });

  it('key rotation across a restart: with the previous key the old stamps still match; without it, fail closed', async () => {
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ etoroStores });
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    // Restart after rotating to k2, without keeping k1: no old stamp can be checked.
    const lost = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker, access: testAccess({ current: K2 }), seed: false });
    lost.f.clock.now = new Date(p.f.clock.now.getTime());
    expect(await reasons(lost.attest(open, closedSnapshot))).toEqual(['OPEN_ATTEMPT_ACCESS_KEY_UNKNOWN', 'CONTINUITY_SNAPSHOT_ACCESS_KEY_UNKNOWN', 'EVIDENCE_SNAPSHOT_ACCESS_KEY_UNKNOWN']);
    // Restart after rotating to k2 with k1 as the previous key: the k1 stamps are checked and match.
    const rotated = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker, access: testAccess({ current: K2, previous: TEST_ACCESS_KEY }), seed: false });
    rotated.f.clock.now = new Date(p.f.clock.now.getTime());
    const record = await rotated.attest(open, closedSnapshot);
    expect(record.access.openAttempt.keyId).toBe('test-k1');
    // New reads of the rotated process are stamped with k2.
    rotated.f.advance(1_000);
    await rotated.sync('without_position');
    expect(rotated.syncs.all().at(-1)!.payload).toMatchObject({ access: { keyId: 'test-k2' } });
    void POSITION;
  });

  it('the newest stored snapshot turns into one read with other credentials between the gate and the reservation: not sent', async () => {
    // The request id is taken after the gate and before the reservation: the stored snapshot changes exactly there.
    let armed = false;
    const holder: { f?: Fixture } = {};
    const f = await o21Fixture({ requestId: () => {
      if (armed) holder.f!.setSnapshot({ positions: [], access: testAccess({ userKey: OTHER_USER_KEY }).stamp() });
      return '00000000-0000-4000-8000-0000000000bb';
    } });
    holder.f = f;
    const created = await f.service.create(openInput(), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await f.service.approve(created.intentId, HUMAN);
    armed = true;
    expect(await reasons(f.service.execute(created.intentId, HUMAN))).toEqual(['BROKER_SNAPSHOT_ACCESS_MISMATCH']);
    expect(f.broker.requests).toHaveLength(0);
    expect(await f.service.cycleBudget()).toMatchObject({ openSubmissions: 0 });
  });

  it('a restart with other credentials (but the same key) refuses the close of the open sent before', async () => {
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ etoroStores });
    const open = await filledOpen(p.f, POSITION);
    const restarted = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker, access: testAccess({ userKey: OTHER_USER_KEY }), seed: false });
    restarted.f.clock.now = new Date(p.f.clock.now.getTime() + 10_000);
    await restarted.sync('with_position');
    const close = await restarted.f.service.create({ ...closeInput(open), createdAt: restarted.f.clock.now.toISOString(), expiresAt: new Date(restarted.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(close.gateReasons).toEqual(['CLOSE_TARGET_OPEN_ACCESS_MISMATCH']);
    void HUMAN;
  });
});
