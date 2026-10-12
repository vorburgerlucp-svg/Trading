// FinancialEvidence (financial-evidence:v2, docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §2–§4, §10). Evidence is self-verifying: it carries the canonical request
// it was computed from, and every identity hash can be recomputed from its stored content. Build and verify share one set of identity and content
// functions, so they cannot drift apart. verifyFinancialEvidence never trusts a caller-supplied hash, and it fails closed on any mismatch.

import { canonicalUtc } from '../market-data/time.js';
import { deepFreeze } from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import { QUARANTINE_NOTICE, toUntrustedBlock, type InjectionFlag, type UntrustedBlock } from '../security/untrusted-input.js';
import { licenseOf, type FinancialSourceLicense } from './financial-license.js';
import { parseFinancialRequest, type FinancialRequest } from './financial-requests.js';
import { validatePayload, type CanonicalData } from './financial-schemas.js';
import { FINANCIAL_MODES, FINANCIAL_VERSIONS, type FinancialCapability, type FinancialMode, type FinancialTransport } from './financial-types.js';

export const KNOWLEDGE_PROOF = 'PROCESS_RECEIPT_UNSEALED' as const;
export const O1_STATUS = 'EXTERNAL_FINANCIAL_EVIDENCE_UNSEALED' as const;

const TRANSPORTS: readonly FinancialTransport[] = ['mcp', 'rest', 'internal'];
const CONNECTION_STATES = ['connected', 'not_connected', 'degraded'] as const;
const HEX64 = /^[0-9a-f]{64}$/;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The validated request fields that define what was asked. requestId is correlation metadata and is never part of it. */
export type CanonicalRequest = Readonly<DistributiveOmit<FinancialRequest, 'requestId'>>;

export interface EvidenceTextBlock extends UntrustedBlock {
  /** Hash of {source, text} as received. Kept after quarantine, so a stored record verifies without the original text. */
  readonly originalHash: string;
}

export interface FinancialEvidence {
  readonly evidenceId: string;
  readonly schemaVersion: 'financial-evidence:v2';
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  readonly capability: FinancialCapability;
  readonly instrumentId: string | null;
  readonly request: CanonicalRequest;
  readonly queryFingerprint: string;
  readonly effectiveAt: string | null;
  readonly providerPublishedAt: string | null;
  readonly retrievedAt: string;
  readonly nexusReceivedAt: string;
  readonly knowledgeProof: typeof KNOWLEDGE_PROOF;
  readonly rawPayloadHash: string;
  readonly contentHash: string;
  readonly data: CanonicalData;
  readonly textBlocks?: readonly EvidenceTextBlock[];
  readonly license: FinancialSourceLicense;
  readonly provenance: {
    readonly policyVersion: string;
    readonly connectorMode: FinancialMode;
    readonly licenseStatus: string;
    readonly connectionState: string;
  };
  readonly o1Status: typeof O1_STATUS;
  readonly quality: {
    readonly schemaValid: true;
    readonly mappingVerified: boolean;
    readonly currencyExplicit: boolean;
    readonly degraded: boolean;
  };
  /** Envelope creation time. It is not part of the identity. */
  readonly createdAt: string;
}

/** A stored or built record failed an integrity relation. Never a caller convenience error: it means the data cannot be trusted. */
export class FinancialEvidenceIntegrityError extends Error {
  override readonly name = 'FinancialEvidenceIntegrityError';
  readonly code = 'EVIDENCE_INTEGRITY_ERROR' as const;
}

function integrity(message: string): FinancialEvidenceIntegrityError {
  return new FinancialEvidenceIntegrityError(message);
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw integrity(message);
}

/** The canonical request: the validated request fields without the correlation id. */
export function canonicalRequestOf(request: FinancialRequest): CanonicalRequest {
  return Object.freeze(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'requestId')) as CanonicalRequest);
}

interface TextDigest {
  readonly source: string;
  readonly originalHash: string;
  readonly quarantined: boolean;
  readonly flags: readonly InjectionFlag[];
}

/** The identity projection: the fields that say what the evidence is, and nothing about when NEXUS saw it (§3). */
export interface IdentityFields {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  readonly capability: FinancialCapability;
  readonly queryFingerprint: string;
  readonly instrumentId: string | null;
  readonly contentHash: string;
  readonly effectiveAt: string | null;
  readonly providerPublishedAt: string | null;
  readonly license: FinancialSourceLicense;
}

