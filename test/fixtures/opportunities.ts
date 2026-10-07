// The comparison table from the specification as test fixtures (estimates are illustrative test inputs).

import { chf } from '../../src/money/money.js';
import type { OpportunityInput } from '../../src/opportunities/opportunity-types.js';
import { T0 } from '../helpers.js';

const base = {
  regulatoryRiskScore: 0.05,
  effortScore: 0.1,
  risks: ['Prognose kann falsch sein'],
  exitPlan: 'Stop-Loss oder Ziel erreicht',
  estimates: { source: 'quant', dataStatus: 'connected', asOf: T0, calibrated: false },
} satisfies Partial<OpportunityInput>;

export const appleSwing: OpportunityInput = {
  ...base,
  id: 'apple-swing',
  type: 'stock',
  name: 'Apple Swing Trade',
  requiredCapitalChf: chf(100),
  sizing: { kind: 'scalable', minTicketChf: chf(10), maxCapitalChf: chf(1000), lotSizeChf: chf('0.01') },
  expectedNetProfitChf: chf(8),
  downsideChf: chf(5),
  expectedHoldingDays: 14,
  liquidityScore: 0.95,
  confidenceScore: 0.6,
  riskScore: 0.35,
  thesis: ['Pullback an Unterstützung, Trend intakt'],
};

export const btcTrade: OpportunityInput = {
  ...base,
  id: 'btc-trade',
  type: 'crypto',
  name: 'BTC Trade',
  requiredCapitalChf: chf(100),
  sizing: { kind: 'scalable', minTicketChf: chf(10), maxCapitalChf: chf(1000), lotSizeChf: chf('0.01') },
  expectedNetProfitChf: chf(15),
  downsideChf: chf(30),
  expectedHoldingDays: 7,
  liquidityScore: 0.9,
  confidenceScore: 0.5,
  riskScore: 0.8,
  thesis: ['Breakout-Versuch'],
};

export const chewingGumResale: OpportunityInput = {
  ...base,
  id: 'kaugummi-resale',
  type: 'reselling',
  name: 'Kaugummi Reselling',
  requiredCapitalChf: chf(20),
  sizing: { kind: 'scalable', minTicketChf: chf(20), maxCapitalChf: chf(20), lotSizeChf: chf(20) },
  expectedNetProfitChf: chf(10),
  downsideChf: chf(10),
  expectedHoldingDays: 7,
  liquidityScore: 0.4,
  confidenceScore: 0.8,
  riskScore: 0.3,
  effortScore: 0.4,
  thesis: ['Einkauf 20, Verkauf 35, Kosten 5'],
  estimates: { ...base.estimates, source: 'manual' },
};

export const batteryTrade: OpportunityInput = {
  ...base,
  id: 'batterie-handel',
  type: 'wholesale',
  name: 'Batteriehandel',
  requiredCapitalChf: chf(200),
  sizing: { kind: 'fixed' },
  expectedNetProfitChf: chf(60),
  downsideChf: chf(80),
  expectedHoldingDays: 21,
  liquidityScore: 0.3,
  confidenceScore: 0.7,
  riskScore: 0.5,
  effortScore: 0.6,
  regulatoryRiskScore: 0.2,
  thesis: ['Grosshandelslos unter Marktpreis'],
  estimates: { ...base.estimates, source: 'manual' },
};
