import type { BarReplayMode, CorporateActionKnowledgeProvenance, CorporateActionType, MarketBar, StoredCorporateAction } from '../market-data/market-data-types.js';
import type { TradingCalendar } from '../market-data/sessions.js';
import type { Decimal } from '../money/decimal.js';
import type { CostModelConfig } from './cost-model.js';
import type { IntrabarFillPolicy } from './execution-model.js';

export type PositionSizing =
  | { type: 'fixed_cash'; amount: string }
  | { type: 'percent_equity'; basisPoints: number }
  | { type: 'risk_per_trade'; riskBasisPoints: number; maxCashBasisPoints: number };

export interface BacktestPosition {
  instrumentId: string;
  /** Stable identity of the buy fill this position originates from. A close resolves that fill by this id, never by quantity. */
  entryFillId: string;
  /** Quantity and per-share basis are economic values: a split changes them. The entry fill itself never changes. */
  quantity: Decimal;
  entryPrice: Decimal;
  entryTime: string;
  entryCommission: Decimal;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
}

export interface BacktestFill {
  fillId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  reason: 'market_entry' | 'strategy_exit' | 'stop' | 'take_profit';
  at: string;
  rawPrice: Decimal;
  executionPrice: Decimal;
  quantity: Decimal;
  commission: Decimal;
}

export interface BacktestTrade {
  tradeId: string;
  instrumentId: string;
  entry: BacktestFill;
  exit: BacktestFill;
  pnl: Decimal;
  returnPct: number;
}

export interface BacktestEquityPoint {
  at: string;
  cash: Decimal;
  marketValue: Decimal;
  /** Unsettled dividend entitlements. Economic value, never spendable cash, never used for sizing. Absent before backtest-engine:v5. */
  receivablesValue?: Decimal;
  /** cash + marketValue + receivablesValue. */
  equity: Decimal;
}

export interface BacktestMetrics {
  startingCapital: Decimal;
  endingEquity: Decimal;
  absoluteReturn: Decimal;
  returnPct: number;
  maxDrawdownPct: number;
  numberOfTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  averageWinner: Decimal | null;
  averageLoser: Decimal | null;
  profitFactor: number | null;
  expectancy: Decimal | null;
  totalFees: Decimal;
  exposurePct: number;
}

/** The revision knowledge of the bars a backtest used (see docs/MARKET_BAR_PROVENANCE.md). */
export type BacktestDataProvenance = 'STRICT_PIT_DATA' | 'HISTORICAL_RECONSTRUCTION' | 'LEGACY_UNPROVEN';

/** What the bars of a backtest were at their simulated use time (see quality.ts). Counts only; no probabilities. */
export interface BacktestBarKnowledge {
  total: number;
  /** Bars NEXUS held at the simulated time the engine used them. */
  knownBeforeUse: number;
  contemporaneousVintage: number;
  historicalVintage: number;
  legacy: number;
}

export interface BacktestQuality {
  grade: 'A' | 'B' | 'C' | 'INVALID';
  reasons: string[];
  insufficientSample: boolean;
  dataProvenance: BacktestDataProvenance;
  barKnowledge: BacktestBarKnowledge;
}

export interface BacktestRunResult {
  backtestRunId: string;
  engineVersion: string;
  instrumentId: string;
  strategyId: string;
  strategyVersion: string;
  strategyDefinition: Readonly<Record<string, unknown>>;
  strategyFingerprint: string;
  inputFingerprint: string;
  initialCapital: Decimal;
  costModel: Readonly<CostModelConfig>;
  sizing: PositionSizing;
  intrabarPolicy: IntrabarFillPolicy;
  barsProcessed: number;
  fills: BacktestFill[];
  trades: BacktestTrade[];
  equityCurve: BacktestEquityPoint[];
  openPosition: BacktestPosition | null;
  metrics: BacktestMetrics;
  quality: BacktestQuality;
  ambiguousBars: number;
  /**
   * Warm-up semantics of this run, fully reconstructible (see docs/BACKTEST_WARMUP_ENFORCEMENT.md).
   * Absent only in backtest-engine:v1 runs, which had no warm-up gate and therefore cannot prove one.
   */
  warmup?: BacktestWarmupResult;
  /** Portfolio currency the cash and any receivable are denominated in. Required from backtest-engine:v5. */
  portfolioCurrency?: string;
  /** Corporate-action accounting of this run. Present when the run was given corporate-action input (backtest-engine:v5). */
  corporateActions?: BacktestCorporateActionResult;
}