function identityProjectionOf(f: IdentityFields) {
  return {
    schemaVersion: FINANCIAL_VERSIONS.evidence,
    connectorId: f.connectorId,
    provider: f.provider,
    transport: f.transport,
    capability: f.capability,
    queryFingerprint: f.queryFingerprint,
    instrumentId: f.instrumentId,
    contentHash: f.contentHash,
    effectiveAt: f.effectiveAt,
    providerPublishedAt: f.providerPublishedAt,
    license: { status: f.license.status, redistribution: f.license.redistribution },
    provenancePolicyVersion: FINANCIAL_VERSIONS.gateway,
  };
}

/** The semantic identity hash (without the fe_ prefix). It is the same for every equivalent fetch, whatever its process times. */
export function identityHashOf(f: IdentityFields): string {
  return hashOf(identityProjectionOf(f));
}

/**
 * The content hash binds the normalized data and each text block's source, original hash, quarantine state and flags, in order. It projects each
 * block itself, so no caller can hash a field that verification does not see.
 */
export function contentHashOf(data: CanonicalData, textBlocks: readonly TextDigest[]): string {
  return hashOf({ data, textBlocks: textBlocks.map(digestOf) });
}

/** Recomputes every identity hash from the content of an evidence record. Verification and the attacker's forgery both use it. */
export function recomputeIdentity(e: FinancialEvidence): { queryFingerprint: string; contentHash: string; evidenceId: string } {
  const queryFingerprint = hashOf(e.request);
  const contentHash = contentHashOf(e.data, e.textBlocks ?? []);
  const instrumentId = e.instrumentId;
  const identity = identityHashOf({ connectorId: e.connectorId, provider: e.provider, transport: e.transport, capability: e.capability, queryFingerprint, instrumentId, contentHash, effectiveAt: e.effectiveAt, providerPublishedAt: e.providerPublishedAt, license: e.license });
  return { queryFingerprint, contentHash, evidenceId: 'fe_' + identity };
}

function digestOf(b: { readonly source: string; readonly originalHash: string; readonly quarantined: boolean; readonly flags: readonly InjectionFlag[] }): TextDigest {
  return { source: b.source, originalHash: b.originalHash, quarantined: b.quarantined, flags: b.flags.map((f) => ({ rule: f.rule, excerpt: f.excerpt })) };
}

export interface EvidenceInput {
  readonly request: FinancialRequest;
  readonly connector: { readonly connectorId: string; readonly provider: string; readonly transport: FinancialTransport };
  readonly mode: FinancialMode;
  readonly license: FinancialSourceLicense;
  readonly connectionState: string;
  readonly mappingVerified: boolean;
  readonly data: CanonicalData;
  readonly providerPublishedAt: string | null;
  readonly effectiveAt: string | null;
  readonly retrievedAt: string;
  readonly rawPayloadHash: string;
  readonly textBlocks: ReadonlyArray<{ readonly source: string; readonly text: string }>;
  /** NEXUS process time at which the gateway accepted the response. It is also the envelope creation time. */
  readonly now: string;
}

export function buildEvidence(input: EvidenceInput): FinancialEvidence {
  const request = canonicalRequestOf(input.request);
  const instrumentId = 'instrumentId' in request ? request.instrumentId : null;
  const digests = input.textBlocks.map((block) => {
    const scanned = toUntrustedBlock('', block.source, block.text);
    return { source: block.source, displayText: scanned.text, quarantined: scanned.quarantined, flags: scanned.flags, originalHash: hashOf({ source: block.source, text: block.text }) };
  });
  const queryFingerprint = hashOf(request);
  const contentHash = contentHashOf(input.data, digests);
  const evidenceId =
    'fe_' +
    identityHashOf({
      connectorId: input.connector.connectorId,
      provider: input.connector.provider,
      transport: input.connector.transport,
      capability: request.capability,
      queryFingerprint,
      instrumentId,
      contentHash,
      effectiveAt: input.effectiveAt,
      providerPublishedAt: input.providerPublishedAt,
      license: input.license,
    });
  const textBlocks: EvidenceTextBlock[] = digests.map((d) => ({ evidenceId, source: d.source, text: d.displayText, quarantined: d.quarantined, flags: d.flags, originalHash: d.originalHash }));
  return deepFreeze({
    evidenceId,
    schemaVersion: FINANCIAL_VERSIONS.evidence,
    connectorId: input.connector.connectorId,
    provider: input.connector.provider,
    transport: input.connector.transport,
    capability: request.capability,
    instrumentId,
    request,
    queryFingerprint,
    effectiveAt: input.effectiveAt,
    providerPublishedAt: input.providerPublishedAt,
    retrievedAt: input.retrievedAt,
    nexusReceivedAt: input.now,
    knowledgeProof: KNOWLEDGE_PROOF,
    rawPayloadHash: input.rawPayloadHash,
    contentHash,
    data: input.data,
    ...(textBlocks.length > 0 ? { textBlocks } : {}),
    license: input.license,
    provenance: { policyVersion: FINANCIAL_VERSIONS.gateway, connectorMode: input.mode, licenseStatus: input.license.status, connectionState: input.connectionState },
    o1Status: O1_STATUS,
    quality: { schemaValid: true, mappingVerified: input.mappingVerified, currencyExplicit: typeof input.data.currency === 'string', degraded: input.connectionState === 'degraded' },
    createdAt: input.now,
  });
}

