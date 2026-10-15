// IBKR read-only sync adapter. It implements BrokerSyncAdapter only. Per sync it reads the outer session (tickle) and then the
// brokerage status, which is the only source of brokerage readiness. A brokerage that is not ready is started only when this
// process allows it (allowBrokerageInit): then exactly one initialization is sent, the status is read again after the settle
// time, and the accounts must answer. Otherwise the sync stops with BROKER_BROKERAGE_INIT_REQUIRED and nothing is started.
// It has no order method, cannot call anything outside IBKR_ALLOWED_OPERATIONS, and never writes to the ledger or to the
// instrument registry.

import type { AdapterConnection } from '../../ai/model-adapter.js';
import { currency as toCurrency, money, type CurrencyCode, type Money } from '../../money/currency.js';
import type { Decimal } from '../../money/decimal.js';
import type { BrokerAmount, BrokerOpenOrder, BrokerPositionSnapshot, BrokerSnapshot, BrokerSyncAdapter } from '../broker-sync.js';
import { IbkrError } from './ibkr-errors.js';
import { IBKR_MAX_POSITION_PAGES, IBKR_PORTFOLIO_PAGE_SIZE, IBKR_ALLOWED_OPERATIONS, type IbkrOperation, type IbkrOperationParams } from './ibkr-readonly.js';
import type { IbkrTransport } from './ibkr-transport.js';
import { isBrokerageReady, parseAccounts, parseBrokerageAccounts, parseBrokerageStatus, parseLedger, parseMeta, parseOrders, parsePositions, parseTickle, type OrderRecord, type PositionRecord } from './ibkr-validation.js';

/** Official guidance: at least two seconds between the brokerage initialization and the status check. */
export const IBKR_BROKERAGE_SETTLE_MS = 2_000;

export interface IbkrSyncAdapterOptions {
  transport: IbkrTransport;
  /** IBKR_ACCOUNT_ID, or null. With null, exactly one readable account is required; several are refused (fail closed). */
  accountId: string | null;
  clock: () => Date;
  /** Maps an IBKR conid to a NEXUS instrument through the instrument registry. Null when unmapped. Never invented. */
  resolveInstrument: (brokerInstrumentId: string, at: string) => string | null;
  /**
   * Whether this process may send the brokerage initialization (IBKR_ALLOW_BROKERAGE_INIT=1). Required, with no default: every
   * caller states it. False: a brokerage that is not ready stops the sync (BROKER_BROKERAGE_INIT_REQUIRED) and nothing is sent.
   */
  allowBrokerageInit: boolean;
  /** Waits between the brokerage initialization and its check. Tests replace it with a no-op. */
  delay?: (ms: number) => Promise<void>;
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The one account this session will read. Exact match against the configured id; otherwise exactly one account or a refusal. */
export function selectAccount(readable: readonly string[], configured: string | null): string {
  const unique = [...new Set(readable)];
  if (configured !== null) {
    if (!unique.includes(configured)) throw new IbkrError('BROKER_ACCOUNT_NOT_FOUND');
    return configured;
  }
  if (unique.length === 0) throw new IbkrError('BROKER_ACCOUNT_NOT_FOUND');
  if (unique.length > 1) throw new IbkrError('BROKER_ACCOUNT_AMBIGUOUS');
  return unique[0] as string;
}

function toCurrencyCode(code: string): CurrencyCode {
  try {
    return toCurrency(code);
  } catch {
    throw new IbkrError('BROKER_RESPONSE_INVALID', 'unsupported currency code');
  }
}

function amountOf(code: string, value: Decimal | null): BrokerAmount | null {
  return value === null ? null : { currency: toCurrencyCode(code), value };
}

/** Errors that already describe the cause. Anything else from the initialization is reported as an initialization failure. */
const CAUSE_PRESERVED_ON_INIT: ReadonlySet<string> = new Set(['BROKER_AUTH_REQUIRED', 'BROKER_RATE_LIMITED', 'BROKER_NOT_CONNECTED', 'BROKER_TIMEOUT']);

export class IbkrBrokerSyncAdapter implements BrokerSyncAdapter {
  readonly broker = 'ibkr';
  readonly access = 'read_only' as const;
  private connected = false;
  private readonly lastCalledAt = new Map<IbkrOperation, number>();
  private inFlight: Promise<BrokerSnapshot> | null = null;

  constructor(private readonly options: IbkrSyncAdapterOptions) {}

  connection(): AdapterConnection {
    return this.connected ? 'connected' : 'not_connected';
  }

  /** One sync at a time: a second call while one runs shares its result instead of sending more requests. */
  fetchSnapshot(): Promise<BrokerSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async call(operation: IbkrOperation, params?: IbkrOperationParams): Promise<unknown> {
    const nowMs = this.options.clock().getTime();
    const last = this.lastCalledAt.get(operation);
    // The window is consumed before the call, so a failure never leads to an immediate retry.
    if (last !== undefined && nowMs - last < IBKR_ALLOWED_OPERATIONS[operation].minIntervalMs) throw new IbkrError('BROKER_RATE_LIMITED');
    this.lastCalledAt.set(operation, nowMs);
    const response = await this.options.transport.call(operation, params);
    if (response.status === 401 || response.status === 403) throw new IbkrError('BROKER_AUTH_REQUIRED');
    if (response.status === 429) throw new IbkrError('BROKER_RATE_LIMITED');
    if (response.status >= 500) throw new IbkrError('BROKER_NOT_CONNECTED', 'gateway returned ' + response.status);
    if (response.status !== 200) throw new IbkrError('BROKER_RESPONSE_INVALID', 'unexpected status');
    return response.body;
  }

