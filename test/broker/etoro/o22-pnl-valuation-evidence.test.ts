// O22: the valuation evidence of the /demo/pnl observation report (gaps G1: unrealizedPnL.pnL is a finite number; G2:
// accountCurrencyId is 1). Valid, missing, malformed and null values; and the report carries no amount, PnL value, id or key.
// No network: bodies are REFERENCE_SCHEMA test data, NOT a live response.
import { describe, expect, it } from 'vitest';
import { CONFIRM_FLAG, runObservation } from '../../../src/broker/etoro/etoro-observe-cli.js';
import { observeDemoResponse, valuationEvidenceOf } from '../../../src/broker/etoro/etoro-observation.js';
import { FixtureEtoroTransport, KEY_MARKER, USER_MARKER, emptyDemoPortfolio } from './o20-fixture.js';
import { schemaPnl, schemaPnlPosition } from './o21a1-pnl-fixture.js';

const withPnl = (unrealizedPnL: unknown) => schemaPnlPosition({ unrealizedPnL });

describe('O22 valuation evidence: G1, unrealizedPnL.pnL', () => {
  it('a finite number is proved, with its sign only', () => {
    const e = valuationEvidenceOf(schemaPnl({ positions: [withPnl({ pnL: 12.5 }), withPnl({ pnL: -3 }), withPnl({ pnL: 0 })] }));
    expect(e.positions).toBe(3);
    expect(e.unrealizedPnlObject).toEqual({ object: 3, null: 0, missing: 0, other: 0 });
    expect(e.pnL).toEqual({ type: { number: 3, null: 0, missing: 0, other: 0 }, finite: 3, sign: { positive: 1, negative: 1, zero: 1, not_applicable: 0 } });
    expect(e.checks.allPositionPnlFiniteNumbers).toBe(true);
  });

  it('null, missing or a string is not proved', () => {
    const e = valuationEvidenceOf(schemaPnl({ positions: [withPnl({ pnL: null }), withPnl({ closeRate: 1 }), withPnl({ pnL: '100.25' }), withPnl({ pnL: 1 })] }));
    expect(e.pnL).toEqual({ type: { number: 1, null: 1, missing: 1, other: 1 }, finite: 1, sign: { positive: 1, negative: 0, zero: 0, not_applicable: 3 } });
    expect(e.checks.allPositionPnlFiniteNumbers).toBe(false);
  });

  it('an unrealizedPnL that is null, missing or not an object is not proved', () => {
    const missing = schemaPnlPosition();
    delete missing.unrealizedPnL;
    const e = valuationEvidenceOf(schemaPnl({ positions: [withPnl(null), missing, withPnl([1]), withPnl({ pnL: 1 })] }));
    expect(e.unrealizedPnlObject).toEqual({ object: 1, null: 1, missing: 1, other: 1 });
    expect(e.checks.allPositionPnlFiniteNumbers).toBe(false);
  });

  it('an overflowing JSON literal parses to Infinity: a number, but not finite, so not proved', () => {
    const body = JSON.parse(JSON.stringify(schemaPnl({ positions: [withPnl({ pnL: 1 })] })).replace('"pnL":1', '"pnL":1e999')) as unknown;
    const e = valuationEvidenceOf(body);
    expect(e.pnL).toEqual({ type: { number: 1, null: 0, missing: 0, other: 0 }, finite: 0, sign: { positive: 0, negative: 0, zero: 0, not_applicable: 1 } });
    expect(e.checks.allPositionPnlFiniteNumbers).toBe(false);
  });

  it('no position: nothing to prove (null), never true', () => {
    expect(valuationEvidenceOf(schemaPnl()).checks.allPositionPnlFiniteNumbers).toBeNull();
    expect(valuationEvidenceOf({}).checks).toEqual({ allPositionPnlFiniteNumbers: null, accountCurrencyIsUsd: false });
  });
});

