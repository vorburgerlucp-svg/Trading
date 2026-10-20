// HTTP surface of the NEXUS runtime (node:http, no framework). Read-only except the quant run, which writes an append-only
// quant run record, and the O21 demo intent routes, which write only through the governed EtoroDemoExecutionService. Routes are a
// fixed table: there is no route that resets, unlocks, arms or enables live trading, no generic order or request route, and no
// real-account route.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BAR_INTERVALS, type BarInterval, type CurrencyOrigin } from '../market-data/market-data-types.js';
import { RuntimeApiError, errorBody, toRuntimeApiError } from './errors.js';
import type { OperatorAuthenticator, OperatorIdentity } from './operator-auth.js';

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
  buildLocks: { liveTrading: true; brokerOrders: true; physicalPurchase: true; etoroDemoExecution: false };
  version: string;
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
  /** O22: present when the currency did not come from the search row itself (crypto pairs: the provider's reference data). */
  currencyOrigin?: CurrencyOrigin;
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
  /** eToro demo, read-only (O20). There is no order method on this interface, and no route can reach one. */
  etoroStatus(): Promise<unknown>;
  etoroSync(): Promise<unknown>;
  etoroSnapshot(): Promise<unknown>;
  etoroReconciliation(requireFresh: boolean): Promise<unknown>;
  /** O22: the controlled demo cycle, read only: budget, cycle reconciliation against the stored snapshot, safety readiness. */
  etoroDemoCycle(): Promise<unknown>;
  /**
   * eToro demo execution (O21). Absent when ETORO_DEMO_EXECUTION_ENABLED is off: every intent route then answers EXECUTION_DISABLED.
   * Every method goes through the EtoroDemoExecutionService; a route never reaches the adapter or the transport.
   */
  demoExecution?: DemoExecutionRoutes;
}

/**
 * The O21 intent operations a route can call. No method takes a broker id, a broker payload, a URL or a request id. Every mutating
 * method takes the operator identity the server authenticated; a request body never names who acts.
 */
export interface DemoExecutionRoutes {
  create(intent: unknown, operator: OperatorIdentity): Promise<unknown>;
  get(intentId: string): Promise<unknown>;
  approve(intentId: string, operator: OperatorIdentity): Promise<unknown>;
  execute(intentId: string, operator: OperatorIdentity): Promise<unknown>;
  refresh(intentId: string, operator: OperatorIdentity): Promise<unknown>;
  cancel(intentId: string, operator: OperatorIdentity): Promise<unknown>;
}

export interface RuntimeHandlerOptions {
  /** The operator authentication of the O21 control plane. Absent: every mutating demo intent route is refused. */
  operatorAuth?: OperatorAuthenticator | null;
}

const DEMO_INTENTS_PATH = '/api/broker/etoro/demo/intents';
const DEMO_INTENT_ROUTE = /^\/api\/broker\/etoro\/demo\/intents(?:\/([^/]+)(?:\/(approve|execute|refresh|cancel))?)?$/;
const INTENT_ID = /^eint_[0-9a-f]{40}$/;
const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset=utf-8\s*)?$/i;
const LOOPBACK_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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
  { method: 'GET', path: '/api/broker/etoro/status' },
  { method: 'POST', path: '/api/broker/etoro/sync' },
  { method: 'GET', path: '/api/broker/etoro/snapshot' },
  { method: 'GET', path: '/api/broker/etoro/reconciliation' },
  // O22: read-only status of the controlled demo cycle (budget, cycle reconciliation, safety readiness). No broker request.
  { method: 'GET', path: '/api/broker/etoro/demo/cycle' },
]);

function invalid(): never {
  throw new RuntimeApiError('REQUEST_INVALID');
}

function requiredText(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null) invalid();
  return value;
}

/** An optional flag: absent or 0 is false, 1 is true, anything else is refused. */
function optionalFlag(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  if (value === null || value === '0') return false;
  if (value === '1') return true;
  return invalid();
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

/** The raw body, bounded. A body that is present must be declared application/json: no form or text/plain request is taken. */
async function readDemoBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new RuntimeApiError('PAYLOAD_TOO_LARGE');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() !== '' && !JSON_CONTENT_TYPE.test(String(req.headers['content-type'] ?? ''))) throw new RuntimeApiError('UNSUPPORTED_MEDIA_TYPE');
  return text.trim();
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid();
  }
}

/** approve, execute, refresh and cancel take no input: the body is empty or exactly {}. Who acts comes from authentication. */
async function readNoInput(req: IncomingMessage): Promise<void> {
  const text = await readDemoBody(req);
  if (text === '') return;
  const value = parseJsonText(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 0) invalid();
}

