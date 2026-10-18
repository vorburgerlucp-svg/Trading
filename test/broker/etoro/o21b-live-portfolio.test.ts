// O21B: the unchanged O21A parser against the repository copy of the first LIVE_OBSERVED non-empty /demo/portfolio response
// (2026-10-18), offline.
//
// The JSON file next to this test comes from the operator's export of one direct GET outside NEXUS ($global:demoCheck in Windows
// PowerShell 5.1). It is not a reconstructed example. Kept fields carry the values as PowerShell parsed them. Fields the parser does
// not read are dropped and listed by name and JSON kind only. positionID / orderID are replaced by sequential pseudonyms (0 kept).
// For the repository copy only, clientPortfolio.credit is additionally set to null (privacy). The file is therefore not
// byte-identical with the export, and the full portfolio parser refuses it; that refusal is pinned here. The single position is
// checked separately with the existing parsePosition. No production rule is changed, and nothing is added to the body.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { parseDemoPortfolio, parsePosition } from '../../../src/broker/etoro/etoro-validation.js';

const file = JSON.parse(readFileSync(new URL('./o21b-live-demo-portfolio-2026-10-18.pseudonymized.json', import.meta.url), 'utf8')) as {
  provenance: Record<string, string>;
  droppedFields: Record<string, string[]>;
  body: { clientPortfolio: Record<string, unknown> & { positions: Record<string, unknown>[] } };
};

/** TradingDemoApi_Position as listed in docs/O21A (section 2): the 35 documented fields. */
const DOCUMENTED_POSITION_FIELDS = [
  'positionID', 'CID', 'openDateTime', 'openRate', 'instrumentID', 'mirrorID', 'parentPositionID', 'isBuy', 'leverage', 'takeProfitRate',
  'stopLossRate', 'amount', 'orderID', 'orderType', 'units', 'totalFees', 'initialAmountInDollars', 'isTslEnabled', 'stopLossVersion',
  'isSettled', 'redeemStatusID', 'initialUnits', 'isPartiallyAltered', 'unitsBaseValueDollars', 'isDiscounted', 'openPositionActionType',
  'settlementTypeID', 'isDetached', 'openConversionRate', 'pnlVersion', 'totalExternalFees', 'totalExternalTaxes', 'isNoTakeProfit',
  'isNoStopLoss', 'lotCount',
];

const EMPTY_CONTAINERS = ['mirrors', 'orders', 'stockOrders', 'entryOrders', 'exitOrders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple'];

describe('O21B live-observed non-empty demo portfolio (pseudonymized, credit-redacted repository copy, offline)', () => {
  it('is the live export with the credit redaction recorded, not a documented or reconstructed fixture', () => {
    expect(file.provenance.kind).toBe('live_observed_pseudonymized');
    expect(file.provenance.endpoint).toBe('GET /api/v1/trading/info/demo/portfolio');
    expect(file.provenance.observedOn).toBe('2026-10-18');
    expect(file.provenance.repositoryRedaction).toContain('clientPortfolio.credit');
    expect(file.body.clientPortfolio.credit).toBeNull();
  });

  it('the full portfolio parser refuses the redacted copy because credit is null (expected; the rule is unchanged)', () => {
    let refusal: unknown;
    try {
      parseDemoPortfolio(file.body);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BrokerError);
    expect((refusal as BrokerError).code).toBe('BROKER_RESPONSE_INVALID');
    expect((refusal as BrokerError).message).toContain('clientPortfolio.credit is missing');
  });

  it('has exactly one position and every other container empty', () => {
    expect(file.body.clientPortfolio.positions).toHaveLength(1);
    for (const key of EMPTY_CONTAINERS) expect(file.body.clientPortfolio[key]).toEqual([]);
  });

  it('parsePosition reads the position as observed in the eToro UI, with pseudonymized ids', () => {
    const position = parsePosition(file.body.clientPortfolio.positions[0], 'clientPortfolio.positions[0]');
    expect(position).toEqual({
      positionId: 9100000001,
      etoroInstrumentId: 100001,
      direction: 'buy',
      units: '0.04229',
      openRate: '2364.57',
      leverage: '1',
      amountUsd: '100',
      openedAt: '2026-10-18T16:38:25.877Z',
      stopLossRate: '0.0001',
      takeProfitRate: '238821.57',
      stopLossDisabled: true,
      takeProfitDisabled: false,
      trailingStopLoss: false,
      openOrder: { orderId: 9100000002, orderType: 17 },
    });
  });

  it('observed position keys are exactly the 35 documented TradingDemoApi_Position fields', () => {
    const [raw] = file.body.clientPortfolio.positions;
    const observed = [...Object.keys(raw!), ...file.droppedFields.positions!.map((entry) => entry.split(':')[0]!)];
    expect([...observed].sort()).toEqual([...DOCUMENTED_POSITION_FIELDS].sort());
    expect(file.droppedFields.root).toEqual([]);
    expect(file.droppedFields.clientPortfolio).toEqual(['bonusCredit:integer']);
  });
});
