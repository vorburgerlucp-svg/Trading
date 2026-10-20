// O22: the governed way to add the human eToro mapping (provider etoro, provider symbol = the eToro instrument id) that the O20 sync
// and the O21 gate resolve. Nothing calls it automatically: it runs only when a named human asks for it, with the parsed report of the
// fixed metadata read as evidence. It never decides an identity by symbol similarity: the human decides; the function only refuses a
// request whose evidence contradicts the NEXUS instrument (other eToro id, other asset class, not USD, an exchange, an existing
// mapping). It writes one append-only registry event and nothing else: no order, no ledger, no other mapping.

import type { InstrumentRegistry } from '../../market-data/instrument-registry.js';
import type { AssetClass } from '../../market-data/market-data-types.js';
import { ETORO_INSTRUMENT_TYPES, type EtoroInstrumentMetadata, type EtoroInstrumentType } from './etoro-instrument-metadata.js';

export const ETORO_MAPPING_PROVIDER_NAME = 'etoro';

/** The NEXUS asset class of an eToro instrument type. A type without a NEXUS class (CFD, Bonds, TrustFunds, Options) is refused. */
const ASSET_CLASS_OF: Readonly<Partial<Record<EtoroInstrumentType, AssetClass>>> = Object.freeze({
  Crypto: 'crypto',
  Stocks: 'stock',
  ETF: 'etf',
  Forex: 'forex',
  Commodity: 'commodity',
  Indices: 'index',
});

export class EtoroMappingError extends Error {
  override readonly name = 'EtoroMappingError';
  constructor(
    readonly code: 'MAPPING_ACTOR_INVALID' | 'MAPPING_EVIDENCE_INVALID' | 'MAPPING_INSTRUMENT_INVALID' | 'MAPPING_CONFLICT',
    detail: string,
  ) {
    super(code + ': ' + detail);
  }
}

export interface GovernedEtoroMappingRequest {
  /** The existing NEXUS instrument. It is never created here. */
  readonly instrumentId: string;
  /** Canonical UTC instant, not in the future: the mapping is never backdated beyond what the human states. */
  readonly validFrom: string;
  readonly evidence: {
    /** The accepted metadata of the fixed read (instrumentMetadataReport().metadata). */
    readonly metadata: EtoroInstrumentMetadata;
    /** sha256 of the stored report, so the decision can be traced to its evidence. */
    readonly reportSha256: string;
  };
}

function canonical(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

export interface GovernedEtoroMappingPlan {
  readonly mapping: { readonly instrumentId: string; readonly provider: string; readonly providerSymbol: string; readonly providerInstrumentId: string; readonly validFrom: string };
  readonly by: { readonly kind: 'human'; readonly id: string };
  readonly reason: string;
}

/**
 * Adds the eToro mapping of one NEXUS instrument, by a named human, from verified metadata. Returns the mapping written. Every
 * contradiction is refused before anything is written.
 */
export async function applyGovernedEtoroMapping(
  registry: InstrumentRegistry,
  request: GovernedEtoroMappingRequest,
  actor: unknown,
  now: string,
): Promise<{ instrumentId: string; provider: string; providerSymbol: string; validFrom: string }> {
  const plan = planGovernedEtoroMapping(registry, request, actor, now);
  await registry.addMapping(plan.mapping, { at: now, by: plan.by, reason: plan.reason });
  return { instrumentId: plan.mapping.instrumentId, provider: plan.mapping.provider, providerSymbol: plan.mapping.providerSymbol, validFrom: plan.mapping.validFrom };
}

/** Every check of applyGovernedEtoroMapping, without writing: the mapping that would be written, or a refusal. */
export function planGovernedEtoroMapping(registry: InstrumentRegistry, request: GovernedEtoroMappingRequest, actor: unknown, now: string): GovernedEtoroMappingPlan {
  if (typeof actor !== 'object' || actor === null || Array.isArray(actor)) throw new EtoroMappingError('MAPPING_ACTOR_INVALID', 'a named human is required');
  const a = actor as Record<string, unknown>;
  if (Object.keys(a).some((k) => k !== 'kind' && k !== 'id') || a.kind !== 'human' || typeof a.id !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(a.id)) {
    throw new EtoroMappingError('MAPPING_ACTOR_INVALID', 'a named human is required');
  }
  const by = { kind: 'human' as const, id: a.id };

  const { metadata, reportSha256 } = request.evidence;
  if (typeof reportSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reportSha256)) throw new EtoroMappingError('MAPPING_EVIDENCE_INVALID', 'reportSha256 must be a lowercase sha256');
  if (!Number.isSafeInteger(metadata.instrumentId) || metadata.instrumentId <= 0) throw new EtoroMappingError('MAPPING_EVIDENCE_INVALID', 'the eToro instrument id is not a positive integer');
  if (!(ETORO_INSTRUMENT_TYPES as readonly string[]).includes(metadata.type)) throw new EtoroMappingError('MAPPING_EVIDENCE_INVALID', 'the eToro instrument type is not documented');
  const assetClass = ASSET_CLASS_OF[metadata.type];
  if (assetClass === undefined) throw new EtoroMappingError('MAPPING_EVIDENCE_INVALID', 'eToro type ' + metadata.type + ' has no NEXUS asset class');

  const nowMs = canonical(now);
  const fromMs = canonical(request.validFrom);
  if (nowMs === null || fromMs === null || fromMs > nowMs) throw new EtoroMappingError('MAPPING_EVIDENCE_INVALID', 'validFrom must be a canonical UTC instant, not in the future');

  const instrument = registry.get(request.instrumentId);
  if (instrument === undefined) throw new EtoroMappingError('MAPPING_INSTRUMENT_INVALID', 'unknown NEXUS instrument: it is never created here');
  if (!instrument.active) throw new EtoroMappingError('MAPPING_INSTRUMENT_INVALID', 'the NEXUS instrument is not active');
  if (instrument.assetClass !== assetClass) throw new EtoroMappingError('MAPPING_INSTRUMENT_INVALID', 'the NEXUS asset class contradicts the eToro type');
  if (instrument.currency !== 'USD') throw new EtoroMappingError('MAPPING_INSTRUMENT_INVALID', 'the NEXUS instrument is not quoted in USD, the only eToro order currency');

  const providerSymbol = String(metadata.instrumentId);
  if (registry.mappings(request.instrumentId).some((m) => m.provider === ETORO_MAPPING_PROVIDER_NAME && (m.validTo === undefined || Date.parse(m.validTo) > fromMs))) {
    throw new EtoroMappingError('MAPPING_CONFLICT', 'the NEXUS instrument already has an eToro mapping');
  }
  if (registry.resolve(ETORO_MAPPING_PROVIDER_NAME, providerSymbol, request.validFrom) !== null) {
    throw new EtoroMappingError('MAPPING_CONFLICT', 'the eToro instrument id is already mapped');
  }

  // No exchange: the O20 sync and the O21 gate resolve without one, and a mapping with an exchange would never match.
  const mapping = { instrumentId: request.instrumentId, provider: ETORO_MAPPING_PROVIDER_NAME, providerSymbol, providerInstrumentId: providerSymbol, validFrom: request.validFrom };
  return Object.freeze({
    mapping: Object.freeze(mapping),
    by,
    reason: 'O22 governed eToro mapping by a named human; evidence ' + reportSha256 + ' (type ' + metadata.type + ', symbol ' + metadata.symbol + ')',
  });
}
