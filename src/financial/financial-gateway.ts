// Financial data gateway (financial-gateway:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §4–§17). The only path from a request to evidence. Read-only: there is
// no method for an order, a transfer, a withdrawal or a position change. Models never call it; the deterministic workflow does.

import type { InstrumentRegistry } from '../market-data/instrument-registry.js';
import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { canonicalUtc, parseUtc, toUtcIso } from '../market-data/time.js';
import type { ConnectorPayload, FinancialConnector } from './connector.js';
import { buildEvidence, type FinancialEvidence } from './financial-evidence.js';
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

export interface StrongO1Result {
  readonly eligible: false;
  readonly reason: 'UNSEALED_EXTERNAL_EVIDENCE';
}

/** Every V1 evidence is an unsealed process receipt (§17). Only a later database seal could qualify it, so V1 always answers false. */
export function strongO1Eligible(_evidence: FinancialEvidence): StrongO1Result {
  return { eligible: false, reason: 'UNSEALED_EXTERNAL_EVIDENCE' };
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

  async fetch(raw: unknown): Promise<FinancialEvidence> {
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
    const payload = await connector.fetch(request, mapping);
    const envelope = envelopeOf(payload);
    const data = validatePayload(request.capability, payload.candidate);
    checkRequestedFields(request, data);
    if (mapping && payload.providerSymbol !== undefined && payload.providerSymbol !== mapping.providerSymbol) {
      throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISMATCH', 'the payload is for ' + payload.providerSymbol + ', but ' + mapping.instrumentId + ' maps to ' + mapping.providerSymbol + ' at ' + request.asOf);
    }
    return buildEvidence({
      request,
      connector: { connectorId: request.connectorId, provider: entry.provider, transport: entry.transport },
      mode: entry.mode,
      license: entry.license,
      connectionState: connection,
      mappingVerified: mapping !== null,
      data,
      providerPublishedAt: optionalInstant(payload.providerPublishedAt, 'providerPublishedAt'),
      effectiveAt: optionalInstant(payload.effectiveAt, 'effectiveAt'),
      retrievedAt: envelope.retrievedAt,
      rawPayloadHash: envelope.rawPayloadHash,
      textBlocks: textBlocksOf(payload),
      now: this.options.clock().toISOString(),
    });
  }

  private mappingOf(request: FinancialRequest, provider: string): ProviderInstrumentMapping | null {
    if (!('instrumentId' in request)) return null;
    const mapping = this.options.instruments.mappingAt(request.instrumentId, provider, request.asOf);
    if (!mapping) throw new FinancialGatewayError('INSTRUMENT_MAPPING_MISSING', 'no ' + provider + ' symbol for ' + request.instrumentId + ' at ' + request.asOf);
    return mapping;
  }
}
