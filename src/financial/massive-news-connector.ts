// Massive REST news connector (massive-news-rest, docs/MASSIVE_NEWS_CONNECTOR_V1.md). A deterministic, read-only adapter controlled by NEXUS: one endpoint,
// one bounded page, a strict response schema, and one payload per article. The provider's text is untrusted data. Its next_url is validated and never
// followed, so a response cannot select a URL, a tool or another connector. The API key travels only in the Authorization header.

import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { MarketDataError } from '../market-data/market-data-provider.js';
import type { ResilientCaller, FetchLike } from '../market-data/providers/resilience.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { ConnectionState, ConnectorBatch, ConnectorPayload, FinancialConnector, FinancialConnectorHealth } from './connector.js';
import type { FinancialRequest } from './financial-requests.js';
import { FinancialGatewayError, type FinancialCapability, type FinancialTransport } from './financial-types.js';
import { restFailureOf } from './rest-transport.js';
import type { SecretProvider } from './secrets.js';

export const MASSIVE_CONNECTOR_ID = 'massive-news-rest';
export const MASSIVE_PROVIDER = 'massive';
export const MASSIVE_CREDENTIAL_REF = 'massive-api-key';

const ENDPOINT = 'https://api.massive.com/v2/reference/news';
const HOST = 'api.massive.com';
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 50;
const ROOT_KEYS = ['status', 'request_id', 'count', 'results', 'next_url'];
const ARTICLE_KEYS = ['id', 'publisher', 'title', 'published_utc', 'article_url', 'author', 'image_url', 'amp_url', 'description', 'tickers', 'keywords', 'insights'];
const PUBLISHER_KEYS = ['name', 'homepage_url', 'logo_url', 'favicon_url'];
const CREDENTIAL_PARAMS = /^(apikey|api_key|token|key|credential|password|secret)$/i;
// RFC 3339 date-time in UTC: seconds required, and an optional fraction of 1 to 9 digits (the nanosecond bound). Offsets and local times do not match.
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface MassiveNewsOptions {
  readonly secrets: SecretProvider;
  readonly fetch: FetchLike;
  readonly caller: ResilientCaller;
  readonly clock: () => Date;
  /** Results per call, 1 to 50. The default is 10. */
  readonly limit?: number;
}

/** The fields NEXUS keeps from one article. Everything else the provider sent is validated and then not used. */
interface Article {
  readonly id: string;
  readonly publisherName: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly articleUrl: string;
  readonly description: string | undefined;
}

function invalid(message: string): never {
  throw new FinancialGatewayError('SCHEMA_INVALID', 'Massive response: ' + message);
}

function objectOf(value: unknown, what: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(what + ' must be an object');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) invalid(what + ' has an unexpected field "' + key + '"');
  }
  return o;
}

function textOf(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL.test(value)) invalid(what + ' must be a printable string of at most ' + max + ' characters');
  return value;
}

/**
 * RFC 3339 UTC with 0 to 9 fractional digits. The fraction is truncated to NEXUS milliseconds, never rounded, so sub-millisecond provider precision is
 * not retained (docs/MASSIVE_NEWS_CONNECTOR_V1.md, timestamp precision). Impossible dates and times are refused, and so are years before 0100.
 */
function utcOf(value: unknown): string {
  const match = typeof value === 'string' ? RFC3339_UTC.exec(value) : null;
  if (!match) invalid('published_utc must be RFC 3339 UTC (...Z) with at most nine fractional digits');
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (y < 100 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) invalid('published_utc has an impossible date or time');
  const millis = Number((fraction + '000').slice(0, 3));
  const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, s, millis));
  // Date.UTC rolls an impossible day into the next month, so the calendar fields must survive the round trip.
  if (instant.getUTCFullYear() !== y || instant.getUTCMonth() !== mo - 1 || instant.getUTCDate() !== d) invalid('published_utc has an impossible date');
  return instant.toISOString();
}

function httpsUrlOf(value: unknown, what: string): string {
  const text = textOf(value, what, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid(what + ' is not a URL');
  }
  if (url.protocol !== 'https:' || url.hostname === '') invalid(what + ' must be an https URL');
  return text;
}

/** next_url is never followed. Its presence is checked: it must be HTTPS on the Massive host, with no credential, or the page is refused. */
function nextUrlOf(value: unknown): string {
  const text = textOf(value, 'next_url', 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid('next_url is not a URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== HOST) invalid('next_url must be an https URL on ' + HOST);
  if (url.username !== '' || url.password !== '') invalid('next_url must not carry credentials');
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_PARAMS.test(key)) invalid('next_url must not carry a credential parameter');
  }
  return text;
}

function stringArrayOf(value: unknown, what: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length <= 200)) invalid(what + ' must be a list of short strings');
}

function articleOf(value: unknown, index: number): Article {
  const a = objectOf(value, 'article ' + index, ARTICLE_KEYS);
  const publisher = objectOf(a.publisher, 'publisher', PUBLISHER_KEYS);
  for (const key of ['homepage_url', 'logo_url', 'favicon_url']) {
    if (publisher[key] !== undefined) textOf(publisher[key], key, 2048);
  }
  if (a.author !== undefined) textOf(a.author, 'author', 200);
  if (a.image_url !== undefined) textOf(a.image_url, 'image_url', 2048);
  if (a.amp_url !== undefined) textOf(a.amp_url, 'amp_url', 2048);
  if (a.tickers !== undefined) stringArrayOf(a.tickers, 'tickers');
  if (a.keywords !== undefined) stringArrayOf(a.keywords, 'keywords');
  if (a.insights !== undefined && !Array.isArray(a.insights)) invalid('insights must be a list');
  return {
    id: textOf(a.id, 'article id', 200),
    publisherName: textOf(publisher.name, 'publisher name', 200),
    title: textOf(a.title, 'title', 2000),
    publishedAt: utcOf(a.published_utc),
    articleUrl: httpsUrlOf(a.article_url, 'article_url'),
    description: a.description === undefined ? undefined : textOf(a.description, 'description', 5000),
  };
}