describe('O22 valuation evidence: G2, accountCurrencyId', () => {
  it('1 is proved as USD, and reported as the code', () => {
    expect(valuationEvidenceOf(schemaPnl({ accountCurrencyId: 1 })).accountCurrencyId).toEqual({ present: true, kind: 'integer', code: 1 });
    expect(valuationEvidenceOf(schemaPnl({ accountCurrencyId: 1 })).checks.accountCurrencyIsUsd).toBe(true);
  });

  const cases: Array<[string, unknown, { present: boolean; kind: string; code: number | null }]> = [
    ['missing', undefined, { present: false, kind: 'missing', code: null }],
    ['null', null, { present: true, kind: 'null', code: null }],
    ['another code', 2, { present: true, kind: 'integer', code: 2 }],
    ['a string', '1', { present: true, kind: 'string_numeric', code: null }],
    ['negative', -1, { present: true, kind: 'integer', code: null }],
    ['not an integer', 1.5, { present: true, kind: 'non_integer_number', code: null }],
  ];
  for (const [label, value, expected] of cases) {
    it(label + ' is not proved as USD', () => {
      const e = valuationEvidenceOf(schemaPnl({ accountCurrencyId: value }));
      expect(e.accountCurrencyId).toEqual(expected);
      expect(e.checks.accountCurrencyIsUsd).toBe(false);
    });
  }
});

describe('O22 valuation evidence in the report', () => {
  const SENSITIVE = { credit: 98765.4321, pnl: 1234.5678, positionId: 2150896073, cid: 7765437, orderId: 12402059 };
  const body = schemaPnl({ credit: SENSITIVE.credit, positions: [schemaPnlPosition({ unrealizedPnL: { pnL: SENSITIVE.pnl, closeRate: 2400.5, timestamp: '2026-10-18T20:00:00Z' } })] });

  it('the pnl report carries it; the portfolio report does not', () => {
    const report = observeDemoResponse('pnl', body, { pseudonymizeIds: true, showInstrumentIds: true });
    expect(report.valuationEvidence).toEqual(valuationEvidenceOf(body));
    expect(report.valuationEvidence?.checks).toEqual({ allPositionPnlFiniteNumbers: true, accountCurrencyIsUsd: true });
    expect(observeDemoResponse('portfolio', emptyDemoPortfolio()).valuationEvidence).toBeUndefined();
  });

  it('no amount, PnL value, position id, account id, order id or rate appears in the report', () => {
    const text = JSON.stringify(observeDemoResponse('pnl', body, { pseudonymizeIds: true, showInstrumentIds: true }));
    // Whole numbers only: the instrument id 1002 is reported in clear on purpose (--show-instrument-ids) and contains "100".
    for (const value of [...Object.values(SENSITIVE), 2400.5, 100, 0.049485]) {
      expect(text, String(value)).not.toMatch(new RegExp('(?<![\\d.])' + String(value).replace('.', '\\.') + '(?![\\d.])'));
    }
    expect(text).not.toContain('2026-10-18T20:00:00Z');
    const evidence = JSON.stringify(valuationEvidenceOf(body));
    expect(evidence).not.toMatch(/98765|1234\.5678|2150896073|7765437/);
  });

  it('through the observation tool: one GET of pnl.demo, and the report carries the evidence', async () => {
    const t = new FixtureEtoroTransport();
    t.response = { status: 200, body };
    const outcome = await runObservation({ env: { ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: KEY_MARKER, ETORO_USER_KEY: USER_MARKER }, argv: ['--source=pnl', CONFIRM_FLAG, '--pseudonymize-ids', '--show-instrument-ids'], transport: () => t });
    expect(t.calls).toEqual(['pnl.demo']);
    expect(outcome.exitCode).toBe(0);
    if (outcome.exitCode !== 0 || !('valuationEvidence' in outcome.report)) throw new Error('expected a pnl report');
    expect(outcome.report.valuationEvidence?.checks).toEqual({ allPositionPnlFiniteNumbers: true, accountCurrencyIsUsd: true });
    expect(JSON.stringify(outcome)).not.toContain(KEY_MARKER);
  });
});
