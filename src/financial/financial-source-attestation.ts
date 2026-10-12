// The official-source attestation record (financial-source-attestation:v1, docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §18–§22). It is a sidecar to an existing
// FinancialEvidence record. It says what an official SEC filing supports about the historical existence of the filing that the equivalent data came from. It
// is not NEXUS's database knowledge, and it never changes the evidence it attests.
//
// Identity (attestationId) covers the semantic fields only: the evidence binding, the accession, the form, the filing date, the artifact URL and hash, the
// selected-facts hash and the policy. The raw acceptance value is metadata inside the record hash, not identity. The creation time is the database column
// attested_at, outside the hashed record, because the application cannot know it before insertion.

import { deepFreeze } from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import { secArchiveHeaderUrl } from './sec-archive-header.js';
import { SOURCE_POLICY_VERSION } from './historical-policy.js';
import { FinancialSourceAttestationError } from './source-attestation-errors.js';

export { FinancialSourceAttestationError, type SourceAttestationErrorCode } from './source-attestation-errors.js';

export const FINANCIAL_SOURCE_ATTESTATION_VERSION = 'financial-source-attestation:v1';

/** The only source this version attests (§8). */
const SUPPORTED = { provider: 'sec-edgar', connectorId: 'sec-edgar-fundamentals-rest', capability: 'fundamentals' } as const;
/** The only forms that can be a source (§24). Amendments are never sources. */
const SOURCE_FORMS: readonly string[] = ['10-Q', '10-K'];

const HEX64 = /^[0-9a-f]{64}$/;
const EVIDENCE_ID = /^fe_[0-9a-f]{64}$/;
const CIK = /^\d{10}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCEPTANCE_RAW = /^\d{14}$/;
const INSTRUMENT = /^[\x20-\x7e]{1,128}$/;

/** The use cases of a historical read (§5). Source attestations are never used for decision_time. */
export type FinancialReplayUseCase = 'decision_time' | 'historical_research';

/** The source vocabulary, distinct from the DB knowledge vocabulary (§9). */
export const SOURCE_RESULTS = ['SOURCE_ATTESTED_RESEARCH_AVAILABLE', 'SOURCE_NOT_YET_ELIGIBLE', 'SOURCE_ATTESTATION_MISSING', 'SOURCE_ATTESTATION_INVALID'] as const;
export type SourceResult = (typeof SOURCE_RESULTS)[number];

/** What the attestor derives. Nothing here is a caller's claim: every value is checked against the deterministic selection and the official archive. */
export interface SourceAttestationDraft {
  readonly evidenceId: string;
  readonly evidenceRecordHash: string;
  readonly evidenceContentHash: string;
  readonly provider: string;
  readonly connectorId: string;
  readonly capability: string;
  readonly instrumentId: string;
  readonly cik: string;
  readonly sourceId: string;
  readonly sourceForm: string;
  readonly sourceFilingDate: string;
  readonly sourceAcceptanceRaw: string | null;
  readonly sourceArtifactHash: string;
  readonly selectedFactsHash: string;
  readonly policyVersion: string;
}

export interface FinancialSourceAttestation {
  readonly schemaVersion: typeof FINANCIAL_SOURCE_ATTESTATION_VERSION;
  readonly policyVersion: string;
  readonly evidenceId: string;
  readonly evidenceRecordHash: string;
  readonly evidenceContentHash: string;
  readonly provider: string;
  readonly connectorId: string;
  readonly capability: string;
  readonly instrumentId: string;
  readonly cik: string;
  readonly sourceId: string;
  readonly sourceForm: string;
  readonly sourceFilingDate: string;
  readonly sourceAcceptanceRaw: string | null;
  readonly sourceArtifactUrl: string;
  readonly sourceArtifactHash: string;
  readonly selectedFactsHash: string;
  readonly attestationId: string;
  readonly attestationHash: string;
}

/** The fields the record carries before its identifiers are added. */
type Fields = Omit<FinancialSourceAttestation, 'attestationId' | 'attestationHash'>;

/** The fields that define semantic identity (§22). Acceptance metadata, creation time, runtime and retrieval timing are not in this list. */
const IDENTITY_FIELDS = [
  'schemaVersion',
  'policyVersion',
  'evidenceId',
  'evidenceRecordHash',
  'evidenceContentHash',
  'provider',
  'connectorId',
  'capability',
  'instrumentId',
  'cik',
  'sourceId',
  'sourceForm',
  'sourceFilingDate',
  'sourceArtifactUrl',
  'sourceArtifactHash',
  'selectedFactsHash',
] as const;

const RECORD_FIELDS = [...IDENTITY_FIELDS, 'sourceAcceptanceRaw', 'attestationId', 'attestationHash'] as const;

function invalid(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_INVALID', message);
}

