// REST transport (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §10). Shares ResilientCaller with the market-data providers: bounded retries, Retry-After, pacing
// and the circuit breaker. The secret travels only in the Authorization header. Provider text never reaches an error message, so nothing needs redacting.

import { MarketDataError } from '../market-data/market-data-provider.js';
import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { parseRetryAfter, type FetchLike, type HttpResponseLike, type ResilientCaller } from '../market-data/providers/resilience.js';
import { assertBodyBound, BodyTransportError, readBoundedUtf8 } from '../market-data/providers/bounded-http-body.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { ConnectionState, ConnectorBody, ConnectorPayload, FinancialConnector, FinancialConnectorHealth } from './connector.js';
import type { FinancialRequest } from './financial-requests.js';
import { FinancialGatewayError, type FinancialCapability, type FinancialTransport } from './financial-types.js';
import { credentialRefOf, type SecretProvider } from './secrets.js';

export interface RestEndpoint {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface RestConnectorOptions {
  readonly connectorId: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly credentialRef: string;
  readonly secrets: SecretProvider;
  readonly fetch: FetchLike;
  readonly caller: ResilientCaller;
  readonly endpoints: Partial<Record<FinancialCapability, (request: FinancialRequest, mapping: ProviderInstrumentMapping | null) => RestEndpoint>>;
  readonly map: (capability: FinancialCapability, raw: unknown, sent: { providerSymbol?: string | undefined }) => ConnectorBody;
  readonly clock: () => Date;
  /** The byte bound for one success body. Required, so a connector cannot opt into an unbounded body (docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md §17). */
  readonly maxResponseBytes: number;
}

function forbiddenMessage(forbidden: 'auth_failed' | 'not_entitled' | 'access_denied'): string {
  if (forbidden === 'not_entitled') return 'not entitled to this dataset (HTTP 403)';
  if (forbidden === 'access_denied') return 'access refused by the provider (HTTP 403)';
  return 'authentication refused (HTTP 403)';
}

/**
 * Maps one HTTP answer to a transport error, or null for a success. Shared by every REST connector, so the status meanings cannot drift. A 403 is
 * `auth_failed` for a generic API. A provider that answers 403 for a valid key without dataset permission passes `not_entitled`. A provider whose 403 means a
 * blocked or undeclared client, not a paid entitlement, passes `access_denied` (SEC EDGAR, docs/SEC_EDGAR_FUNDAMENTALS_V1.md §5). Bodies are never
 * included: they can echo credentials, so the message names only the status.
 */
export function restFailureOf(response: HttpResponseLike, provider: string, nowMs: number, forbidden: 'auth_failed' | 'not_entitled' | 'access_denied'): MarketDataError | null {
  const status = response.status;
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), nowMs);
    return new MarketDataError('rate_limited', provider, 'rate limited by the provider (HTTP 429)', retryAfterMs === undefined ? { status } : { status, retryAfterMs });
  }
  if (status === 401) return new MarketDataError('auth_failed', provider, 'authentication refused (HTTP 401)', { status });
  if (status === 403) return new MarketDataError(forbidden, provider, forbiddenMessage(forbidden), { status });
  if (status === 404) return new MarketDataError('not_found', provider, 'not found (HTTP 404)', { status });
  if (status >= 500) return new MarketDataError('provider_unavailable', provider, 'provider unavailable (HTTP ' + status + ')', { status });
  return new MarketDataError('bad_request', provider, 'request refused (HTTP ' + status + ')', { status });
}

function boundOf(value: number): number {
  try {
    return assertBodyBound(value, "REST");
  } catch (error) {
    throw new FinancialGatewayError("REGISTRATION_INVALID", (error as Error).message);
  }
}

export class RestFinancialConnector implements FinancialConnector {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport = 'rest';
  private readonly credentialRef: string;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: RestConnectorOptions) {
    this.connectorId = options.connectorId;
    this.provider = options.provider;
    this.credentialRef = credentialRefOf(options.credentialRef);
    this.maxResponseBytes = boundOf(options.maxResponseBytes);
  }

  capabilities(): readonly FinancialCapability[] {
    return Object.keys(this.options.endpoints) as FinancialCapability[];
  }

  connection(): ConnectionState {
    return this.options.secrets.get(this.credentialRef) ? 'connected' : 'not_connected';
  }

  health(): FinancialConnectorHealth {
    return { connectorId: this.connectorId, connection: this.connection(), lastErrorCode: this.options.caller.health().lastErrorCode ?? null };
  }

  async fetch(request: FinancialRequest, mapping: ProviderInstrumentMapping | null): Promise<ConnectorPayload> {
    const endpoint = this.options.endpoints[request.capability];
    if (!endpoint) throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', 'no REST endpoint is mapped for ' + request.capability);
    const secret = this.options.secrets.get(this.credentialRef);
    if (!secret) throw new FinancialGatewayError('DATA_NOT_CONNECTED', this.connectorId + ' has no credential configured');
    const spec = endpoint(request, mapping);
    if (Object.values(spec.query).some((value) => value.includes(secret))) throw new FinancialGatewayError('REQUEST_INVALID', 'a secret must never be sent in a URL');
    const url = this.urlOf(spec);
    const raw = await this.options.caller.call((signal) => this.send(url, secret, signal));
    const body = this.options.map(request.capability, raw, { providerSymbol: mapping?.providerSymbol });
    return { ...body, retrievedAt: this.options.clock().toISOString(), rawPayloadHash: hashOf(raw) };
  }

  private urlOf(spec: RestEndpoint): string {
    const url = new URL(spec.path, this.options.baseUrl);
    for (const [key, value] of Object.entries(spec.query)) url.searchParams.set(key, value);
    return url.toString();
  }

  private async send(url: string, secret: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.options.fetch(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + secret }, signal });
    const failure = this.statusFailure(response);
    if (failure) throw failure;
    const text = await this.bodyOf(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not retried: repeating a malformed answer cannot help and may burn quota.
      throw new FinancialGatewayError('SCHEMA_INVALID', 'the provider answered with a body that is not JSON');
    }
  }

  /** The success body, read as a bounded stream. A body failure is SCHEMA_INVALID, and an abort is rethrown for the caller's timeout. */
  private async bodyOf(response: HttpResponseLike): Promise<string> {
    try {
      return await readBoundedUtf8(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof BodyTransportError) throw new FinancialGatewayError('SCHEMA_INVALID', 'the provider body is not acceptable: ' + error.message);
      throw error;
    }
  }

  private statusFailure(response: HttpResponseLike): MarketDataError | null {
    return restFailureOf(response, this.provider, this.options.clock().getTime(), 'auth_failed');
  }
}