const EVIDENCE_KEYS = ['evidenceId', 'schemaVersion', 'connectorId', 'provider', 'transport', 'capability', 'instrumentId', 'request', 'queryFingerprint', 'effectiveAt', 'providerPublishedAt', 'retrievedAt', 'nexusReceivedAt', 'knowledgeProof', 'rawPayloadHash', 'contentHash', 'data', 'textBlocks', 'license', 'provenance', 'o1Status', 'quality', 'createdAt'];
const REQUIRED_KEYS = EVIDENCE_KEYS.filter((k) => k !== 'textBlocks');
const TEXT_BLOCK_KEYS = ['evidenceId', 'source', 'text', 'quarantined', 'flags', 'originalHash'];

function plainObject(value: unknown, what: string): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), what + ' must be an object');
  return value as Record<string, unknown>;
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], allowed: readonly string[], what: string): void {
  for (const key of Object.keys(o)) check(allowed.includes(key), what + ' has an unexpected field "' + key + '"');
  for (const key of required) check(o[key] !== undefined, what + ' is missing "' + key + '"');
}

function isCanonicalInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return canonicalUtc(value) === value;
  } catch {
    return false;
  }
}

function nullableInstant(value: unknown): boolean {
  return value === null || isCanonicalInstant(value);
}

function verifyTextBlock(value: unknown): TextDigest & { evidenceId: unknown } {
  const b = plainObject(value, 'text block');
  exactKeys(b, TEXT_BLOCK_KEYS, TEXT_BLOCK_KEYS, 'text block');
  check(typeof b.source === 'string' && b.source.trim() !== '' && b.source.length <= 200, 'text block source must be a non-empty string of at most 200 characters');
  check(typeof b.text === 'string' && b.text.length <= 20_000, 'text block text must be a string of at most 20000 characters');
  check(typeof b.quarantined === 'boolean', 'text block quarantine flag must be boolean');
  check(Array.isArray(b.flags) && b.flags.every((f) => typeof f === 'object' && f !== null && typeof (f as { rule?: unknown }).rule === 'string' && typeof (f as { excerpt?: unknown }).excerpt === 'string'), 'text block flags are malformed');
  check(typeof b.originalHash === 'string' && HEX64.test(b.originalHash), 'text block original hash must be a sha-256 digest');
  const flags = b.flags as InjectionFlag[];
  if (b.quarantined === true) {
    check(b.text === QUARANTINE_NOTICE && flags.length > 0, 'a quarantined text block must carry the notice and at least one flag');
  } else {
    check(flags.length === 0, 'an unquarantined text block must carry no flags');
    check(hashOf({ source: b.source, text: b.text }) === b.originalHash, 'an unquarantined text block does not match its original hash');
  }
  return { source: b.source as string, originalHash: b.originalHash as string, quarantined: b.quarantined as boolean, flags, evidenceId: b.evidenceId };
}

