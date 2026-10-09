// Corporate actions on open positions (corporate-action-engine:v2, policy corporate-action-policy:v2). See
// docs/BACKTEST_CORPORATE_ACTIONS_O2.md for the decisions behind every rule here.
//
// Economics use RAW bars and explicit transformations of the position and its attached levels. The economic transformation of an
// action takes effect at its effective instant (the regular session open of the ex-date). Its knowledge must therefore be proven at or
// before that instant: knowledge that arrives later cannot have been known when the state changed, and the engine fails closed rather
// than rewriting state at an earlier instant. The strategy sees a split-normalised history built only from split knowledge proven at its
// decision time. Nothing here repairs history.

import { isProvenKnowledge, splitAdjustBars } from '../market-data/corporate-actions.js';
import type { MarketBar, StoredCorporateAction } from '../market-data/market-data-types.js';
import type { TradingCalendar } from '../market-data/sessions.js';
import { localDateOf, parseUtc, toUtcIso } from '../market-data/time.js';
import { Decimal, type RoundingMode } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import type {
  AppliedCorporateAction,
  BacktestCorporateActionResult,
  BacktestPosition,
  CorporateActionInput,
  CorporateActionReasonCode,
  CorporateActionTransformation,
  DividendReceivable,
  ValueNeutralityCheck,
} from './backtest-types.js';

/** v2: the economic knowledge boundary is the effective instant; appliedAt is the effective instant; processedAt is the event. */
export const CORPORATE_ACTION_ENGINE_VERSION = 'corporate-action-engine:v2';
export const CORPORATE_ACTION_POLICY_VERSION = 'corporate-action-policy:v2';

/** Quantity precision of a split result. A fractional result is kept exactly to this scale; nothing is rounded to whole shares. */
const QUANTITY_SCALE = 12;
/** Extra decimal places kept on a transformed price (the same precision as splitAdjustBars). */
const PRICE_EXTRA_SCALE = 6;
const ROUNDING: RoundingMode = 'half_even';
/** Tolerated value difference per share of the post-split quantity: one unit of the price precision. */
const VALUE_TOLERANCE_PER_SHARE = Decimal.from('0.000001');