/** Every reason a corporate-action limitation or refusal is reported under. Distinct codes are never merged into one warning. */
export type CorporateActionReasonCode =
  | 'CORPORATE_ACTION_CALENDAR_UNPROVEN'
  | 'CORPORATE_ACTION_TIMING_UNPROVEN'
  | 'CORPORATE_ACTION_ORDER_AMBIGUOUS'
  | 'CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK'
  | 'CORPORATE_ACTION_FX_NOT_MODELED'
  | 'CORPORATE_ACTION_REVISION_CONFLICT'
  | 'CORPORATE_ACTION_SOURCE_CONFLICT'
  | 'CORPORATE_ACTION_PENDING_AT_END'
  | 'CORPORATE_ACTION_CLAIM_NOT_PROVEN'
  | 'DIVIDEND_PAYMENT_DATE_UNKNOWN'
  | 'FRACTIONAL_CASH_IN_LIEU_NOT_MODELED'
  /** Not a limitation: the action lies before the first bar, so no position could have existed for it. Recorded in rejected, never in reasons. */
  | 'ACTION_BEFORE_SERIES';

/** Corporate-action input of a backtest: the replay-selected records and the calendar that gives their effective instants. */
export interface CorporateActionInput {
  /** One revision per actionKey; an exact duplicate (same revision and content) is applied once. */
  actions: readonly StoredCorporateAction[];
  /** The instrument's calendar. The effective instant of an ex-date is its regular session open. */
  calendar: TradingCalendar;
}

/** A dividend entitlement. An economic asset that is not spendable cash until it is settled (V1: never, see DIVIDEND_PAYMENT_DATE_UNKNOWN). */
export interface DividendReceivable {
  receivableId: string;
  /** Identity of the source record: the source and the actionKey together (one backtest takes one source). */
  actionKey: string;
  revision: number;
  source: string;
  instrumentId: string;
  entitledQuantity: Decimal;
  amountPerShare: Decimal;
  currency: string;
  grossAmount: Decimal;
  exDate: string;
  entitledAt: string;
  /** The provider states no payment date. Never invented. */
  paymentDate: null;
  settlement: 'UNSETTLED';
  settledAt: null;
}

export type CorporateActionTransformation =
  | {
      kind: 'split';
      quantityFactor: string;
      priceFactor: string;
      quantityBefore: string | null;
      quantityAfter: string | null;
      /** Attached price levels that were transformed (pending order or open position). */
      levelsAdjusted: string[];
      /** The post-split quantity has a fractional part. No quantity was rounded. */
      fractional: boolean;
    }
  | { kind: 'dividend_entitlement'; entitledQuantity: string; amountPerShare: string; currency: string | null; receivableId: string | null }
  | { kind: 'symbol_change'; oldSymbol: string | null; newSymbol: string | null; economicEffect: 'none' };

export interface AppliedCorporateAction {
  /** Recovers the source record: source, actionKey, revision, ingestSeq and contentHash together identify it. */
  source: string;
  actionKey: string;
  revision: number;
  type: CorporateActionType;
  exDate: string;
  /** The economic effective instant: the regular session open of exDate (calendar). */
  effectiveAt: string;
  /** The simulated instant the accounting transformation takes effect. Always equal to effectiveAt. */
  appliedAt: string;
  /** The usable instant of the deterministic engine event that processed it. Normally a bar's completion, after appliedAt. */
  processedAt: string;
  provenance: CorporateActionKnowledgeProvenance;
  /** When NEXUS provably knew the record. Applied only if this was at or before effectiveAt (the economic knowledge boundary). */
  knowledgeAt: string | null;
  retrievedAt: string;
  contentHash: string;
  ingestSeq: number;
  beforeStateFingerprint: string;
  afterStateFingerprint: string;
  transformation: CorporateActionTransformation;
}

