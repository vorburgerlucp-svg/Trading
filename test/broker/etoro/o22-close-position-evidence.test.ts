// O22 D4 (audit of 23.10.2026): a close is never allowed on the NEXUS logs alone. It needs the broker's own evidence that its
// position is still open: the latest STORED read-only portfolio snapshot, fresh, complete, taken after NEXUS bound the position,
// showing the position exactly once with the intent's instrument and direction (and the open's order, when stated). Checked in
// the gate at creation and at execution, and again in the reservation step. Without it: refused, nothing sent, no budget spent.
// No network: scripted broker answers. PostgreSQL and parallel processes: o22-close-position-evidence.pg.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path, so it replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { DEMO_E2E_CYCLE_POLICY, closePositionRefusals, type ClosePositionEvidence, type EvidencePosition } from '../../../src/broker/etoro/execution/execution-gate.js';
import { parseExecutionIntent } from '../../../src/broker/etoro/execution/execution-intent.js';
import { CREATOR, DEFAULT_BROKER_POSITION, ETORO_AAPL_ID, HUMAN, closeInput, filledOpen, inMemoryStores, o21Fixture, type Fixture } from './o21-fixture.js';
import { InjectedCrash, withFaults } from './o22-fault-store.js';
import { refusal } from './o22-recovery-scenarios.js';

const POSITION = DEFAULT_BROKER_POSITION.positionId;
const NOW = '2026-10-16T14:00:00.000Z';
const closeSubmitted = { status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };

/** The O21 default policy (filledOpen() opens 500 USD); the evidence check uses the same sync age limit as the cycle policy. */
function cycle(options: Parameters<typeof o21Fixture>[0] = {}): Promise<Fixture> {
  return o21Fixture(options);
}

/** A close intent (as parsed) of the default position, for the pure check. */
function closeIntent(): ReturnType<typeof parseExecutionIntent> {
  const parsed = parseExecutionIntent(closeInput('eint_' + 'a'.repeat(40)), CREATOR);
  return { ...parsed, positionId: POSITION };
}

function evidence(overrides: Partial<NonNullable<ClosePositionEvidence['snapshot']>> = {}, rest: Partial<Omit<ClosePositionEvidence, 'snapshot'>> = {}): ClosePositionEvidence {
  return {
    snapshot: { observedAt: '2026-10-16T13:59:30.000Z', freshness: 'fresh', positionCount: 1, positions: [DEFAULT_BROKER_POSITION], ...overrides },
    boundAt: '2026-10-16T13:59:00.000Z',
    openOrderId: 13902598,
    ...rest,
  };
}

function budget(f: Fixture) {
  return f.service.cycleBudget();
}

describe('O22 D4: closePositionRefusals (pure)', () => {
  const intent = closeIntent();
  const p = (o: Partial<EvidencePosition>): EvidencePosition => ({ ...DEFAULT_BROKER_POSITION, ...o });
  const cases: [string, ClosePositionEvidence | null, string[]][] = [
    ['fresh, complete, after the binding, the position exactly once', evidence(), []],
    ['the open order matches when the broker states it', evidence({ positions: [p({ openOrderId: 13902598 })] }), []],
    ['no evidence', null, ['CLOSE_POSITION_EVIDENCE_MISSING']],
    ['no snapshot', evidence({}, {}) && { ...evidence(), snapshot: null }, ['CLOSE_POSITION_EVIDENCE_MISSING']],
    ['older than the sync limit', evidence({ observedAt: '2026-10-16T13:54:59.000Z' }, { boundAt: '2026-10-16T13:50:00.000Z' }), ['CLOSE_POSITION_EVIDENCE_STALE']],
    ['marked stale', evidence({ freshness: 'stale' }), ['CLOSE_POSITION_EVIDENCE_STALE']],
    ['in the future', evidence({ observedAt: '2026-10-16T14:00:01.000Z' }), ['CLOSE_POSITION_EVIDENCE_STALE']],
    ['taken before NEXUS bound the position', evidence({ observedAt: '2026-10-16T13:58:59.000Z' }), ['CLOSE_POSITION_EVIDENCE_PREDATES_BINDING']],
    ['no binding', evidence({}, { boundAt: null }), ['CLOSE_POSITION_EVIDENCE_PREDATES_BINDING']],
    ['incomplete (the broker stated more positions than listed)', evidence({ positionCount: 2 }), ['CLOSE_POSITION_EVIDENCE_INCOMPLETE']],
    ['the position is not in the snapshot (closed by hand)', evidence({ positionCount: 0, positions: [] }), ['CLOSE_POSITION_NOT_OPEN_AT_BROKER']],
    ['only another position id', evidence({ positions: [p({ positionId: POSITION + 1 })] }), ['CLOSE_POSITION_NOT_OPEN_AT_BROKER']],
    ['the position twice', evidence({ positionCount: 2, positions: [p({}), p({})] }), ['CLOSE_POSITION_AMBIGUOUS']],
    ['another instrument', evidence({ positions: [p({ etoroInstrumentId: 1002 })] }), ['CLOSE_POSITION_MISMATCH']],
    ['another direction', evidence({ positions: [p({ direction: 'sell' })] }), ['CLOSE_POSITION_MISMATCH']],
    ['another opening order', evidence({ positions: [p({ openOrderId: 999 })] }), ['CLOSE_POSITION_MISMATCH']],
    ['an opening order while NEXUS knows none', evidence({ positions: [p({ openOrderId: 13902598 })] }, { openOrderId: null }), ['CLOSE_POSITION_MISMATCH']],
  ];
  for (const [name, input, expected] of cases) {
    it(name + ' -> ' + (expected.join(',') || 'allowed'), () => {
      expect(closePositionRefusals(intent, input, NOW, DEMO_E2E_CYCLE_POLICY)).toEqual(expected);
    });
  }
  it('an open is never affected', () => {
    const open = { ...intent, action: 'open' as const, positionId: null };
    expect(closePositionRefusals(open, null, NOW, DEMO_E2E_CYCLE_POLICY)).toEqual([]);
  });
});

