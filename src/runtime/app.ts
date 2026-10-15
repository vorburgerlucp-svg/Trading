// HTTP surface of the NEXUS runtime (node:http, no framework). Read-only except the quant run, which writes an append-only
// quant run record. Routes are a fixed table: there is no route that resets, unlocks, arms, enables live trading or places an order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BAR_INTERVALS, type BarInterval } from '../market-data/market-data-types.js';
import { RuntimeApiError, errorBody, toRuntimeApiError } from './errors.js';

export const RUNTIME_API_VERSION = 'nexus-runtime-api:v1' as const;
export const MAX_BODY_BYTES = 16 * 1024;
const MAX_BARS_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export interface RuntimeHealth {
  status: 'ok' | 'degraded';
  database: 'connected' | 'unavailable';
  marketData: 'configured' | 'demo' | 'not_configured';
  providerHealth: 'closed' | 'open' | 'half_open' | 'not_configured';
  tradingMode: 'paper';
  liveTrading: 'locked';
  buildLocks: { liveTrading: true; brokerOrders: true; physicalPurchase: true };
  broker: {
    ibkr: {
      configured: boolean;
      connection: 'connected' | 'not_connected' | 'error';
      access: 'read_only';
    };
  };
  version: string;
}

/** An IBKR contract (conid) linked to an existing NEXUS instrument. The conid is the identity, never the ticker. */
export interface IbkrMappingBody {
  conid: string;
  instrumentId: string;
  validFrom: string;
}

export interface InstrumentSearchItem {
  instrumentId: string | null;
  provider: string;
  providerSymbol: string;
  name: string;
  assetClass: string;
  exchange: string | null;
  mic: string | null;
  currency: string | null;
  timezone: string | null;
}

export interface BarsRequest {
  instrumentId: string;
  interval: BarInterval;
  from: string;
  to: string;
}

export interface QuantRequest {
  instrumentId: string;
  interval: BarInterval;
  asOf: string;
}

export interface InstrumentRegisterRequest {
  providerSymbol: string;
  validFrom: string;
  mic?: string;
  exchange?: string;
}

/** What the routes need. Every implementation returns validated NEXUS data, never a raw provider response. */
export interface RuntimeServices {
  health(): Promise<RuntimeHealth>;
  searchInstruments(query: string): Promise<InstrumentSearchItem[]>;
  registerInstrument(request: InstrumentRegisterRequest): Promise<InstrumentSearchItem>;
  readBars(request: BarsRequest): Promise<unknown>;
  quote(instrumentId: string): Promise<unknown>;
  runQuant(request: QuantRequest): Promise<unknown>;
  safetyStatus(): Promise<unknown>;
  /** IBKR read-only status: last known state, never a live call. */
  brokerIbkrStatus(): Promise<unknown>;
  /** Reads IBKR once, stores the validated snapshot and the reconciliation. Read-only: no ledger write, no order. */
  brokerIbkrSync(): Promise<unknown>;
  brokerIbkrSnapshot(): Promise<unknown>;
  brokerIbkrReconciliation(requireFresh: boolean): Promise<unknown>;
  brokerIbkrMapInstrument(request: IbkrMappingBody): Promise<unknown>;
}

const CONID = /^[0-9]{1,15}$/;
const INSTRUMENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const PROVIDER_SYMBOL = /^[A-Za-z0-9._\-/:]{1,64}$/;
const SEARCH_TEXT = /^[A-Za-z0-9 .\-/&]{1,64}$/;
const MIC = /^[A-Z0-9]{4}$/;
const EXCHANGE = /^[A-Za-z0-9._-]{1,32}$/;
const CANONICAL_UTC = (value: string): number | null => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
};

type Route = { method: 'GET' | 'POST'; path: string };

const ROUTES: readonly Route[] = Object.freeze([
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/instruments/search' },
  { method: 'POST', path: '/api/instruments/register' },
  { method: 'GET', path: '/api/market/bars' },
  { method: 'GET', path: '/api/market/quote' },
  { method: 'POST', path: '/api/quant/run' },
  { method: 'GET', path: '/api/safety/status' },
  { method: 'GET', path: '/api/paper/intents' },
  { method: 'GET', path: '/api/broker/ibkr/status' },
  { method: 'POST', path: '/api/broker/ibkr/sync' },
  { method: 'GET', path: '/api/broker/ibkr/snapshot' },
  { method: 'GET', path: '/api/broker/ibkr/reconciliation' },
  { method: 'POST', path: '/api/broker/ibkr/mappings' },
]);

function invalid(): never {
  throw new RuntimeApiError('REQUEST_INVALID');
}

function requiredText(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null) invalid();
  return value;
}

export function parseInstrumentId(value: string): string {
  if (!INSTRUMENT_ID.test(value)) invalid();
  return value;
}

export function parseInterval(value: string): BarInterval {
  if (!(BAR_INTERVALS as readonly string[]).includes(value)) invalid();
  return value as BarInterval;
}

export function parseCanonicalUtc(value: string): string {
  if (CANONICAL_UTC(value) === null) invalid();
  return value;
}