/** create: the intent. It names no actor: the creator is passed separately as the authenticated operator. */
async function readIntentBody(req: IncomingMessage): Promise<unknown> {
  const text = await readDemoBody(req);
  if (text === '') invalid();
  const value = parseJsonText(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  if ('createdBy' in value || 'approvedBy' in value) invalid();
  return value;
}

function demoExecution(services: RuntimeServices): DemoExecutionRoutes {
  if (!services.demoExecution) throw new RuntimeApiError('EXECUTION_DISABLED');
  return services.demoExecution;
}

/**
 * The boundary of every mutating demo intent route: the operator authentication must be configured, a browser request from a
 * non-loopback origin is refused, and the request must carry the operator token. Loopback alone is not authentication.
 */
function authenticateOperator(req: IncomingMessage, auth: OperatorAuthenticator | null): OperatorIdentity {
  if (auth === null) throw new RuntimeApiError('OPERATOR_AUTH_NOT_CONFIGURED');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string | null = null;
    try {
      const parsed = new URL(origin);
      host = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
    } catch {
      host = null;
    }
    if (host === null || !LOOPBACK_ORIGIN_HOSTS.has(host)) throw new RuntimeApiError('ORIGIN_REFUSED');
  }
  const operator = auth.authenticate(req.headers.authorization);
  if (operator === null) throw new RuntimeApiError('OPERATOR_AUTH_REQUIRED');
  return operator;
}

/** The O21 intent routes. Returns false when the path is not one of them. */
async function demoIntentRoute(services: RuntimeServices, auth: OperatorAuthenticator | null, req: IncomingMessage, res: ServerResponse, pathname: string, method: string): Promise<boolean> {
  const match = DEMO_INTENT_ROUTE.exec(pathname);
  if (!match) return false;
  const [, id, step] = match;
  if (id === undefined) {
    if (method !== 'POST') throw new RuntimeApiError('METHOD_NOT_ALLOWED');
    const routes = demoExecution(services);
    const operator = authenticateOperator(req, auth);
    send(res, 201, { intent: await routes.create(await readIntentBody(req), operator) });
    return true;
  }
  if (step === undefined ? method !== 'GET' : method !== 'POST') throw new RuntimeApiError('METHOD_NOT_ALLOWED');
  if (!INTENT_ID.test(id)) invalid();
  const routes = demoExecution(services);
  if (step === undefined) {
    // Read-only: the intent view carries no secret and changes nothing.
    send(res, 200, { intent: await routes.get(id) });
    return true;
  }
  const operator = authenticateOperator(req, auth);
  await readNoInput(req);
  switch (step) {
    case 'approve':
      send(res, 200, { intent: await routes.approve(id, operator) });
      return true;
    case 'execute':
      send(res, 200, { intent: await routes.execute(id, operator) });
      return true;
    case 'refresh':
      send(res, 200, { intent: await routes.refresh(id, operator) });
      return true;
    case 'cancel':
      send(res, 200, { intent: await routes.cancel(id, operator) });
      return true;
    default:
      return false;
  }
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
export function createRuntimeHandler(services: RuntimeServices, options: RuntimeHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const operatorAuth = options.operatorAuth ?? null;
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      if (url.pathname === DEMO_INTENTS_PATH || url.pathname.startsWith(DEMO_INTENTS_PATH + '/')) {
        if (url.search !== '') throw new RuntimeApiError('REQUEST_INVALID');
        if (await demoIntentRoute(services, operatorAuth, req, res, url.pathname, method)) return;
        throw new RuntimeApiError('NOT_FOUND');
      }
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
        case '/api/broker/etoro/status':
          return send(res, 200, await services.etoroStatus());
        case '/api/broker/etoro/sync':
          return send(res, 200, await services.etoroSync());
        case '/api/broker/etoro/snapshot':
          return send(res, 200, await services.etoroSnapshot());
        case '/api/broker/etoro/reconciliation':
          return send(res, 200, await services.etoroReconciliation(optionalFlag(params, 'requireFresh')));
        case '/api/broker/etoro/demo/cycle':
          if (url.search !== '') throw new RuntimeApiError('REQUEST_INVALID');
          return send(res, 200, await services.etoroDemoCycle());
        default:
          throw new RuntimeApiError('NOT_FOUND');
      }
    } catch (error) {
      const api = toRuntimeApiError(error);
      send(res, api.status, errorBody(api));
    }
  };
}