describe('O22 D4: a close is refused at creation without broker evidence (nothing sent, no budget)', () => {
  const cases: [string, (f: Fixture) => void, string][] = [
    ['the position was closed by hand: the snapshot no longer shows it', (f) => f.setSnapshot({ positions: [] }), 'CLOSE_POSITION_NOT_OPEN_AT_BROKER'],
    ['there is no snapshot', (f) => f.setSnapshot(null), 'CLOSE_POSITION_EVIDENCE_MISSING'],
    ['the snapshot is too old', (f) => f.setSnapshot({ observedAt: '2026-10-16T13:50:00.000Z', positions: [DEFAULT_BROKER_POSITION] }), 'CLOSE_POSITION_EVIDENCE_STALE'],
    ['the snapshot shows another position id', (f) => f.setSnapshot({ positions: [{ ...DEFAULT_BROKER_POSITION, positionId: POSITION + 5 }] }), 'CLOSE_POSITION_NOT_OPEN_AT_BROKER'],
    ['the snapshot shows the position twice', (f) => f.setSnapshot({ positions: [DEFAULT_BROKER_POSITION, DEFAULT_BROKER_POSITION] }), 'CLOSE_POSITION_AMBIGUOUS'],
  ];
  for (const [name, arrange, reason] of cases) {
    it(name + ': REJECTED with ' + reason, async () => {
      const f = await cycle();
      const open = await filledOpen(f, POSITION);
      arrange(f);
      const created = await f.service.create(closeInput(open), CREATOR);
      expect(created.state).toBe('REJECTED');
      expect(created.gateReasons).toContain(reason);
      expect(f.broker.writes).toHaveLength(1);
      expect(await budget(f)).toMatchObject({ openSubmissions: 1, closeSubmissions: 0 });
    });
  }
});

describe('O22 D4: checked again immediately before the write', () => {
  async function approvedClose(f: Fixture): Promise<string> {
    const open = await filledOpen(f, POSITION);
    const created = await f.service.create(closeInput(open), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await f.service.approve(created.intentId, HUMAN);
    return created.intentId;
  }

  it('closed by hand after the approval: execute is refused, the intent stays APPROVED, no write, no close budget', async () => {
    const f = await cycle();
    const close = await approvedClose(f);
    f.setSnapshot({ positions: [] });
    const e = await refusal(f.service.execute(close, HUMAN));
    expect(e.code).toBe('GATE_REFUSED');
    expect(e.reasons).toContain('CLOSE_POSITION_NOT_OPEN_AT_BROKER');
    expect((await f.service.get(close)).state).toBe('APPROVED');
    expect(f.broker.writes).toHaveLength(1);
    expect(await budget(f)).toMatchObject({ closeSubmissions: 0 });
  });

  it('the evidence turns stale between the gate and the reservation: refused in the reservation step, no budget', async () => {
    // The snapshot is just inside the limit at the gate; the clock moves on before the reservation (at the request id).
    let armed = false;
    const holder: { f?: Fixture } = {};
    const f = await cycle({ requestId: () => {
      if (armed) holder.f!.advance(2_000);
      return '00000000-0000-4000-8000-' + String(Date.now() % 1e12).padStart(12, '0');
    } });
    holder.f = f;
    const close = await approvedClose(f);
    // The snapshot is taken right after the binding; the clock then runs to 1 s before the limit.
    f.setSnapshot({ observedAt: f.clock.now.toISOString(), positions: [DEFAULT_BROKER_POSITION] });
    f.advance(DEMO_E2E_CYCLE_POLICY.maxBrokerSyncAgeMs - 1_000);
    armed = true;
    const e = await refusal(f.service.execute(close, HUMAN));
    expect(e).toEqual({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_EVIDENCE_STALE'] });
    expect((await f.service.get(close)).state).toBe('APPROVED');
    expect(f.broker.writes).toHaveLength(1);
    expect(await budget(f)).toMatchObject({ closeSubmissions: 0 });
  });

  it('with fresh evidence the close is sent exactly once', async () => {
    const f = await cycle();
    const close = await approvedClose(f);
    f.broker.next(closeSubmitted);
    expect((await f.service.execute(close, HUMAN)).state).toBe('SUBMITTED');
    expect(f.broker.writes.map((w) => w.method)).toEqual(['POST', 'POST']);
    expect(await budget(f)).toMatchObject({ closeSubmissions: 1 });
  });

  it('a crash before the SUBMITTING record commits: nothing sent, no budget; the restart checks the evidence again', async () => {
    const stores = inMemoryStores();
    const faults = withFaults(stores);
    const f = await cycle({ stores: faults.stores });
    const close = await approvedClose(f);
    faults.intents.crashAt((e) => e.state === 'SUBMITTING', 'before');
    await expect(f.service.execute(close, HUMAN)).rejects.toBeInstanceOf(InjectedCrash);
    expect(f.broker.writes).toHaveLength(1);
    const restarted = await cycle({ stores, sharedBroker: f.broker, brokerPositions: [] });
    expect(await restarted.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
    // After the restart the broker snapshot no longer shows the position: refused, still nothing sent.
    expect((await refusal(restarted.service.execute(close, HUMAN))).reasons).toContain('CLOSE_POSITION_NOT_OPEN_AT_BROKER');
    expect(f.broker.writes).toHaveLength(1);
  });
});