/** Split value neutrality: quantity × reference price before and after the split (see docs/BACKTEST_CORPORATE_ACTIONS_O2.md). */
export interface ValueNeutralityCheck {
  actionKey: string;
  revision: number;
  referencePrice: string;
  valueBefore: string;
  valueAfter: string;
  difference: string;
  neutral: boolean;
}

export interface BacktestCorporateActionResult {
  engineVersion: string;
  policyVersion: string;
  calendar: { calendarId: string; timezone: string; source: string };
  applied: AppliedCorporateAction[];
  /** Actions not applied, with the reason. Only ACTION_BEFORE_SERIES appears here: other refusals fail the run. */
  rejected: Array<{ actionKey: string; revision: number; source: string; code: CorporateActionReasonCode; reason: string }>;
  /** Effective after the last bar, so not applied. */
  pending: Array<{ actionKey: string; revision: number; source: string; type: CorporateActionType; exDate: string; effectiveAt: string }>;
  dividendReceivables: DividendReceivable[];
  /** Always empty in V1: settlement needs a provider payment date, which is not available. */
  settledDividends: DividendReceivable[];
  valueNeutralityChecks: ValueNeutralityCheck[];
  /** The limitations of this run, one code each. Empty only when the accounting is complete. */
  reasons: CorporateActionReasonCode[];
  /** True only when accounting ran and no limitation was recorded. The quality grade is derived from this. */
  complete: boolean;
}

export interface BacktestWarmupResult {
  algorithmVersion: string;
  requiredBars: number;
  preferredBars: number;
  /** The hard gate: at least requiredBars bars were available at some event. */
  requiredWarmupMet: boolean;
  /** Every strategy evaluation had at least preferredBars of history, and there was at least one evaluation. */
  preferredWarmupMet: boolean;
  /** availableAt of the first event the strategy was evaluated on; null if it never was. */
  firstStrategyEvaluationAt: string | null;
  /** availableAt of the first event whose history reached preferredBars; null if it never did. */
  preferredWarmupCompleteAt: string | null;
  /** Events below the hard gate. Visible in equityCurve, never evaluated. */
  warmupBars: number;
  /** Events at or after the hard gate. Exposure is measured over these. */
  tradableBars: number;
  /** evaluate() calls. Equals tradableBars by construction. */
  strategyEvaluations: number;
  /** Evaluations made with fewer than preferredBars of history. */
  evaluationsBelowPreferred: number;
}

export interface BacktestQualityContext {
  pointInTimeUniverse: boolean;
  dataComplete: boolean;
  corporateActions: 'modeled' | 'not_modeled';
  providerProduction: boolean;
  minimumTrades: number;
}

export interface BacktestInput {
  bars: readonly MarketBar[];
  initialCapital: Decimal;
  /** ISO 4217. Required, never defaulted: cash, dividends and the fingerprint depend on it. */
  portfolioCurrency: string;
  sizing: PositionSizing;
  costModel: CostModelConfig;
  intrabarPolicy?: IntrabarFillPolicy;
  /** The caller's request. The grade uses what the engine proves, so a `modeled` request can be refused (see quality). */
  quality: BacktestQualityContext;
  /** Corporate-action accounting. When given, the bars must be raw and the position is adjusted for each action. */
  corporateActions?: CorporateActionInput;
  /**
   * When a bar is used. historical_research (default): at its market gate. decision_time: at the instant NEXUS held it, so the engine
   * never acts before NEXUS had the bar. A legacy bar throws in decision_time mode.
   */
  replay?: BarReplayMode;
}
