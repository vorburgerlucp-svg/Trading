// Financial data gateway (financial-gateway:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §4–§17). The only path from a request to evidence. Read-only: there is
// no method for an order, a transfer, a withdrawal or a position change. Models never call it; the deterministic workflow does.
//
// Two paths share one set of governance checks. `fetch` returns the evidence for one provider payload. `fetchBatch` returns one evidence record per
// article of one provider call (docs/MASSIVE_NEWS_CONNECTOR_V1.md §7). Articles are never merged, and they come back in a deterministic order.

import type { InstrumentRegistry } from '../market-data/instrument-registry.js';
import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { canonicalUtc, parseUtc, toUtcIso } from '../market-data/time.js';
import type { ConnectionState, ConnectorPayload, FinancialConnector } from './connector.js';
import { buildEvidence, type FinancialEvidence } from './financial-evidence.js';
import type { FinancialEvidenceSeal } from './financial-knowledge.js';
import { licenseServes } from './financial-license.js';
import type { ConnectorEntry, FinancialConnectorRegistry } from './financial-registry.js';
import { parseFinancialRequest, type FinancialRequest } from './financial-requests.js';
import { validatePayload, type CanonicalData } from './financial-schemas.js';
import { FinancialGatewayError, modeServes } from './financial-types.js';

export interface FinancialDataGatewayOptions {
  readonly registry: FinancialConnectorRegistry;
  readonly instruments: InstrumentRegistry;
  readonly connectors: readonly FinancialConnector[];
  readonly clock: () => Date;
}

export interface FinancialBatch {
  readonly evidence: readonly FinancialEvidence[];
  /** false when the provider reported more pages, which V1 does not follow. */
  readonly complete: boolean;
}

export interface StrongO1Result {
  readonly eligible: false;
  readonly reason: 'UNSEALED_EXTERNAL_EVIDENCE' | 'FINANCIAL_SOURCE_NOT_PRODUCTION_VERIFIED';
}

/**
 * Strong O1 is never eligible in V1: no real financial provider is connected, so source quality is unverified. A database seal upgrades knowledge
 * timing only. With a seal for this evidence the reason says so, and eligibility stays false (docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §15). The
 * seal must already be verified by the caller; the store returns only verified seals.
 */
export function strongO1Eligible(evidence: FinancialEvidence, seal?: FinancialEvidenceSeal | null): StrongO1Result {
  const sealed = seal !== undefined && seal !== null && seal.evidenceId === evidence.evidenceId;
  return { eligible: false, reason: sealed ? 'FINANCIAL_SOURCE_NOT_PRODUCTION_VERIFIED' : 'UNSEALED_EXTERNAL_EVIDENCE' };
}

function selectsConnector(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const id = (raw as { connectorId?: unknown }).connectorId;
  return typeof id === 'string' && id.trim() !== '';
}

function optionalInstant(value: string | undefined, what: string): string | null {
  if (value === undefined) return null;
  try {
    return toUtcIso(parseUtc(value));
  } catch {
    throw new FinancialGatewayError('SCHEMA_INVALID', what + ' must be a UTC instant');
  }
}

function textBlocksOf(payload: ConnectorPayload): Array<{ source: string; text: string }> {
  return (payload.textBlocks ?? []).map((block) => {
    if (typeof block.source !== 'string' || typeof block.text !== 'string') throw new FinancialGatewayError('SCHEMA_INVALID', 'text blocks must carry string source and text');
    return { source: block.source, text: block.text };
  });
}