function verifyBody(input: unknown): FinancialEvidence {
  const e = plainObject(input, 'evidence');
  exactKeys(e, REQUIRED_KEYS, EVIDENCE_KEYS, 'evidence');
  check(e.schemaVersion === FINANCIAL_VERSIONS.evidence, 'schema version must be ' + FINANCIAL_VERSIONS.evidence);

  const request = plainObject(e.request, 'request snapshot');
  check(!('requestId' in request), 'the request snapshot must not carry a requestId');
  const parsed = parseFinancialRequest({ ...request, requestId: 'verify' });
  check(hashOf(canonicalRequestOf(parsed)) === hashOf(request), 'the request snapshot is not in canonical form');
  check(e.queryFingerprint === hashOf(request), 'queryFingerprint does not match the canonical request');
  check(e.connectorId === request.connectorId, 'connectorId does not match the request');
  check(e.capability === request.capability, 'capability does not match the request');
  const instrumentId = ('instrumentId' in request ? request.instrumentId : null) as string | null;
  check(e.instrumentId === instrumentId, 'instrumentId does not match the request');
  check(typeof e.provider === 'string' && e.provider.trim() !== '' && e.provider.length <= 64, 'provider must be a non-empty name of at most 64 characters');
  check(TRANSPORTS.includes(e.transport as FinancialTransport), 'transport is not recognised');
  check(nullableInstant(e.effectiveAt), 'effectiveAt must be canonical UTC or null');
  check(nullableInstant(e.providerPublishedAt), 'providerPublishedAt must be canonical UTC or null');
  check(isCanonicalInstant(e.retrievedAt), 'retrievedAt must be canonical UTC');
  check(isCanonicalInstant(e.nexusReceivedAt), 'nexusReceivedAt must be canonical UTC');
  check(isCanonicalInstant(e.createdAt), 'createdAt must be canonical UTC');
  check(e.knowledgeProof === KNOWLEDGE_PROOF, 'knowledgeProof must be ' + KNOWLEDGE_PROOF);
  check(e.o1Status === O1_STATUS, 'o1Status must be ' + O1_STATUS);
  check(typeof e.rawPayloadHash === 'string' && HEX64.test(e.rawPayloadHash), 'rawPayloadHash must be a sha-256 digest');

  // The data must already be in normalized form: running the capability validator on it again must change nothing.
  const data = plainObject(e.data, 'data');
  const capability = request.capability as FinancialCapability;
  check(hashOf(validatePayload(capability, data)) === hashOf(data), 'data is not in canonical normalized form');
  if (capability === 'fundamentals') {
    check(data.currency === request.currency, 'data currency does not match the requested currency');
    check(data.period === request.period, 'data period does not match the requested period');
  }

  const license = licenseOf(e.license);
  check(hashOf(license) === hashOf(e.license), 'license has unexpected fields');

  const blocks = e.textBlocks === undefined ? [] : e.textBlocks;
  check(Array.isArray(blocks), 'textBlocks must be a list');
  const digests = blocks.map(verifyTextBlock);

  const contentHash = contentHashOf(data as CanonicalData, digests);
  check(e.contentHash === contentHash, 'contentHash does not match the data and the text bindings');
  const identity = identityHashOf({ connectorId: e.connectorId as string, provider: e.provider as string, transport: e.transport as FinancialTransport, capability, queryFingerprint: e.queryFingerprint as string, instrumentId, contentHash, effectiveAt: e.effectiveAt as string | null, providerPublishedAt: e.providerPublishedAt as string | null, license });
  check(e.evidenceId === 'fe_' + identity, 'evidenceId does not match the identity of the record');
  for (const b of digests) check(b.evidenceId === e.evidenceId, 'a text block belongs to another evidence record');

  const provenance = plainObject(e.provenance, 'provenance');
  exactKeys(provenance, ['policyVersion', 'connectorMode', 'licenseStatus', 'connectionState'], ['policyVersion', 'connectorMode', 'licenseStatus', 'connectionState'], 'provenance');
  check(provenance.policyVersion === FINANCIAL_VERSIONS.gateway, 'provenance policy version is not ' + FINANCIAL_VERSIONS.gateway);
  check(provenance.licenseStatus === license.status, 'provenance license status does not match the license');
  check((FINANCIAL_MODES as readonly unknown[]).includes(provenance.connectorMode), 'provenance connector mode is not recognised');
  check((CONNECTION_STATES as readonly unknown[]).includes(provenance.connectionState), 'provenance connection state is not recognised');

  const quality = plainObject(e.quality, 'quality');
  exactKeys(quality, ['schemaValid', 'mappingVerified', 'currencyExplicit', 'degraded'], ['schemaValid', 'mappingVerified', 'currencyExplicit', 'degraded'], 'quality');
  check(quality.schemaValid === true, 'quality.schemaValid must be true');
  check(typeof quality.mappingVerified === 'boolean', 'quality.mappingVerified must be boolean');
  check(quality.currencyExplicit === (typeof data.currency === 'string'), 'quality.currencyExplicit contradicts the data');
  check(quality.degraded === (provenance.connectionState === 'degraded'), 'quality.degraded contradicts the connection state');

  return e as unknown as FinancialEvidence;
}

/**
 * Verifies a FinancialEvidence record and returns a deep-frozen copy. Every integrity relation is recomputed: the canonical request, the query
 * fingerprint, the instrument consistency, the normalized data, the content hash, the text bindings, the evidence id, the license, the provenance and
 * the quality flags. Anything that does not hold fails closed.
 */
export function verifyFinancialEvidence(value: unknown): FinancialEvidence {
  try {
    return deepFreeze(verifyBody(structuredClone(value)));
  } catch (error) {
    if (error instanceof FinancialEvidenceIntegrityError) throw error;
    throw integrity('evidence failed verification: ' + (error instanceof Error ? error.message : String(error)));
  }
}