interface Page {
  readonly articles: ReadonlyArray<{ readonly raw: Record<string, unknown>; readonly article: Article }>;
  readonly nextUrl: string | undefined;
}

function pageOf(value: unknown, limit: number): Page {
  const root = objectOf(value, 'page', ROOT_KEYS);
  // status is optional. When present it must be OK, so an error status inside an HTTP 200 is refused.
  if (root.status !== undefined && root.status !== 'OK') invalid('status must be OK when present');
  if (root.request_id !== undefined) textOf(root.request_id, 'request_id', 200);
  if (root.count !== undefined && (typeof root.count !== 'number' || !Number.isInteger(root.count) || root.count < 0)) invalid('count must be a non-negative integer');
  // results is optional: absent is an empty batch. Present must be a list, and a malformed value is never read as empty.
  const results: unknown = root.results === undefined ? [] : root.results;
  if (!Array.isArray(results)) invalid('results must be a list when present');
  if (results.length > limit) invalid('more results than the requested limit');
  const seen = new Set<string>();
  const articles = results.map((entry: unknown, index: number) => {
    const article = articleOf(entry, index);
    if (seen.has(article.id)) invalid('two articles share the id ' + article.id);
    seen.add(article.id);
    return { raw: entry as Record<string, unknown>, article };
  });
  return { articles, nextUrl: root.next_url === undefined ? undefined : nextUrlOf(root.next_url) };
}

/** The normalized payload for one article. The raw hash is the canonical hash of that article as the page delivered it. */
function payloadOf(raw: Record<string, unknown>, article: Article, providerSymbol: string, retrievedAt: string): ConnectorPayload {
  const textBlocks = [
    { source: 'massive:title', text: article.title },
    ...(article.description !== undefined ? [{ source: 'massive:description', text: article.description }] : []),
  ];
  return {
    candidate: { articleId: article.id, publisher: article.publisherName, publishedAt: article.publishedAt, url: article.articleUrl },
    providerSymbol,
    providerPublishedAt: article.publishedAt,
    textBlocks,
    retrievedAt,
    rawPayloadHash: hashOf(raw),
  };
}

export class MassiveNewsRestConnector implements FinancialConnector {
  readonly connectorId = MASSIVE_CONNECTOR_ID;
  readonly provider = MASSIVE_PROVIDER;
  readonly transport: FinancialTransport = 'rest';
  private readonly limit: number;

  constructor(private readonly options: MassiveNewsOptions) {
    const limit = options.limit ?? LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
      throw new FinancialGatewayError('REQUEST_INVALID', 'the Massive result limit must be an integer from 1 to ' + LIMIT_MAX);
    }
    this.limit = limit;
  }

  connection(): ConnectionState {
    return this.options.secrets.get(MASSIVE_CREDENTIAL_REF) ? 'connected' : 'not_connected';
  }

  capabilities(): readonly FinancialCapability[] {
    return ['news'];
  }

  health(): FinancialConnectorHealth {
    return { connectorId: this.connectorId, connection: this.connection(), lastErrorCode: this.options.caller.health().lastErrorCode ?? null };
  }

  /** A Massive call answers several articles, and this connector refuses to pick one. Use the batch path, which keeps every article separate. */
  async fetch(): Promise<ConnectorPayload> {
    throw new FinancialGatewayError('REQUEST_INVALID', 'Massive news returns several articles per call; use the batch path, which keeps each article separate');
  }

  async fetchBatch(request: FinancialRequest, mapping: ProviderInstrumentMapping | null): Promise<ConnectorBatch> {
    if (request.capability !== 'news') throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', request.capability + ' is not implemented by the Massive news connector');
    if (!mapping) throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISSING', 'no Massive symbol is mapped for this instrument');
    const secret = this.options.secrets.get(MASSIVE_CREDENTIAL_REF);
    if (!secret) throw new FinancialGatewayError('DATA_NOT_CONNECTED', this.connectorId + ' has no credential configured');
    const url = this.urlFor(mapping.providerSymbol);
    const raw = await this.options.caller.call((signal) => this.send(url, secret, signal));
    const page = pageOf(raw, this.limit);
    const retrievedAt = this.options.clock().toISOString();
    return {
      items: page.articles.map(({ raw: article, article: normalized }) => payloadOf(article, normalized, mapping.providerSymbol, retrievedAt)),
      complete: page.nextUrl === undefined,
    };
  }

  /** The one endpoint, with fixed, deterministic parameters. The caller cannot add fields. */
  private urlFor(providerSymbol: string): string {
    const url = new URL(ENDPOINT);
    url.searchParams.set('ticker', providerSymbol);
    url.searchParams.set('limit', String(this.limit));
    url.searchParams.set('order', 'desc');
    url.searchParams.set('sort', 'published_utc');
    return url.toString();
  }

  private async send(url: string, secret: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.options.fetch(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + secret }, signal });
    const failure: MarketDataError | null = restFailureOf(response, MASSIVE_PROVIDER, this.options.clock().getTime(), 'not_entitled');
    if (failure) throw failure;
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not retried: repeating a malformed answer cannot help and may burn quota.
      throw new FinancialGatewayError('SCHEMA_INVALID', 'Massive response: the body is not JSON');
    }
  }
}