/** Fields the request names must match what the provider returned. There is no implicit FX and no period substitution. */
function checkRequestedFields(request: FinancialRequest, data: CanonicalData): void {
  if (request.capability !== 'fundamentals') return;
  if (data.currency !== request.currency) throw new FinancialGatewayError('CURRENCY_MISMATCH', 'payload is in ' + String(data.currency) + ', the request asked for ' + request.currency + '; no FX conversion is made');
  if (data.period !== request.period) throw new FinancialGatewayError('PERIOD_MISMATCH', 'payload is for ' + String(data.period) + ', the request asked for ' + request.period);
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** A runtime connector's identity must equal its registry declaration. A shared connectorId is not an identity. */
function bindIdentity(connector: FinancialConnector, entry: ConnectorEntry): void {
  if (connector.connectorId !== entry.connectorId || connector.provider !== entry.provider || connector.transport !== entry.transport) {
    throw new FinancialGatewayError(
      'CONNECTOR_IDENTITY_MISMATCH',
      'runtime connector ' + entry.connectorId + ' declares ' + connector.provider + '/' + connector.transport + ', the registry declares ' + entry.provider + '/' + entry.transport + '; no call was made',
    );
  }
}

function canonicalOrNull(value: string): string | null {
  try {
    return canonicalUtc(value);
  } catch {
    return null;
  }
}

/** The envelope is external data. Its times and hashes must already be canonical; nothing is normalised here. */
function envelopeOf(payload: ConnectorPayload): { retrievedAt: string; rawPayloadHash: string } {
  const retrievedAt = payload.retrievedAt as unknown;
  if (typeof retrievedAt !== 'string' || canonicalOrNull(retrievedAt) !== retrievedAt) {
    throw new FinancialGatewayError('CONNECTOR_PAYLOAD_INVALID', 'retrievedAt must be a canonical UTC instant');
  }
  const rawPayloadHash = payload.rawPayloadHash as unknown;
  if (typeof rawPayloadHash !== 'string' || !HEX_SHA256.test(rawPayloadHash)) {
    throw new FinancialGatewayError('CONNECTOR_PAYLOAD_INVALID', 'rawPayloadHash must be a lower-case SHA-256 hex digest');
  }
  return { retrievedAt, rawPayloadHash };
}

/** Deterministic order for a batch: provider publication time, then evidence id. Provider order is never trusted. */
function byPublicationThenId(a: FinancialEvidence, b: FinancialEvidence): number {
  const pa = a.providerPublishedAt ?? '';
  const pb = b.providerPublishedAt ?? '';
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
}

/** Everything that does not depend on the payload has been checked: the request, the registry, the license, the mode, the identity and the connection. */
interface Prepared {
  readonly request: FinancialRequest;
  readonly entry: ConnectorEntry;
  readonly connector: FinancialConnector;
  readonly connection: ConnectionState;
  readonly mapping: ProviderInstrumentMapping | null;
}

export class FinancialDataGateway {
  private readonly connectors: ReadonlyMap<string, FinancialConnector>;

  constructor(private readonly options: FinancialDataGatewayOptions) {
    const connectors = new Map<string, FinancialConnector>();
    for (const connector of options.connectors) {
      if (connectors.has(connector.connectorId)) {
        throw new FinancialGatewayError('CONNECTOR_ID_DUPLICATE', 'two runtime connectors claim ' + connector.connectorId + '; refusing to choose one');
      }
      connectors.set(connector.connectorId, connector);
    }
    this.connectors = connectors;
  }

  /** The evidence for one provider payload. */
  async fetch(raw: unknown): Promise<FinancialEvidence> {
    const prepared = this.prepare(raw);
    const payload = await prepared.connector.fetch(prepared.request, prepared.mapping);
    return this.evidenceFrom(prepared, payload, this.options.clock().toISOString());
  }

  /**
   * One evidence record per article of one provider call. Each article goes through the same checks as a single payload, and no article is merged.
   * A provider that offers only a single payload through this path is refused by the connector.
   */
  async fetchBatch(raw: unknown): Promise<FinancialBatch> {
    const prepared = this.prepare(raw);
    if (!prepared.connector.fetchBatch) {
      throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', prepared.connector.connectorId + ' has no batch path');
    }
    const batch = await prepared.connector.fetchBatch(prepared.request, prepared.mapping);
    const now = this.options.clock().toISOString();
    const evidence = batch.items.map((payload) => this.evidenceFrom(prepared, payload, now)).sort(byPublicationThenId);
    return { evidence: Object.freeze(evidence), complete: batch.complete };
  }

  /** The governance checks, in the documented order. Nothing here calls the provider. */
  private prepare(raw: unknown): Prepared {
    if (!selectsConnector(raw)) throw new FinancialGatewayError('CONNECTOR_SELECTION_REQUIRED', 'a financial request must name its connectorId');
    const request = parseFinancialRequest(raw);
    const entry = this.options.registry.get(request.connectorId);
    if (!entry) throw new FinancialGatewayError('CONNECTOR_NOT_FOUND', 'unknown connector ' + request.connectorId);
    if (!entry.enabled) throw new FinancialGatewayError('CONNECTOR_DISABLED', request.connectorId + ' is disabled; no call was made');
    if (!entry.capabilities.includes(request.capability)) {
      throw new FinancialGatewayError('CAPABILITY_NOT_ALLOWED', request.capability + ' is not in the allowlist of ' + request.connectorId);
    }
    // The license is checked before the mode, so an unapproved source reports its license, not the mode it was registered in.
    if (!licenseServes(entry.license, request.environment)) {
      throw new FinancialGatewayError('LICENSE_NOT_ALLOWED', request.connectorId + ' is ' + entry.license.status + ' and cannot serve a ' + request.environment + ' request');
    }
    if (!modeServes(entry.mode, request.environment)) {
      throw new FinancialGatewayError('MODE_NOT_ALLOWED', request.connectorId + ' runs in ' + entry.mode + ' and does not serve ' + request.environment);
    }
    const connector = this.connectors.get(request.connectorId);
    if (!connector) throw new FinancialGatewayError('DATA_NOT_CONNECTED', request.connectorId + ' has no connector instance');
    bindIdentity(connector, entry);
    if (!connector.capabilities().includes(request.capability)) {
      throw new FinancialGatewayError('CONNECTOR_CAPABILITY_MISMATCH', 'the registry allows ' + request.capability + ' for ' + request.connectorId + ', but the runtime connector does not expose it; no call was made');
    }
    const connection = connector.connection();
    if (connection === 'not_connected') throw new FinancialGatewayError('DATA_NOT_CONNECTED', request.connectorId + ' is not connected; no empty evidence is returned');
    if (connection === 'degraded' && request.environment === 'production') throw new FinancialGatewayError('DATA_DEGRADED', request.connectorId + ' is degraded and cannot serve production');
    const mapping = this.mappingOf(request, entry.provider);
    return { request, entry, connector, connection, mapping };
  }

  /** Validates one payload and builds its evidence. Used by both paths, so the checks cannot differ between them. */
  private evidenceFrom(p: Prepared, payload: ConnectorPayload, now: string): FinancialEvidence {
    const envelope = envelopeOf(payload);
    const data = validatePayload(p.request.capability, payload.candidate);
    checkRequestedFields(p.request, data);
    if (p.mapping && payload.providerSymbol !== undefined && payload.providerSymbol !== p.mapping.providerSymbol) {
      throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISMATCH', 'the payload is for ' + payload.providerSymbol + ', but ' + p.mapping.instrumentId + ' maps to ' + p.mapping.providerSymbol + ' at ' + p.request.asOf);
    }
    return buildEvidence({
      request: p.request,
      connector: { connectorId: p.request.connectorId, provider: p.entry.provider, transport: p.entry.transport },
      mode: p.entry.mode,
      license: p.entry.license,
      connectionState: p.connection,
      mappingVerified: p.mapping !== null,
      data,
      providerPublishedAt: optionalInstant(payload.providerPublishedAt, 'providerPublishedAt'),
      effectiveAt: optionalInstant(payload.effectiveAt, 'effectiveAt'),
      retrievedAt: envelope.retrievedAt,
      rawPayloadHash: envelope.rawPayloadHash,
      textBlocks: textBlocksOf(payload),
      now,
    });
  }

  private mappingOf(request: FinancialRequest, provider: string): ProviderInstrumentMapping | null {
    if (!('instrumentId' in request)) return null;
    const mapping = this.options.instruments.mappingAt(request.instrumentId, provider, request.asOf);
    if (!mapping) throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISSING', 'no ' + provider + ' symbol for ' + request.instrumentId + ' at ' + request.asOf);
    return mapping;
  }
}
