// The SEC EDGAR fundamentals connector (sec-edgar-rest:v1, docs/SEC_EDGAR_FUNDAMENTALS_V1.md). It reads public SEC data over HTTPS from data.sec.gov only: two
// fixed URLs built from the mapped CIK, no caller-supplied URL, no API key, and no Authorization header. The User-Agent is the declared contact from
// SEC_USER_AGENT. It is sent to SEC and is never part of a hash or of any evidence. Without a valid contact the connector is not connected, and nothing is
// fabricated.

import { MarketDataError } from '../market-data/market-data-provider.js';
import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import type { FetchLike, HttpResponseLike, ResilientCaller } from '../market-data/providers/resilience.js';
import { hashOf, sha256Hex } from '../persistence/canonical-json.js';
import type { ConnectionState, ConnectorPayload, FinancialConnector, FinancialConnectorHealth } from './connector.js';
import type { FinancialRequest } from './financial-requests.js';
import { FinancialGatewayError, type FinancialCapability, type FinancialTransport } from './financial-types.js';
import { restFailureOf } from './rest-transport.js';
import { companyFactsOf, periodOf, SEC_CONCEPT_MAP_VERSION, SEC_FACT_SELECTION_VERSION, selectFundamentals, submissionsOf } from './sec-fact-selection.js';
import { parseSecJson, SEC_EXACT_NUMBER_VERSION } from './sec-edgar-json.js';

export const SEC_CONNECTOR_ID = 'sec-edgar-fundamentals-rest';
export const SEC_PROVIDER = 'sec-edgar';
export const SEC_USER_AGENT_ENV = 'SEC_USER_AGENT';
/** At most 8 requests per second, as a process-level floor (SEC allows 10). See §2. */
export const SEC_MIN_INTERVAL_MS = 125;
/** The documented bound for one response (§4). The body is still read whole before the post-read check. */
export const SEC_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const SEC_HOST = 'data.sec.gov';
const TRANSPORT_VERSION = 'sec-edgar-rest:v1';
const USER_AGENT_MAX = 200;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const CONTACT = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CIK = /^\d{10}$/;

/**
 * A User-Agent is valid only when it is printable ASCII, at most 200 characters, and carries a contact of the form local@domain. Anything else is
 * undefined, and the connector is then not connected. The value is never invented.
 */
export function secUserAgentOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > USER_AGENT_MAX || !PRINTABLE_ASCII.test(text) || !CONTACT.test(text)) return undefined;
  return text;
}

function cikOf(providerSymbol: string): string {
  if (!CIK.test(providerSymbol)) throw new FinancialGatewayError('REQUEST_INVALID', 'the SEC identifier must be a CIK of exactly ten digits');
  return providerSymbol;
}

/** The only two URLs this connector ever requests, both built from the validated CIK. */
export function secUrlsOf(cik: string): { submissions: string; companyFacts: string } {
  const id = cikOf(cik);
  return {
    submissions: 'https://' + SEC_HOST + '/submissions/CIK' + id + '.json',
    companyFacts: 'https://' + SEC_HOST + '/api/xbrl/companyfacts/CIK' + id + '.json',
  };
}

function fromSecHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === SEC_HOST;
  } catch {
    return false;
  }
}

/**
 * The production transport: the platform fetch with redirects refused, so the request can never be answered from another host. Node reads the
 * response; the connector checks its final URL and size before it trusts the body.
 */
export const secFetch: FetchLike = (url, init) => fetch(url, { ...init, redirect: 'error' });

export interface SecEdgarOptions {
  /** The declared contact. Undefined, or any value that fails secUserAgentOf, means not connected. */
  readonly userAgent?: string | undefined;
  readonly fetch: FetchLike;
  /** Must pace at least SEC_MIN_INTERVAL_MS between requests. */
  readonly caller: ResilientCaller;
  readonly clock: () => Date;
}

export class SecEdgarFundamentalsConnector implements FinancialConnector {
  readonly connectorId = SEC_CONNECTOR_ID;
  readonly provider = SEC_PROVIDER;
  readonly transport: FinancialTransport = 'rest';
  private readonly userAgent: string | undefined;