function unsupported(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_UNSUPPORTED', message);
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y = 0, m = 0, d = 0] = value.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** Checks a draft and returns the record fields. The scope is checked first: a source that is not SEC fundamentals is unsupported, not invalid. */
function fieldsOf(d: Record<string, unknown>): Fields {
  if (d.provider !== SUPPORTED.provider || d.connectorId !== SUPPORTED.connectorId || d.capability !== SUPPORTED.capability) {
    unsupported('the source is not SEC EDGAR fundamentals: ' + String(d.provider) + '/' + String(d.connectorId) + '/' + String(d.capability));
  }
  if (typeof d.sourceForm !== 'string' || !SOURCE_FORMS.includes(d.sourceForm)) unsupported('the form is not a V1 source form: ' + String(d.sourceForm));
  if (d.policyVersion !== SOURCE_POLICY_VERSION) invalid('the policy version is not supported: ' + String(d.policyVersion));
  if (typeof d.evidenceId !== 'string' || !EVIDENCE_ID.test(d.evidenceId)) invalid('evidenceId is malformed');
  for (const key of ['evidenceRecordHash', 'evidenceContentHash', 'sourceArtifactHash', 'selectedFactsHash'] as const) {
    if (typeof d[key] !== 'string' || !HEX64.test(d[key])) invalid(key + ' must be a lowercase SHA-256 digest');
  }
  if (typeof d.instrumentId !== 'string' || !INSTRUMENT.test(d.instrumentId)) invalid('instrumentId must be printable text of at most 128 characters');
  if (typeof d.cik !== 'string' || !CIK.test(d.cik)) invalid('cik must be exactly ten digits');
  if (typeof d.sourceId !== 'string' || !ACCESSION.test(d.sourceId)) invalid('sourceId must be a valid accession number');
  if (!calendarDate(d.sourceFilingDate)) invalid('sourceFilingDate must be a valid calendar date');
  if (d.sourceAcceptanceRaw !== null && (typeof d.sourceAcceptanceRaw !== 'string' || !ACCEPTANCE_RAW.test(d.sourceAcceptanceRaw))) {
    invalid('sourceAcceptanceRaw must be null or the 14-digit archive value, never converted');
  }
  const sourceArtifactUrl = secArchiveHeaderUrl(d.cik, d.sourceId);
  return {
    schemaVersion: FINANCIAL_SOURCE_ATTESTATION_VERSION,
    policyVersion: SOURCE_POLICY_VERSION,
    evidenceId: d.evidenceId,
    evidenceRecordHash: d.evidenceRecordHash as string,
    evidenceContentHash: d.evidenceContentHash as string,
    provider: SUPPORTED.provider,
    connectorId: SUPPORTED.connectorId,
    capability: SUPPORTED.capability,
    instrumentId: d.instrumentId,
    cik: d.cik,
    sourceId: d.sourceId,
    sourceForm: d.sourceForm,
    sourceFilingDate: d.sourceFilingDate,
    sourceAcceptanceRaw: d.sourceAcceptanceRaw as string | null,
    sourceArtifactUrl,
    sourceArtifactHash: d.sourceArtifactHash as string,
    selectedFactsHash: d.selectedFactsHash as string,
  };
}

function identityOf(fields: Fields): string {
  return 'fsa_' + hashOf(Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, fields[key]])));
}

/** Builds the self-verifying record from a derived draft. The input is not mutated. */
export function buildFinancialSourceAttestation(draft: SourceAttestationDraft): FinancialSourceAttestation {
  const fields = fieldsOf({ ...draft });
  const attestationId = identityOf(fields);
  const record = { ...fields, attestationId };
  return deepFreeze({ ...record, attestationHash: hashOf(record) });
}

/** What a stored attestation must be bound to. A caller checks it against the evidence it is about to use. */
export interface SourceBinding {
  readonly evidenceId: string;
  readonly evidenceRecordHash: string;
  readonly evidenceContentHash: string;
  readonly instrumentId: string | null;
  readonly selectedFactsHash?: string;
}

/**
 * Verifies a stored or caller-supplied attestation. Every identity and hash is recomputed; no stored hash is trusted. When a binding is given, every bound
 * field must match it. Any failure is SOURCE_ATTESTATION_INVALID.
 */
export function verifyFinancialSourceAttestation(value: unknown, expected?: SourceBinding): FinancialSourceAttestation {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('the attestation must be an object');
    const o = value as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!(RECORD_FIELDS as readonly string[]).includes(key)) invalid('the attestation has an unexpected field "' + key + '"');
    for (const key of RECORD_FIELDS) if (!(key in o)) invalid('the attestation is missing "' + key + '"');
    const { attestationId, attestationHash, ...rest } = o;
    let fields: Fields;
    try {
      fields = fieldsOf(rest);
    } catch (error) {
      invalid('the attestation fields are not valid: ' + (error instanceof Error ? error.message : String(error)));
    }
    if (rest.schemaVersion !== FINANCIAL_SOURCE_ATTESTATION_VERSION) invalid('the schema version is not ' + FINANCIAL_SOURCE_ATTESTATION_VERSION);
    if (rest.sourceArtifactUrl !== fields.sourceArtifactUrl) invalid('the artifact URL is not the fixed archive URL of the accession');
    if (attestationId !== identityOf(fields)) invalid('the attestation identifier does not match its identity');
    const record = { ...fields, attestationId };
    if (attestationHash !== hashOf(record)) invalid('the attestation hash does not match the record');
    if (expected !== undefined) {
      if (fields.evidenceId !== expected.evidenceId) invalid('the attestation belongs to another evidence record');
      if (fields.evidenceRecordHash !== expected.evidenceRecordHash) invalid('the attestation binds another version of the evidence record');
      if (fields.evidenceContentHash !== expected.evidenceContentHash) invalid('the attestation binds another content of the evidence record');
      if (fields.instrumentId !== expected.instrumentId) invalid('the attestation is for another instrument');
      if (expected.selectedFactsHash !== undefined && fields.selectedFactsHash !== expected.selectedFactsHash) invalid('the selected-facts projection differs');
    }
    return deepFreeze({ ...record, attestationHash });
  } catch (error) {
    if (error instanceof FinancialSourceAttestationError && error.code === 'SOURCE_ATTESTATION_INVALID') throw error;
    invalid('the attestation failed verification: ' + (error instanceof Error ? error.message : String(error)));
  }
}