  /**
   * The one brokerage initialization of this sync. It is sent at most once and never repeated. Its answer is not authority: the
   * status is read again after the settle time, and only that status, plus a non-empty accounts answer, makes the session ready.
   * The body is fixed with compete=false, so a session that another client runs is reported (BROKER_SESSION_COMPETING), never taken over.
   */
  private async initializeBrokerage(): Promise<void> {
    try {
      await this.call('brokerage.init');
    } catch (error) {
      if (error instanceof IbkrError && CAUSE_PRESERVED_ON_INIT.has(error.code)) throw error;
      throw new IbkrError('BROKER_BROKERAGE_INIT_FAILED', 'initialization was refused');
    }
    await (this.options.delay ?? defaultDelay)(IBKR_BROKERAGE_SETTLE_MS);
    const status = parseBrokerageStatus(await this.call('brokerage.status'));
    if (status.competing) throw new IbkrError('BROKER_SESSION_COMPETING');
    if (!isBrokerageReady(status)) throw new IbkrError('BROKER_BROKERAGE_INIT_FAILED', 'not authenticated, connected and established after initialization');
    try {
      parseBrokerageAccounts(await this.call('brokerage.accounts'));
    } catch (error) {
      if (error instanceof IbkrError && CAUSE_PRESERVED_ON_INIT.has(error.code)) throw error;
      throw new IbkrError('BROKER_BROKERAGE_INIT_FAILED', 'no brokerage account after initialization');
    }
  }

  private async collect(): Promise<BrokerSnapshot> {
    try {
      const observedAt = this.options.clock().toISOString();
      // The keepalive proves the outer session. A missing or expired session stops here, before any brokerage call.
      parseTickle(await this.call('session.tickle'));
      const status = parseBrokerageStatus(await this.call('brokerage.status'));
      // A competing session is reported before anything else: this build never takes it over and never initializes beside it.
      if (status.competing) throw new IbkrError('BROKER_SESSION_COMPETING');
      if (!isBrokerageReady(status)) {
        if (!this.options.allowBrokerageInit) throw new IbkrError('BROKER_BROKERAGE_INIT_REQUIRED');
        await this.initializeBrokerage();
      }

      const accountId = selectAccount(parseAccounts(await this.call('accounts.list')), this.options.accountId);
      const meta = parseMeta(await this.call('account.meta', { accountId }), accountId);
      const ledger = parseLedger(await this.call('account.ledger', { accountId }));

      const positions: PositionRecord[] = [];
      for (let pageId = 0; ; pageId++) {
        if (pageId >= IBKR_MAX_POSITION_PAGES) throw new IbkrError('BROKER_RESPONSE_INVALID', 'too many position pages');
        const page = parsePositions(await this.call('positions.page', { accountId, pageId }), accountId);
        positions.push(...page);
        if (page.length < IBKR_PORTFOLIO_PAGE_SIZE) break;
      }

      const orders: OrderRecord[] = parseOrders(await this.call('orders.open', { accountId }), accountId);
      const retrievedAt = this.options.clock().toISOString();
      this.connected = true;

      return {
        broker: this.broker,
        accountId,
        access: 'read_only',
        observedAt,
        retrievedAt,
        accountStatus: meta.clearingStatus,
        cash: ledger.map((entry) => this.cashOf(entry.currency, entry.cashBalance)),
        positions: positions.map((p): BrokerPositionSnapshot => ({
          instrumentId: this.options.resolveInstrument(p.brokerInstrumentId, observedAt),
          brokerSymbol: p.brokerSymbol,
          brokerInstrumentId: p.brokerInstrumentId,
          listingExchange: p.listingExchange,
          quantity: p.quantity,
          currency: toCurrencyCode(p.currency),
          averageCost: amountOf(p.currency, p.averageCost),
          marketValue: amountOf(p.currency, p.marketValue),
          unrealizedPnl: amountOf(p.currency, p.unrealizedPnl),
          realizedPnl: amountOf(p.currency, p.realizedPnl),
        })),
        openOrders: orders.map((o): BrokerOpenOrder => ({
          externalOrderId: o.externalOrderId,
          instrumentId: this.options.resolveInstrument(o.brokerInstrumentId, observedAt),
          brokerInstrumentId: o.brokerInstrumentId,
          side: o.side,
          quantity: o.quantity,
          // The order payload carries no reliable currency for its price, so the price is not reported (null), not guessed.
          limitPrice: null,
          status: o.status,
        })),
      };
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  /** Cash must fit the currency's minor units. A value that does not is refused, never rounded. */
  private cashOf(code: string, value: Decimal): Money {
    try {
      return money(code, value.toString());
    } catch {
      throw new IbkrError('BROKER_RESPONSE_INVALID', 'cash amount does not fit the currency precision');
    }
  }
}