export function parseBarsWindow(from: string, to: string): { from: string; to: string } {
  const fromMs = CANONICAL_UTC(from);
  const toMs = CANONICAL_UTC(to);
  if (fromMs === null || toMs === null || fromMs >= toMs || toMs - fromMs > MAX_BARS_WINDOW_MS) invalid();
  return { from, to };
}

export function parseSearch(value: string): string {
  if (!SEARCH_TEXT.test(value)) invalid();
  return value.trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new RuntimeApiError('PAYLOAD_TOO_LARGE');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return invalid();
  }
}

function quantBody(value: unknown): QuantRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  const allowed = new Set(['instrumentId', 'interval', 'asOf']);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid();
  if (typeof body.instrumentId !== 'string' || typeof body.interval !== 'string' || typeof body.asOf !== 'string') invalid();
  return {
    instrumentId: parseInstrumentId(body.instrumentId),
    interval: parseInterval(body.interval),
    asOf: parseCanonicalUtc(body.asOf),
  };
}

function registerBody(value: unknown): InstrumentRegisterRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  const allowed = new Set(['providerSymbol', 'validFrom', 'mic', 'exchange']);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid();
  if (typeof body.providerSymbol !== 'string' || !PROVIDER_SYMBOL.test(body.providerSymbol)) invalid();
  if (typeof body.validFrom !== 'string') invalid();
  const request: InstrumentRegisterRequest = { providerSymbol: body.providerSymbol, validFrom: parseCanonicalUtc(body.validFrom) };
  if (body.mic !== undefined) {
    if (typeof body.mic !== 'string' || !MIC.test(body.mic)) invalid();
    request.mic = body.mic;
  }
  if (body.exchange !== undefined) {
    if (typeof body.exchange !== 'string' || !EXCHANGE.test(body.exchange)) invalid();
    request.exchange = body.exchange;
  }
  return request;
}

function mappingBody(value: unknown): IbkrMappingBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  const allowed = new Set(['conid', 'instrumentId', 'validFrom']);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid();
  if (typeof body.conid !== 'string' || !CONID.test(body.conid)) invalid();
  if (typeof body.instrumentId !== 'string') invalid();
  if (typeof body.validFrom !== 'string') invalid();
  return { conid: body.conid, instrumentId: parseInstrumentId(body.instrumentId), validFrom: parseCanonicalUtc(body.validFrom) };
}

function requireFreshFlag(params: URLSearchParams): boolean {
  const value = params.get('requireFresh');
  if (value === null || value === '0') return false;
  if (value === '1') return true;
  return invalid();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/** The request handler. Every outcome is a JSON body with a stable code; nothing unexpected reaches the client. */
export function createRuntimeHandler(services: RuntimeServices): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const sameRoute = ROUTES.filter((route) => route.path === url.pathname);
      if (sameRoute.length === 0) throw new RuntimeApiError('NOT_FOUND');
      if (!sameRoute.some((route) => route.method === method)) throw new RuntimeApiError('METHOD_NOT_ALLOWED');

      const params = url.searchParams;
      switch (url.pathname) {
        case '/health':
        case '/api/health':
          return send(res, 200, await services.health());
        case '/api/instruments/search':
          return send(res, 200, { instruments: await services.searchInstruments(parseSearch(requiredText(params, 'q'))) });
        case '/api/instruments/register':
          return send(res, 201, { instrument: await services.registerInstrument(registerBody(await readJsonBody(req))) });
        case '/api/market/bars': {
          const window = parseBarsWindow(requiredText(params, 'from'), requiredText(params, 'to'));
          return send(res, 200, await services.readBars({
            instrumentId: parseInstrumentId(requiredText(params, 'instrumentId')),
            interval: parseInterval(requiredText(params, 'interval')),
            from: window.from,
            to: window.to,
          }));
        }
        case '/api/market/quote':
          return send(res, 200, await services.quote(parseInstrumentId(requiredText(params, 'instrumentId'))));
        case '/api/quant/run':
          return send(res, 200, await services.runQuant(quantBody(await readJsonBody(req))));
        case '/api/safety/status':
          return send(res, 200, await services.safetyStatus());
        case '/api/paper/intents':
          // The paper execution gate (O17) is not part of this build's main line yet; the route is reserved, not simulated.
          throw new RuntimeApiError('NOT_IMPLEMENTED');
        case '/api/broker/ibkr/status':
          return send(res, 200, await services.brokerIbkrStatus());
        case '/api/broker/ibkr/sync':
          return send(res, 200, await services.brokerIbkrSync());
        case '/api/broker/ibkr/snapshot':
          return send(res, 200, await services.brokerIbkrSnapshot());
        case '/api/broker/ibkr/reconciliation':
          return send(res, 200, await services.brokerIbkrReconciliation(requireFreshFlag(params)));
        case '/api/broker/ibkr/mappings':
          return send(res, 200, await services.brokerIbkrMapInstrument(mappingBody(await readJsonBody(req))));
        default:
          throw new RuntimeApiError('NOT_FOUND');
      }
    } catch (error) {
      const api = toRuntimeApiError(error);
      send(res, api.status, errorBody(api));
    }
  };
}
