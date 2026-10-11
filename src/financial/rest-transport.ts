// REST transport (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §10). Shares ResilientCaller with the market-data providers: bounded retries, Retry-After, pacing
// and the circuit breaker. The secret travels only in the Authorization header. Provider text never reaches an error message, so nothing needs redacting.

import { MarketDataError } from '../market-data/market-data-provider.js';
import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { parseRetryAfter, type FetchLike, type HttpResponseLike, type ResilientCaller } from '../market-data/providers/resilience.js';
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
}

export class RestFinancialConnector implements FinancialConnector {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport = 'rest';
  private readonly credentialRef: string;

  constructor(private readonly options: RestConnectorOptions) {
    this.connectorId = options.connectorId;
    this.provider = options.provider;
    this.credentialRef = credentialRefOf(options.credentialRef);
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
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not retried: repeating a malformed answer cannot help and may burn quota.
      throw new FinancialGatewayError('SCHEMA_INVALID', 'the provider answered with a body that is not JSON');
    }
  }

  private statusFailure(response: HttpResponseLike): MarketDataError | null {
    const status = response.status;
    if (status >= 200 && status < 300) return null;
    const provider = this.provider;
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.options.clock().getTime());
      return new MarketDataError('rate_limited', provider, 'rate limited by the provider (HTTP 429)', retryAfterMs === undefined ? { status } : { status, retryAfterMs });
    }
    if (status === 401 || status === 403) return new MarketDataError('auth_failed', provider, 'authentication refused (HTTP ' + status + ')', { status });
    if (status === 404) return new MarketDataError('not_found', provider, 'not found (HTTP 404)', { status });
    if (status >= 500) return new MarketDataError('provider_unavailable', provider, 'provider unavailable (HTTP ' + status + ')', { status });
    return new MarketDataError('bad_request', provider, 'request refused (HTTP ' + status + ')', { status });
  }
}