export class CorporateActionEngineError extends Error {
  override readonly name = 'CorporateActionEngineError';
  constructor(
    readonly code: CorporateActionReasonCode,
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

/** The text of each reason. Each code is reported on its own: materially different limitations are never merged. */
export const CORPORATE_ACTION_REASON_TEXT: Readonly<Record<CorporateActionReasonCode, string>> = Object.freeze({
  CORPORATE_ACTION_CALENDAR_UNPROVEN: 'the effective session is only assumed by the calendar, or is not a session (the exact effective instant is not proven)',
  CORPORATE_ACTION_TIMING_UNPROVEN: 'an economic transformation was not provably known at its effective instant, or its effective session has no bar',
  CORPORATE_ACTION_ORDER_AMBIGUOUS: 'a split and a cash dividend share an effective instant; their order, which defines the dividend per share, is not provable',
  CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK: 'action accounting needs raw bars, but split-adjusted bars were supplied',
  CORPORATE_ACTION_FX_NOT_MODELED: 'a dividend in a currency other than the portfolio currency needs a point-in-time FX engine, which is not supplied',
  CORPORATE_ACTION_REVISION_CONFLICT: 'more than one revision of one action was supplied; the replay-selected revision must be passed',
  CORPORATE_ACTION_SOURCE_CONFLICT: 'the actions come from more than one source; one backtest takes the records of one source only',
  CORPORATE_ACTION_PENDING_AT_END: 'an action is effective after the last bar, so the final position is not fully adjusted',
  CORPORATE_ACTION_CLAIM_NOT_PROVEN: 'the caller asserted corporate actions are modeled; the engine did not prove it',
  DIVIDEND_PAYMENT_DATE_UNKNOWN: 'the provider states no payment date; dividend receivables are never settled into cash',
  FRACTIONAL_CASH_IN_LIEU_NOT_MODELED: 'a split produced a fractional share count; no cash in lieu is modeled and no quantity was rounded',
  ACTION_BEFORE_SERIES: 'the action is effective before the first bar; no position could exist for it',
});

/** The attached price levels of the open position or of the pending entry order. */
export interface AttachedLevels {
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
}

export interface ResolvedCorporateAction {
  action: StoredCorporateAction;
  /** The regular session open of exDate (ms). This is the economic effective instant and the knowledge boundary. */
  effectiveAt: number;
  /** The calendar only assumes this session (coverage is not verified). */
  assumed: boolean;
}

/** Effective instant of an action: the regular session open of its ex-date in the instrument's calendar. Fails closed without a session. */
export function effectiveSessionOf(action: StoredCorporateAction, calendar: TradingCalendar): { effectiveAt: number; assumed: boolean } {
  const session = calendar.session(action.exDate, 'regular');
  if (!session) {
    throw new CorporateActionEngineError('CORPORATE_ACTION_CALENDAR_UNPROVEN', action.actionKey + ': ex-date ' + action.exDate + ' has no regular session in ' + calendar.calendarId);
  }
  return { effectiveAt: session.open, assumed: session.assumed };
}

const byEffectiveThenKey = (x: ResolvedCorporateAction, y: ResolvedCorporateAction): number =>
  x.effectiveAt - y.effectiveAt || (x.action.actionKey < y.action.actionKey ? -1 : x.action.actionKey > y.action.actionKey ? 1 : 0);

/**
 * The actions of one run. One backtest takes the records of one source only: the identity of an action is its actionKey, which is
 * stable per source. An exact duplicate (same revision, content and ingest sequence) is applied once. Two different revisions of one
 * action cannot both be applied: the caller passes the replay-selected revision.
 */
export function resolveCorporateActions(input: CorporateActionInput): ResolvedCorporateAction[] {
  const sources = [...new Set(input.actions.map((a) => a.source))];
  if (sources.length > 1) {
    throw new CorporateActionEngineError('CORPORATE_ACTION_SOURCE_CONFLICT', 'the actions come from ' + sources.join(', ') + '; supply the records of one source');
  }
  const byKey = new Map<string, StoredCorporateAction>();
  for (const a of input.actions) {
    const seen = byKey.get(a.actionKey);
    if (seen === undefined) {
      byKey.set(a.actionKey, a);
      continue;
    }
    if (seen.revision === a.revision && seen.contentHash === a.contentHash && seen.ingestSeq === a.ingestSeq) continue;
    throw new CorporateActionEngineError('CORPORATE_ACTION_REVISION_CONFLICT', a.actionKey + ': revisions ' + seen.revision + ' and ' + a.revision + ' are both supplied');
  }
  return [...byKey.values()].map((action) => ({ action, ...effectiveSessionOf(action, input.calendar) })).sort(byEffectiveThenKey);
}

/** Open instant of a bar: its start for intraday bars; for a daily bar the regular session open of its trading date. */
export function barOpenMs(bar: MarketBar, calendar: TradingCalendar): number {
  const start = parseUtc(bar.startTime);
  if (bar.interval !== '1d') return start;
  const session = calendar.session(calendar.dailyBarDate(start), 'regular');
  if (!session) {
    throw new CorporateActionEngineError('CORPORATE_ACTION_CALENDAR_UNPROVEN', 'daily bar ' + bar.startTime + ' has no regular session in ' + calendar.calendarId);
  }
  return session.open;
}

/** Quantity transformation of a split: quantity × ratioTo / ratioFrom. Exact up to QUANTITY_SCALE. */
export function transformQuantity(quantity: Decimal, ratioFrom: Decimal, ratioTo: Decimal): Decimal {
  return quantity.times(ratioTo).dividedBy(ratioFrom, QUANTITY_SCALE, ROUNDING);
}

/** Price transformation of a split: price × ratioFrom / ratioTo, at the precision of splitAdjustBars. */
export function transformPrice(price: Decimal, ratioFrom: Decimal, ratioTo: Decimal): Decimal {
  return price.times(ratioFrom).dividedBy(ratioTo, Math.max(price.scale, 2) + PRICE_EXTRA_SCALE, ROUNDING);
}

function absolute(d: Decimal): Decimal {
  return d.isNegative() ? Decimal.ZERO.minus(d) : d;
}

function isSplit(a: StoredCorporateAction): boolean {
  return a.type === 'split' || a.type === 'reverse_split';
}

function transformLevels(levels: AttachedLevels, from: Decimal, to: Decimal): AttachedLevels {
  return {
    stopLoss: levels.stopLoss === null ? null : transformPrice(levels.stopLoss, from, to),
    takeProfit: levels.takeProfit === null ? null : transformPrice(levels.takeProfit, from, to),
  };
}

function stateFingerprint(position: BacktestPosition | null, levels: AttachedLevels | null, receivables: Decimal): string {
  return hashOf({
    position:
      position === null
        ? null
        : { entryFillId: position.entryFillId, quantity: position.quantity, entryPrice: position.entryPrice, stopLoss: position.stopLoss, takeProfit: position.takeProfit },
    levels: levels === null ? null : { stopLoss: levels.stopLoss, takeProfit: levels.takeProfit },
    receivables,
  });
}

/** Actions that take effect at the same instant form one group; the ambiguity rule is applied per group. */
function groupByEffectiveAt(due: readonly ResolvedCorporateAction[]): ResolvedCorporateAction[][] {
  const groups: ResolvedCorporateAction[][] = [];
  for (const r of due) {
    const last = groups.at(-1);
    if (last && last[0]!.effectiveAt === r.effectiveAt) last.push(r);
    else groups.push([r]);
  }
  return groups;
}

export interface CorporateActionStep {
  bar: MarketBar;
  /** The usable instant of the event that processes the action (ms). Recorded as processedAt; it does not gate economics. */
  eventMs: number;
  position: BacktestPosition | null;
  levels: AttachedLevels | null;
  /** The raw close of the previous event: the reference price of a split's value-neutrality check. */
  lastRawClose: Decimal | null;
}

/** Versions that enter the fingerprint. The defaults are the production constants; a test may inject another value. */
export interface CorporateActionVersions {
  engineVersion: string;
  policyVersion: string;
}

/**
 * Accounting state of one run. It applies every action exactly once, at its effective instant, and it refuses anything whose knowledge
 * was not proven by then. The knowledge boundary of the economics is the effective instant; the strategy's own information boundary is
 * its decision time, and it is kept separate in strategyView.
 */
export class CorporateActionLedger {
  private readonly calendar: TradingCalendar;
  private readonly resolved: ResolvedCorporateAction[];
  private remaining: ResolvedCorporateAction[];
  private readonly applied: AppliedCorporateAction[] = [];
  private readonly rejected: BacktestCorporateActionResult['rejected'] = [];
  private readonly receivables: DividendReceivable[] = [];
  private readonly checks: ValueNeutralityCheck[] = [];
  private readonly fractionalKeys: string[] = [];
  private readonly assumedKeys = new Set<string>();
  private readonly actions: StoredCorporateAction[];
  private readonly versions: CorporateActionVersions;

  constructor(
    input: CorporateActionInput,
    private readonly portfolioCurrency: string,
    firstBar: MarketBar,
    versions?: Partial<CorporateActionVersions>,
  ) {
    this.calendar = input.calendar;
    this.versions = { engineVersion: versions?.engineVersion ?? CORPORATE_ACTION_ENGINE_VERSION, policyVersion: versions?.policyVersion ?? CORPORATE_ACTION_POLICY_VERSION };
    this.resolved = resolveCorporateActions(input);
    this.actions = this.resolved.map((r) => r.action);
    const firstOpen = barOpenMs(firstBar, this.calendar);
    this.remaining = [];
    for (const r of this.resolved) {
      if (r.effectiveAt < firstOpen) {
        this.rejected.push({ actionKey: r.action.actionKey, revision: r.action.revision, source: r.action.source, code: 'ACTION_BEFORE_SERIES', reason: CORPORATE_ACTION_REASON_TEXT.ACTION_BEFORE_SERIES });
      } else {
        this.remaining.push(r);
      }
    }
  }

  /**
   * Applies every action whose effective instant is at or before this bar's open. Order: effective instant; within one instant, the
   * ambiguity rule; then the splits of that instant as one exact composite, then the other actions.
   */
  applyDue(step: CorporateActionStep): { position: BacktestPosition | null; levels: AttachedLevels | null } {
    const openMs = barOpenMs(step.bar, this.calendar);
    const due = this.remaining.filter((r) => r.effectiveAt <= openMs);
    if (due.length === 0) return { position: step.position, levels: step.levels };
    this.remaining = this.remaining.filter((r) => r.effectiveAt > openMs);
    let position = step.position;
    let levels = step.levels;
    for (const group of groupByEffectiveAt(due)) {
      assertNoOrderAmbiguity(group);
      for (const r of group) {
        this.assertOnEffectiveSession(r, step.bar, openMs);
        this.assertKnownAtEffectiveInstant(r);
      }
      const splits = group.filter((r) => isSplit(r.action));
      if (splits.length > 0) {
        const next = this.applySplitGroup(splits, step, position, levels);
        position = next.position;
        levels = next.levels;
      }
      for (const r of group) {
        if (isSplit(r.action)) continue;
        const next = this.applyOther(r, step, position, levels);
        position = next.position;
        levels = next.levels;
      }
    }
    return { position, levels };
  }

  /**
   * The strategy's view: split-normalised history, using only split knowledge proven at the decision time asOf (the strategy's own
   * information boundary, in every replay mode). A split that is effective but not yet known is not in the view; applyDue refuses it
   * before any decision could use it. Without an effective known split the raw history is already the correct view.
   */
  strategyView(history: readonly MarketBar[], bar: MarketBar, asOfMs: number): { history: readonly MarketBar[]; currentBar: MarketBar } {
    const asOfDate = localDateOf(asOfMs, this.calendar.timezone);
    const relevant = this.resolved.some((r) => isSplit(r.action) && r.action.exDate <= asOfDate && isProvenKnowledge(r.action.knowledge) && parseUtc(r.action.knowledge.knowledgeAt!) <= asOfMs);
    if (!relevant) return { history, currentBar: bar };
    const view = splitAdjustBars(history, this.actions, { asOf: toUtcIso(asOfMs), calendar: this.calendar, purpose: 'information' });
    if (view.status !== 'ok') {
      throw new CorporateActionEngineError('CORPORATE_ACTION_TIMING_UNPROVEN', 'a split changes the strategy history at ' + toUtcIso(asOfMs) + ' but cannot be shown known: ' + view.unproven.map((u) => u.actionKey).join(', '));
    }
    const currentBar = view.bars.find((b) => b.startTime === bar.startTime);
    if (!currentBar) throw new Error('strategy view lost the current bar ' + bar.startTime);
    return { history: Object.freeze(view.bars), currentBar };
  }

  /** Sum of the unsettled receivables. Economic value, not cash; never used for sizing. */
  receivablesValue(): Decimal {
    return this.receivables.reduce((sum, r) => sum.plus(r.grossAmount), Decimal.ZERO);
  }

  /** Every limitation of this run, one code each. Empty only when the accounting is complete. */
  reasons(): CorporateActionReasonCode[] {
    const out: CorporateActionReasonCode[] = [];
    if (this.remaining.length > 0) out.push('CORPORATE_ACTION_PENDING_AT_END');
    if (this.assumedKeys.size > 0 || this.remaining.some((r) => r.assumed)) out.push('CORPORATE_ACTION_CALENDAR_UNPROVEN');
    if (this.receivables.length > 0) out.push('DIVIDEND_PAYMENT_DATE_UNKNOWN');
    if (this.fractionalKeys.length > 0) out.push('FRACTIONAL_CASH_IN_LIEU_NOT_MODELED');
    return out;
  }

  result(): BacktestCorporateActionResult {
    const reasons = this.reasons();
    return {
      engineVersion: this.versions.engineVersion,
      policyVersion: this.versions.policyVersion,
      calendar: { calendarId: this.calendar.calendarId, timezone: this.calendar.timezone, source: this.calendar.source },
      applied: this.applied,
      rejected: this.rejected,
      pending: this.remaining.map((r) => ({ actionKey: r.action.actionKey, revision: r.action.revision, source: r.action.source, type: r.action.type, exDate: r.action.exDate, effectiveAt: toUtcIso(r.effectiveAt) })),
      dividendReceivables: this.receivables,
      settledDividends: [],
      valueNeutralityChecks: this.checks,
      reasons,
      complete: reasons.length === 0,
    };
  }

  /** Everything that determines the economics of the run, for the input fingerprint (including the engine and policy versions). */
  fingerprintRows(): unknown {
    return {
      engineVersion: this.versions.engineVersion,
      policyVersion: this.versions.policyVersion,
      calendar: { calendarId: this.calendar.calendarId, timezone: this.calendar.timezone, source: this.calendar.source, kind: this.calendar.kind },
      portfolioCurrency: this.portfolioCurrency,
      actions: this.resolved.map((r) => ({
        source: r.action.source,
        actionKey: r.action.actionKey,
        revision: r.action.revision,
        ingestSeq: r.action.ingestSeq,
        contentHash: r.action.contentHash,
        type: r.action.type,
        exDate: r.action.exDate,
        effectiveAt: toUtcIso(r.effectiveAt),
        effectiveAssumed: r.assumed,
        ratioFrom: r.action.ratioFrom?.toString() ?? null,
        ratioTo: r.action.ratioTo?.toString() ?? null,
        cashAmount: r.action.cashAmount?.toString() ?? null,
        currency: r.action.currency ?? null,
        oldSymbol: r.action.oldSymbol ?? null,
        newSymbol: r.action.newSymbol ?? null,
        announcedAt: r.action.announcedAt ?? null,
        storedAvailableAt: r.action.storedAvailableAt,
        retrievedAt: r.action.retrievedAt,
        knowledge: { provenance: r.action.knowledge.provenance, knowledgeAt: r.action.knowledge.knowledgeAt },
      })),
    };
  }

  private assertOnEffectiveSession(r: ResolvedCorporateAction, bar: MarketBar, openMs: number): void {
    const onSession = bar.interval === '1d' ? this.calendar.dailyBarDate(parseUtc(bar.startTime)) === r.action.exDate : openMs === r.effectiveAt;
    if (!onSession) {
      throw new CorporateActionEngineError(
        'CORPORATE_ACTION_TIMING_UNPROVEN',
        r.action.actionKey + ': the effective session ' + r.action.exDate + ' has no bar at its open (the bar applying it starts at ' + bar.startTime + ')',
      );
    }
  }

  /**
   * The economic knowledge boundary: the transformation takes effect at the effective instant, so its knowledge must be proven at or
   * before that instant. Knowledge that arrives later (even before the bar that applies it closes) cannot have been known at the
   * transformation, and reconstructing the state would need hindsight. Fail closed.
   */
  private assertKnownAtEffectiveInstant(r: ResolvedCorporateAction): void {
    const k = r.action.knowledge;
    if (!isProvenKnowledge(k)) {
      throw new CorporateActionEngineError('CORPORATE_ACTION_TIMING_UNPROVEN', r.action.actionKey + ': knowledge is not proven (' + k.provenance + '); the action cannot be applied');
    }
    if (parseUtc(k.knowledgeAt!) > r.effectiveAt) {
      throw new CorporateActionEngineError(
        'CORPORATE_ACTION_TIMING_UNPROVEN',
        r.action.actionKey + ': known at ' + k.knowledgeAt + ', after its economic effective instant ' + toUtcIso(r.effectiveAt) + '; the state at that instant cannot be reconstructed without hindsight',
      );
    }
  }

  /** Splits of one instant as one exact composite: the composite ratio is formed before any rounding, so the order of inputs cannot matter. */
  private applySplitGroup(splits: readonly ResolvedCorporateAction[], step: CorporateActionStep, position: BacktestPosition | null, levels: AttachedLevels | null): { position: BacktestPosition | null; levels: AttachedLevels | null } {
    let from = Decimal.ONE;
    let to = Decimal.ONE;
    for (const r of splits) {
      from = from.times(r.action.ratioFrom!);
      to = to.times(r.action.ratioTo!);
    }
    const beforeFingerprint = stateFingerprint(position, levels, this.receivablesValue());
    let nextPosition = position;
    let nextLevels = levels;
    let quantityBefore: string | null = null;
    let quantityAfter: string | null = null;
    let fractional = false;
    const levelsAdjusted: string[] = [];
    if (position) {
      const reference = step.lastRawClose ?? step.bar.open;
      const valueBefore = position.quantity.times(reference);
      const quantityNext = transformQuantity(position.quantity, from, to);
      const valueAfter = quantityNext.times(transformPrice(reference, from, to));
      const difference = absolute(valueAfter.minus(valueBefore));
      if (!difference.lte(VALUE_TOLERANCE_PER_SHARE.times(quantityNext.plus(1)))) {
        throw new Error('split value-neutrality invariant violated at ' + toUtcIso(splits[0]!.effectiveAt) + ' (difference ' + difference.toString() + ')');
      }
      quantityBefore = position.quantity.toString();
      quantityAfter = quantityNext.toString();
      fractional = quantityNext.scale > 0;
      if (position.stopLoss !== null) levelsAdjusted.push('position.stopLoss');
      if (position.takeProfit !== null) levelsAdjusted.push('position.takeProfit');
      const adjusted = transformLevels({ stopLoss: position.stopLoss, takeProfit: position.takeProfit }, from, to);
      nextPosition = { ...position, quantity: quantityNext, entryPrice: transformPrice(position.entryPrice, from, to), stopLoss: adjusted.stopLoss, takeProfit: adjusted.takeProfit };
      for (const r of splits) {
        this.checks.push({ actionKey: r.action.actionKey, revision: r.action.revision, referencePrice: reference.toString(), valueBefore: valueBefore.toString(), valueAfter: valueAfter.toString(), difference: difference.toString(), neutral: true });
      }
    }
    if (levels) {
      nextLevels = transformLevels(levels, from, to);
      if (levels.stopLoss !== null) levelsAdjusted.push('pending.stopLoss');
      if (levels.takeProfit !== null) levelsAdjusted.push('pending.takeProfit');
    }
    if (fractional) this.fractionalKeys.push(...splits.map((r) => r.action.actionKey));
    const afterFingerprint = stateFingerprint(nextPosition, nextLevels, this.receivablesValue());
    for (const r of splits) {
      const a = r.action;
      const transformation: CorporateActionTransformation = {
        kind: 'split',
        quantityFactor: Decimal.from(a.ratioTo!).dividedBy(a.ratioFrom!, QUANTITY_SCALE, ROUNDING).toString(),
        priceFactor: Decimal.from(a.ratioFrom!).dividedBy(a.ratioTo!, QUANTITY_SCALE, ROUNDING).toString(),
        quantityBefore,
        quantityAfter,
        levelsAdjusted,
        fractional,
      };
      this.recordApplied(r, step, beforeFingerprint, afterFingerprint, transformation);
    }
    return { position: nextPosition, levels: nextLevels };
  }

  /** Dividends and symbol changes: one action at its effective instant. */
  private applyOther(r: ResolvedCorporateAction, step: CorporateActionStep, position: BacktestPosition | null, levels: AttachedLevels | null): { position: BacktestPosition | null; levels: AttachedLevels | null } {
    const a = r.action;
    if (r.assumed) this.assumedKeys.add(a.actionKey);
    const beforeFingerprint = stateFingerprint(position, levels, this.receivablesValue());
    let transformation: CorporateActionTransformation;
    if (a.type === 'cash_dividend') {
      // Entitlement is fixed immediately before the effective open: the state at this point is the state held before the open.
      const entitled = position ? position.quantity : Decimal.ZERO;
      const perShare = a.cashAmount!;
      let receivableId: string | null = null;
      if (entitled.isPositive()) {
        if (a.currency !== this.portfolioCurrency) {
          throw new CorporateActionEngineError('CORPORATE_ACTION_FX_NOT_MODELED', a.actionKey + ' is in ' + (a.currency ?? 'no currency') + ' but the portfolio is in ' + this.portfolioCurrency + '; no FX engine is supplied');
        }
        receivableId = 'rcv_' + a.source + '|' + a.actionKey + '@' + a.revision;
        this.receivables.push({
          receivableId,
          actionKey: a.actionKey,
          revision: a.revision,
          source: a.source,
          instrumentId: a.instrumentId,
          entitledQuantity: entitled,
          amountPerShare: perShare,
          currency: a.currency!,
          grossAmount: entitled.times(perShare),
          exDate: a.exDate,
          entitledAt: toUtcIso(r.effectiveAt),
          paymentDate: null,
          settlement: 'UNSETTLED',
          settledAt: null,
        });
      }
      transformation = { kind: 'dividend_entitlement', entitledQuantity: entitled.toString(), amountPerShare: perShare.toString(), currency: a.currency ?? null, receivableId };
    } else {
      transformation = { kind: 'symbol_change', oldSymbol: a.oldSymbol ?? null, newSymbol: a.newSymbol ?? null, economicEffect: 'none' };
    }
    const afterFingerprint = stateFingerprint(position, levels, this.receivablesValue());
    this.recordApplied(r, step, beforeFingerprint, afterFingerprint, transformation);
    return { position, levels };
  }

  private recordApplied(r: ResolvedCorporateAction, step: CorporateActionStep, beforeStateFingerprint: string, afterStateFingerprint: string, transformation: CorporateActionTransformation): void {
    const a = r.action;
    this.applied.push({
      actionKey: a.actionKey,
      revision: a.revision,
      source: a.source,
      type: a.type,
      exDate: a.exDate,
      effectiveAt: toUtcIso(r.effectiveAt),
      appliedAt: toUtcIso(r.effectiveAt),
      processedAt: toUtcIso(step.eventMs),
      provenance: a.knowledge.provenance,
      knowledgeAt: a.knowledge.knowledgeAt,
      retrievedAt: a.retrievedAt,
      contentHash: a.contentHash,
      ingestSeq: a.ingestSeq,
      beforeStateFingerprint,
      afterStateFingerprint,
      transformation,
    });
  }
}

/** A split and a cash dividend at the same instant: the dividend per share depends on the order, which the provider does not state. */
function assertNoOrderAmbiguity(group: readonly ResolvedCorporateAction[]): void {
  const hasDividend = group.some((r) => r.action.type === 'cash_dividend');
  const hasSplit = group.some((r) => isSplit(r.action));
  if (hasDividend && hasSplit) {
    throw new CorporateActionEngineError(
      'CORPORATE_ACTION_ORDER_AMBIGUOUS',
      'a split and a cash dividend share the effective instant ' + toUtcIso(group[0]!.effectiveAt) + '; the dividend per share before or after the split is not provable',
    );
  }
}