  constructor(private readonly options: SecEdgarOptions) {
    if (options.caller.policy.minIntervalMs < SEC_MIN_INTERVAL_MS) {
      throw new FinancialGatewayError('REGISTRATION_INVALID', 'the SEC caller must pace at least ' + SEC_MIN_INTERVAL_MS + ' ms between requests (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §2)');
    }
    this.userAgent = secUserAgentOf(options.userAgent);
  }

  connection(): ConnectionState {
    return this.userAgent === undefined ? 'not_connected' : 'connected';
  }

  capabilities(): readonly FinancialCapability[] {
    return ['fundamentals'];
  }

  health(): FinancialConnectorHealth {
    return { connectorId: this.connectorId, connection: this.connection(), lastErrorCode: this.options.caller.health().lastErrorCode ?? null };
  }

  /**
   * The fundamentals record for one period. Two sequential requests (submissions, then companyfacts), each paced by the caller. The period and the
   * mapping are checked before any request is made.
   */
  async fetch(request: FinancialRequest, mapping: ProviderInstrumentMapping | null): Promise<ConnectorPayload> {
    if (request.capability !== 'fundamentals') throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', request.capability + ' is not implemented by the SEC connector');
    periodOf(request.period);
    if (!mapping) throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISSING', 'no SEC CIK is mapped for this instrument');
    const cik = cikOf(mapping.providerSymbol);
    if (this.userAgent === undefined) throw new FinancialGatewayError('DATA_NOT_CONNECTED', SEC_CONNECTOR_ID + ' has no valid ' + SEC_USER_AGENT_ENV + '; no request was made');
    const urls = secUrlsOf(cik);
    // Each document is parsed and checked before the next request, so a malformed or foreign answer stops the sequence and spends no further quota.
    const submissionsText = await this.options.caller.call((signal) => this.send(urls.submissions, signal));
    const submissions = submissionsOf(parseSecJson(submissionsText), cik);
    const factsText = await this.options.caller.call((signal) => this.send(urls.companyFacts, signal));
    const facts = companyFactsOf(parseSecJson(factsText), cik);
    const selection = selectFundamentals(request, submissions, facts);
    return {
      candidate: selection.candidate,
      providerSymbol: cik,
      retrievedAt: this.options.clock().toISOString(),
      rawPayloadHash: hashOf({
        provider: SEC_PROVIDER,
        cik,
        submissionsPayloadHash: sha256Hex(submissionsText),
        companyFactsPayloadHash: sha256Hex(factsText),
        accession: selection.accession,
        selectedFacts: selection.selectedFacts.map((fact) => ({ taxonomy: fact.taxonomy, concept: fact.concept, unit: fact.unit, accession: fact.accession, start: fact.start, end: fact.end, val: fact.lexeme })),
        policyVersions: { rest: TRANSPORT_VERSION, concepts: SEC_CONCEPT_MAP_VERSION, selection: SEC_FACT_SELECTION_VERSION, number: SEC_EXACT_NUMBER_VERSION },
      }),
    };
  }

  /** One GET with the declared contact and no credential. Returns the exact response text, so its hash is the hash of what SEC sent. */
  private async send(url: string, signal: AbortSignal): Promise<string> {
    const response: HttpResponseLike = await this.options.fetch(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': this.userAgent ?? '' }, signal });
    if (response.url !== undefined && response.url !== '' && !fromSecHost(response.url)) {
      throw new FinancialGatewayError('CONNECTOR_PAYLOAD_INVALID', 'the response came from a host other than ' + SEC_HOST + '; it is refused and nothing is followed');
    }
    const failure: MarketDataError | null = restFailureOf(response, SEC_PROVIDER, this.options.clock().getTime(), 'access_denied');
    if (failure) throw failure;
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SEC_MAX_RESPONSE_BYTES)) {
      throw new FinancialGatewayError('SCHEMA_INVALID', 'SEC response: the response is larger than the 32 MiB bound, or its Content-Length is malformed');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > SEC_MAX_RESPONSE_BYTES) throw new FinancialGatewayError('SCHEMA_INVALID', 'SEC response: the body is larger than the 32 MiB bound');
    return text;
  }
}
