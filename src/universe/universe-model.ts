// Point-in-Time Universe (universe-engine:v2): the model, the canonical identities, the replay selection and the derived evidence.
// Pure functions only: the in-memory and PostgreSQL stores share them, so they cannot disagree. See docs/PIT_UNIVERSE_KNOWLEDGE_SEAL.md.
//
// A universe revision is an immutable COMPLETE (or explicitly PARTIAL) constituent snapshot. Its knowledgeAt/retrievedAt values are the
// SOURCE / INGEST CLAIM, kept as provenance. NEXUS's own knowledge of a revision is a timing proof (UniverseTimingProof): a seal written
// by the database, bracketing the commit. Decision-time knowledge and contemporaneous vintage are derived from that proof, never from the
// claim. Nothing here accepts a point-in-time claim as proof.

import { hashOf } from '../persistence/canonical-json.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import type { LicenseClass, SourceEnvironment } from '../market-data/market-data-types.js';

export const UNIVERSE_ENGINE_VERSION = 'universe-engine:v2';
/** The vintage policy of the stored revision's claim (migration 010 CHECK). Unchanged: it describes the claim, not NEXUS's knowledge. */
export const UNIVERSE_VINTAGE_POLICY = 'universe-vintage:v1';
/** The policy under which the derived evidence judges NEXUS's proof. */
export const UNIVERSE_VINTAGE_POLICY_V2 = 'universe-vintage:v2';
export const UNIVERSE_EVIDENCE_VERSION = 'universe-evidence:v2';

export class UniverseError extends Error {
  override readonly name = 'UniverseError';
  constructor(
    readonly code:
      | 'UNIVERSE_INVALID'
      | 'UNIVERSE_NOT_FOUND'
      | 'UNIVERSE_CONFLICT'
      | 'UNIVERSE_MEMBER_UNRESOLVED'
      | 'UNIVERSE_DUPLICATE_MEMBER'
      | 'UNIVERSE_KNOWLEDGE_REGRESSION'
      | 'UNIVERSE_SOURCE_REQUIRED'
      | 'UNIVERSE_INTEGRITY_FAILED',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export interface UniverseSource {
  sourceId: string;
  provider: string;
  dataset: string;
  environment: SourceEnvironment;
  license: LicenseClass;
  licenseNote?: string;
}

export interface UniverseDefinition {
  universeId: string;
  definitionVersion: string;
  name: string;
}

export type UniverseCompleteness = 'COMPLETE' | 'PARTIAL';
export type UniverseVintage = 'contemporaneous' | 'historical_reconstruction';
export type UniverseKnowledgeSource = 'captured_by_nexus' | 'provider_published_at';
export type UniverseReplayMode = 'historical_research' | 'decision_time';

/** A clock reading as an ISO UTC instant. Injected into a store; PostgreSQL reads the database clock. */
export type UniverseClock = () => string;

/** One member as the source states it. Its NEXUS instrument is resolved at ingest, never guessed from the symbol alone. */
export interface UniverseMemberInput {
  sourceMemberKey: string;
  providerSymbol: string;
  providerInstrumentId?: string;
  exchange?: string;
}

export interface UniverseSnapshotInput {
  universeId: string;
  sourceId: string;
  /** The source's claim of when the constituent set is in force (economic time). */
  effectiveAt: string;
  /** The source / ingest claim of the retrieval. Provenance only: it proves nothing about NEXUS's possession. */
  retrievedAt: string;
  knowledgeSource: UniverseKnowledgeSource;
  /** The claimed knowledge time: the claimed retrieval for captured data, the provider's stated publication time when it is stated. */
  knownAt: string;
  completeness: UniverseCompleteness;
  members: readonly UniverseMemberInput[];
}

export interface UniverseSnapshotMember {
  instrumentId: string;
  sourceMemberKey: string;
  providerSymbol: string;
  providerInstrumentId: string | null;
}

export interface UnresolvedUniverseMember {
  sourceMemberKey: string;
  providerSymbol: string;
  providerInstrumentId: string | null;
  exchange: string | null;
}

/** One immutable revision of a snapshot key. The row shape of universe_snapshot_revisions (migration 010, unchanged). */
export interface StoredUniverseRevision {
  snapshotKey: string;
  snapshotRevisionId: string;
  universeId: string;
  definitionVersion: string;
  sourceId: string;
  effectiveAt: string;
  retrievedAt: string;
  knowledgeSource: UniverseKnowledgeSource;
  knownAt: string;
  vintage: UniverseVintage;
  vintagePolicy: string;
  completeness: UniverseCompleteness;
  revision: number;
  contentHash: string;
  provenanceHash: string;
  ingestSeq: number;
  memberCount: number;
  members: UniverseSnapshotMember[];
  unresolvedMembers: UnresolvedUniverseMember[];
}

/**
 * NEXUS's own timing proof for one stored revision: the database clock bracketing its commit (COMMIT_SEAL), or a later attestation that
 * the revision was present in the database (PRESENCE_ATTESTATION). recordedAt is read before the commit (a lower bound on it); sealedAt is
 * read after it (an upper bound). Proof that NEXUS held the revision by T is sealedAt <= T. recordedAt alone proves nothing.
 */
export interface UniverseTimingProof {
  snapshotRevisionId: string;
  proofKind: 'COMMIT_SEAL' | 'PRESENCE_ATTESTATION';
  /** hashOf(the stored revision) at the time of sealing. */
  resultHash: string;
  recordedAt: string;
  sealedAt: string;
  sealHash: string;
}

/** Derived evidence (universe-engine:v2). Computed from the selected revision, its timing proof, the mode and asOf. Never accepted from a caller. */
export interface UniverseEvidence {
  evidenceVersion: 'universe-evidence:v2';
  status: 'SELECTED' | 'UNAVAILABLE';
  universeId: string;
  definitionVersion: string;
  sourceId: string;
  /** From the source registry: environment = production. Never from the caller. */
  sourceProduction: boolean;
  snapshotKey: string | null;
  snapshotRevisionId: string | null;
  revision: number | null;
  completeness: UniverseCompleteness | null;
  /** The source states a complete member set. Says nothing about knowledge or time. */
  complete: boolean;
  /** The source's claim of the effective instant. Claimed, not proven. */
  effectiveAt: string | null;
  /** effectiveAt <= asOf (the source's claim). */
  effectiveByAsOf: boolean;
  /** Source / ingest claims, kept as provenance. None of them proves knowledge. */
  claimedKnownAt: string | null;
  claimedRetrievedAt: string | null;
  claimedKnowledgeSource: UniverseKnowledgeSource | null;
  claimedVintage: UniverseVintage | null;
  /** COMMIT_SEALED or PRESENCE_ATTESTED: a stored timing proof exists. UNSEALED: none (legacy, or a commit whose seal was never written). */
  knowledgeProof: 'COMMIT_SEALED' | 'PRESENCE_ATTESTED' | 'UNSEALED' | null;
  storeRecordedAt: string | null;
  storeSealedAt: string | null;
  timingProofHash: string | null;
  /** NEXUS held this exact revision by asOf: a proof exists and storeSealedAt <= asOf. */
  decisionTimeKnowledgeProven: boolean;
  /** NEXUS held this exact revision no later than its effective instant: a proof exists and storeSealedAt <= effectiveAt (policy v2). */
  contemporaneousVintageProven: boolean;
  /** Not strict: the membership is an ex-post reconstruction, or NEXUS did not hold it by asOf. */
  historicalReconstruction: boolean;
  /** Live-grade: complete, production source, decision-time proof, contemporaneous proof. */
  strictDecisionTime: boolean;
  replayMode: UniverseReplayMode;
  asOf: string;
  memberCount: number | null;
  fingerprint: string;
}

/**
 * Universe evidence of universe-engine:v1 (before database-sealed knowledge). Stored runs of that era remain readable. Their knowledge
 * was a caller claim, so they are never strong evidence: consumers treat them as unsealed, whatever their stored flags say.
 */
export interface LegacyUniverseEvidence {
  status: 'SELECTED' | 'UNAVAILABLE';
  universeId: string;
  definitionVersion: string;
  sourceId: string;
  sourceProduction: boolean;
  snapshotKey: string | null;
  snapshotRevisionId: string | null;
  revision: number | null;
  effectiveAt: string | null;
  knownAt: string | null;
  vintage: UniverseVintage | null;
  completeness: UniverseCompleteness | null;
  complete: boolean;
  decisionTimeKnowledgeProven: boolean;
  contemporaneousVintage: boolean;
  historicalReconstruction: boolean;
  strictDecisionTime: boolean;
  replayMode: UniverseReplayMode;
  asOf: string;
  memberCount: number | null;
  fingerprint: string;
}

export type AnyUniverseEvidence = UniverseEvidence | LegacyUniverseEvidence;

export function isUniverseEvidenceV2(e: AnyUniverseEvidence): e is UniverseEvidence {
  return (e as UniverseEvidence).evidenceVersion === UNIVERSE_EVIDENCE_VERSION;
}

/** A selected revision with its timing proof (null when NEXUS has none). */
export interface SelectedRevision {
  revision: StoredUniverseRevision;
  proof: UniverseTimingProof | null;
}

/** A selection as a scanner or a backtest consumes it: the evidence, the selected revision and its proof, and the members (empty when unavailable). */
export interface UniverseSelection {
  evidence: UniverseEvidence;
  revision: StoredUniverseRevision | null;
  timingProof: UniverseTimingProof | null;
  /** Instrument ids of the selected revision, sorted. Empty when no revision was selected. */
  members: string[];
}

function fail(code: UniverseError['code'], message: string): never {
  throw new UniverseError(code, message);
}

const HEX = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL.test(value)) {
    fail('UNIVERSE_INVALID', field + ' must be a non-empty printable string of at most ' + max + ' characters');
  }
  return value;
}

export function instantOf(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('UNIVERSE_INVALID', field + ' must be an ISO instant');
  try {
    return toUtcIso(parseUtc(value));
  } catch (error) {
    fail('UNIVERSE_INVALID', field + ': ' + (error instanceof Error ? error.message : 'invalid instant'));
  }
}

const LICENSE_CLASSES: readonly LicenseClass[] = ['internal_use', 'display_allowed', 'redistributable', 'not_redistributable', 'unreviewed'];

export function assertSource(source: UniverseSource): void {
  text(source.sourceId, 'sourceId', 128);
  text(source.provider, 'provider', 64);
  text(source.dataset, 'dataset', 64);
  if (!['production', 'demo', 'test_fixture'].includes(source.environment)) fail('UNIVERSE_INVALID', 'environment must be production, demo or test_fixture');
  if (!LICENSE_CLASSES.includes(source.license)) fail('UNIVERSE_INVALID', 'license must be a known license class');
  if (source.licenseNote !== undefined) text(source.licenseNote, 'licenseNote', 500);
}

export function assertDefinition(d: UniverseDefinition): void {
  text(d.universeId, 'universeId', 128);
  text(d.definitionVersion, 'definitionVersion', 64);
  text(d.name, 'name', 200);
}

/** The stored shape of a source: only known fields, validated. Both stores hash and compare this shape, never the caller's object. */
export function normalizeSource(source: UniverseSource): UniverseSource {
  assertSource(source);
  return {
    sourceId: source.sourceId,
    provider: source.provider,
    dataset: source.dataset,
    environment: source.environment,
    license: source.license,
    ...(source.licenseNote !== undefined ? { licenseNote: source.licenseNote } : {}),
  };
}

export function normalizeDefinition(d: UniverseDefinition): UniverseDefinition {
  assertDefinition(d);
  return { universeId: d.universeId, definitionVersion: d.definitionVersion, name: d.name };
}

/** Canonical members: sorted by instrumentId; duplicate instruments or source keys are refused. Order of the input never matters. */
export function canonicalMembers(members: readonly UniverseSnapshotMember[]): UniverseSnapshotMember[] {
  const byInstrument = new Set<string>();
  const byKey = new Set<string>();
  for (const m of members) {
    if (byInstrument.has(m.instrumentId)) fail('UNIVERSE_DUPLICATE_MEMBER', 'instrument ' + m.instrumentId + ' appears twice in one snapshot');
    if (byKey.has(m.sourceMemberKey)) fail('UNIVERSE_DUPLICATE_MEMBER', 'source member ' + m.sourceMemberKey + ' appears twice in one snapshot');
    byInstrument.add(m.instrumentId);
    byKey.add(m.sourceMemberKey);
  }
  return [...members].sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
}

export function canonicalUnresolved(list: readonly UnresolvedUniverseMember[]): UnresolvedUniverseMember[] {
  return [...list].sort((a, b) => (a.sourceMemberKey < b.sourceMemberKey ? -1 : a.sourceMemberKey > b.sourceMemberKey ? 1 : 0));
}

/** The identity of a snapshot key: universe, source and the effective instant. Revisions of one key share it. */
export function snapshotKeyOf(universeId: string, sourceId: string, effectiveAt: string): string {
  return 'uk_' + hashOf({ kind: 'universe-snapshot-key:v1', universeId, sourceId, effectiveAt }).slice(0, 40);
}

export function contentHashOf(input: {
  universeId: string;
  definitionVersion: string;
  sourceId: string;
  effectiveAt: string;
  completeness: UniverseCompleteness;
  members: UniverseSnapshotMember[];
  unresolvedMembers: UnresolvedUniverseMember[];
}): string {
  return hashOf({
    contentVersion: 'universe-content:v1',
    universeId: input.universeId,
    definitionVersion: input.definitionVersion,
    sourceId: input.sourceId,
    effectiveAt: input.effectiveAt,
    completeness: input.completeness,
    members: canonicalMembers(input.members),
    unresolvedMembers: canonicalUnresolved(input.unresolvedMembers),
  });
}

export function provenanceHashOf(input: {
  snapshotKey: string;
  revision: number;
  retrievedAt: string;
  knownAt: string;
  knowledgeSource: UniverseKnowledgeSource;
  vintage: UniverseVintage;
  vintagePolicy: string;
  ingestSeq: number;
}): string {
  return hashOf({ contentVersion: 'universe-provenance:v1', ...input });
}

export function revisionIdOf(snapshotKey: string, revision: number, contentHash: string, provenanceHash: string): string {
  return 'urev_' + hashOf({ kind: 'universe-revision-id:v1', snapshotKey, revision, contentHash, provenanceHash }).slice(0, 40);
}

/** The claimed vintage (universe-vintage:v1): the CLAIMED knownAt against the effective instant. Stored as provenance; not proof. */
export function vintageOf(effectiveAt: string, knownAt: string): UniverseVintage {
  return parseUtc(knownAt) <= parseUtc(effectiveAt) ? 'contemporaneous' : 'historical_reconstruction';
}

/** Checks the knowledge shape of a claim: captured data is claimed known exactly at its retrieval; a provider time is never after it. */
export function assertKnowledge(input: { knowledgeSource: UniverseKnowledgeSource; retrievedAt: string; knownAt: string }): void {
  if (input.knowledgeSource === 'captured_by_nexus') {
    if (input.knownAt !== input.retrievedAt) fail('UNIVERSE_INVALID', 'captured knowledge is exactly the retrieval');
  } else if (input.knowledgeSource === 'provider_published_at') {
    if (parseUtc(input.knownAt) > parseUtc(input.retrievedAt)) fail('UNIVERSE_INVALID', 'a provider publication time is not after the retrieval');
  } else {
    fail('UNIVERSE_INVALID', 'unknown knowledge source');
  }
}

/** Canonical timing-proof hash: binds the revision, its result hash and both clock readings. */
export function timingProofHashOf(p: Omit<UniverseTimingProof, 'sealHash'>): string {
  return hashOf({ kind: 'universe-timing-seal:v1', snapshotRevisionId: p.snapshotRevisionId, proofKind: p.proofKind, resultHash: p.resultHash, recordedAt: p.recordedAt, sealedAt: p.sealedAt });
}

/** Builds a timing proof. Clock readings must be canonical (ms precision) and ordered: recordedAt <= sealedAt. */
export function timingProofFor(input: Omit<UniverseTimingProof, 'sealHash'>): UniverseTimingProof {
  if (input.proofKind !== 'COMMIT_SEAL' && input.proofKind !== 'PRESENCE_ATTESTATION') fail('UNIVERSE_INVALID', 'unknown timing proof kind');
  if (!HEX.test(input.resultHash)) fail('UNIVERSE_INVALID', 'timing proof result hash is not a sha-256 digest');
  for (const at of [input.recordedAt, input.sealedAt]) {
    if (!CANONICAL_INSTANT.test(at)) fail('UNIVERSE_INVALID', 'timing proof instant must be ISO UTC with milliseconds: ' + at);
  }
  if (parseUtc(input.recordedAt) > parseUtc(input.sealedAt)) fail('UNIVERSE_INVALID', 'timing proof recordedAt is after sealedAt');
  return { ...input, sealHash: timingProofHashOf(input) };
}

/**
 * Checks a stored timing proof against the revision it claims to seal. A different revision, an altered revision, an altered instant or
 * an altered hash fails here. This does not prove the seal was not rewritten together with the row by a privileged writer (see the doc).
 */
export function assertTimingProof(proof: UniverseTimingProof, revision: StoredUniverseRevision): void {
  if (proof.snapshotRevisionId !== revision.snapshotRevisionId) fail('UNIVERSE_INTEGRITY_FAILED', 'timing proof belongs to another revision');
  if (proof.resultHash !== hashOf(revision)) fail('UNIVERSE_INTEGRITY_FAILED', 'timing proof does not match the stored revision (it was altered after sealing)');
  if (timingProofHashOf(proof) !== proof.sealHash) fail('UNIVERSE_INTEGRITY_FAILED', 'timing proof hash mismatch: its recordedAt, sealedAt or kind was altered');
  for (const at of [proof.recordedAt, proof.sealedAt]) {
    if (!CANONICAL_INSTANT.test(at)) fail('UNIVERSE_INTEGRITY_FAILED', 'timing proof instant is not canonical');
  }
  if (parseUtc(proof.recordedAt) > parseUtc(proof.sealedAt)) fail('UNIVERSE_INTEGRITY_FAILED', 'timing proof recordedAt is after sealedAt');
}

/** A claim cannot describe a retrieval NEXUS had not performed yet: the claimed retrieval is at or before the store time. */
export function assertClaimNotAfterStore(retrievedAt: string, recordedAt: string): void {
  if (parseUtc(retrievedAt) > parseUtc(recordedAt)) {
    fail('UNIVERSE_INVALID', 'the claimed retrieval ' + retrievedAt + ' is after the store time ' + recordedAt + ' (a claim cannot precede its own storage by a later time)');
  }
}

/**
 * Replay selection. decision_time: revisions NEXUS PROVES it held by asOf (a timing proof with sealedAt <= asOf), effective by asOf; the
 * latest effective key, then its latest such revision. historical_research: effective by asOf regardless of proof (the newest ex-post
 * revision, labelled by the evidence). Future-effective revisions are never selected. No fallback to another source.
 */
export function selectRevision(
  revisions: readonly StoredUniverseRevision[],
  q: { sourceId: string; asOf: string; mode: UniverseReplayMode; storedThrough?: number },
  proofOf: (snapshotRevisionId: string) => UniverseTimingProof | null,
): SelectedRevision | null {
  const asOfMs = parseUtc(q.asOf);
  let best: SelectedRevision | null = null;
  for (const r of revisions) {
    if (r.sourceId !== q.sourceId) continue;
    if (q.storedThrough !== undefined && r.ingestSeq > q.storedThrough) continue;
    const effective = parseUtc(r.effectiveAt);
    if (effective > asOfMs) continue;
    const proof = proofOf(r.snapshotRevisionId);
    if (q.mode === 'decision_time' && (proof === null || parseUtc(proof.sealedAt) > asOfMs)) continue;
    if (best === null) {
      best = { revision: r, proof };
      continue;
    }
    const bestEffective = parseUtc(best.revision.effectiveAt);
    if (effective > bestEffective || (effective === bestEffective && r.revision > best.revision.revision)) best = { revision: r, proof };
  }
  return best;
}

function selectedCore(selected: SelectedRevision, asOfMs: number, sourceProduction: boolean): Omit<UniverseEvidence, 'evidenceVersion' | 'universeId' | 'definitionVersion' | 'sourceId' | 'sourceProduction' | 'replayMode' | 'asOf' | 'fingerprint'> {
  const { revision, proof } = selected;
  const proofed = proof !== null;
  const sealedMs = proof === null ? null : parseUtc(proof.sealedAt);
  const decision = sealedMs !== null && sealedMs <= asOfMs;
  const contemporaneous = sealedMs !== null && sealedMs <= parseUtc(revision.effectiveAt);
  const complete = revision.completeness === 'COMPLETE';
  return {
    status: 'SELECTED',
    snapshotKey: revision.snapshotKey,
    snapshotRevisionId: revision.snapshotRevisionId,
    revision: revision.revision,
    completeness: revision.completeness,
    complete,
    effectiveAt: revision.effectiveAt,
    effectiveByAsOf: parseUtc(revision.effectiveAt) <= asOfMs,
    claimedKnownAt: revision.knownAt,
    claimedRetrievedAt: revision.retrievedAt,
    claimedKnowledgeSource: revision.knowledgeSource,
    claimedVintage: revision.vintage,
    knowledgeProof: !proofed ? 'UNSEALED' : proof.proofKind === 'COMMIT_SEAL' ? 'COMMIT_SEALED' : 'PRESENCE_ATTESTED',
    storeRecordedAt: proof === null ? null : proof.recordedAt,
    storeSealedAt: proof === null ? null : proof.sealedAt,
    timingProofHash: proof === null ? null : proof.sealHash,
    decisionTimeKnowledgeProven: decision,
    contemporaneousVintageProven: contemporaneous,
    historicalReconstruction: !contemporaneous || !decision,
    strictDecisionTime: complete && sourceProduction && decision && contemporaneous,
    memberCount: revision.memberCount,
  };
}

/** Derived evidence of a selection (universe-engine:v2). The fingerprint covers every field a consumer may rely on. */
export function evidenceOf(
  selected: SelectedRevision | null,
  q: { universeId: string; definitionVersion: string; sourceId: string; source: UniverseSource | undefined; asOf: string; mode: UniverseReplayMode },
): UniverseEvidence {
  const asOfMs = parseUtc(q.asOf);
  const sourceProduction = q.source?.environment === 'production';
  const base = {
    evidenceVersion: UNIVERSE_EVIDENCE_VERSION,
    universeId: q.universeId,
    definitionVersion: q.definitionVersion,
    sourceId: q.sourceId,
    sourceProduction,
    replayMode: q.mode,
    asOf: q.asOf,
  } as const;
  const core: Omit<UniverseEvidence, 'evidenceVersion' | 'universeId' | 'definitionVersion' | 'sourceId' | 'sourceProduction' | 'replayMode' | 'asOf' | 'fingerprint'> =
    selected === null
      ? {
          status: 'UNAVAILABLE',
          snapshotKey: null,
          snapshotRevisionId: null,
          revision: null,
          completeness: null,
          complete: false,
          effectiveAt: null,
          effectiveByAsOf: false,
          claimedKnownAt: null,
          claimedRetrievedAt: null,
          claimedKnowledgeSource: null,
          claimedVintage: null,
          knowledgeProof: null,
          storeRecordedAt: null,
          storeSealedAt: null,
          timingProofHash: null,
          decisionTimeKnowledgeProven: false,
          contemporaneousVintageProven: false,
          historicalReconstruction: false,
          strictDecisionTime: false,
          memberCount: null,
        }
      : selectedCore(selected, asOfMs, sourceProduction);
  const fields = { ...base, ...core };
  return { ...fields, fingerprint: hashOf({ kind: UNIVERSE_EVIDENCE_VERSION, ...fields }) };
}

/** Members of a selection: the instrument ids of the selected revision, sorted. */
export function selectionOf(selected: SelectedRevision | null, evidence: UniverseEvidence): UniverseSelection {
  return {
    evidence,
    revision: selected === null ? null : selected.revision,
    timingProof: selected === null ? null : selected.proof,
    members: selected === null ? [] : selected.revision.members.map((m) => m.instrumentId).sort(),
  };
}

/**
 * True when evidence is internally consistent: its fingerprint is the hash of its own fields, and every derived boolean follows from the
 * stored facts. An edited object fails this. Legacy (universe-engine:v1) evidence is checked against its own recipe; its flags are never trusted.
 */
export function universeEvidenceIsConsistent(e: AnyUniverseEvidence): boolean {
  if (!isUniverseEvidenceV2(e)) {
    const { fingerprint, ...legacyFields } = e;
    return hashOf({ kind: 'universe-evidence:v1', ...legacyFields }) === fingerprint;
  }
  const { fingerprint, ...fields } = e;
  if (hashOf({ kind: UNIVERSE_EVIDENCE_VERSION, ...fields }) !== fingerprint) return false;
  const asOfMs = parseUtc(e.asOf);
  if (e.status === 'UNAVAILABLE') {
    return (
      !e.complete &&
      !e.decisionTimeKnowledgeProven &&
      !e.contemporaneousVintageProven &&
      !e.historicalReconstruction &&
      !e.strictDecisionTime &&
      e.knowledgeProof === null &&
      e.timingProofHash === null &&
      e.storeSealedAt === null
    );
  }
  if (e.effectiveAt === null || e.completeness === null || e.snapshotRevisionId === null) return false;
  const proofed = e.knowledgeProof === 'COMMIT_SEALED' || e.knowledgeProof === 'PRESENCE_ATTESTED';
  if (!proofed && e.knowledgeProof !== 'UNSEALED') return false;
  if (proofed !== (e.storeSealedAt !== null) || proofed !== (e.timingProofHash !== null)) return false;
  const sealedMs = e.storeSealedAt === null ? null : parseUtc(e.storeSealedAt);
  const decision = sealedMs !== null && sealedMs <= asOfMs;
  const contemporaneous = sealedMs !== null && sealedMs <= parseUtc(e.effectiveAt);
  const complete = e.completeness === 'COMPLETE';
  return (
    e.complete === complete &&
    e.effectiveByAsOf === (parseUtc(e.effectiveAt) <= asOfMs) &&
    e.decisionTimeKnowledgeProven === decision &&
    e.contemporaneousVintageProven === contemporaneous &&
    e.historicalReconstruction === (!contemporaneous || !decision) &&
    e.strictDecisionTime === (complete && e.sourceProduction && decision && contemporaneous)
  );
}

export function assertHex(value: string, field: string): void {
  if (!HEX.test(value)) fail('UNIVERSE_INTEGRITY_FAILED', field + ' is not a sha-256 hex digest');
}

/** Resolves one source member to a permanent NEXUS instrument at the effective instant. null when no mapping proves it. */
export type MemberResolver = (member: UniverseMemberInput, effectiveAt: string, source: UniverseSource) => string | null;

/** What a new ingest is compared with: the revisions that share its snapshot key. */
export type RevisionHead = Pick<StoredUniverseRevision, 'snapshotRevisionId' | 'revision' | 'contentHash' | 'knownAt'>;

/** A validated ingest with its canonical members and identities. Pure: both stores build it the same way. */
export interface PreparedRevision {
  universeId: string;
  definitionVersion: string;
  sourceId: string;
  snapshotKey: string;
  effectiveAt: string;
  retrievedAt: string;
  knowledgeSource: UniverseKnowledgeSource;
  knownAt: string;
  completeness: UniverseCompleteness;
  members: UniverseSnapshotMember[];
  unresolvedMembers: UnresolvedUniverseMember[];
  contentHash: string;
}

export type RevisionPlan = { status: 'ALREADY_APPLIED'; snapshotRevisionId: string } | { status: 'APPLIED'; revision: StoredUniverseRevision };

/**
 * Validates an ingest and resolves its members. recordedAt is the store's own clock reading taken before the commit; the claimed retrieval
 * may not be later than it. A COMPLETE snapshot with an unresolved member is refused here, before anything is stored.
 */
export function prepareRevision(
  input: UniverseSnapshotInput,
  definition: UniverseDefinition | undefined,
  source: UniverseSource | undefined,
  resolve: MemberResolver,
  recordedAt: string,
): PreparedRevision {
  if (!definition) fail('UNIVERSE_NOT_FOUND', 'universe ' + input.universeId + ' is not defined');
  if (!source) fail('UNIVERSE_NOT_FOUND', 'source ' + input.sourceId + ' is not registered');
  if (input.completeness !== 'COMPLETE' && input.completeness !== 'PARTIAL') fail('UNIVERSE_INVALID', 'completeness must be COMPLETE or PARTIAL');
  const effectiveAt = instantOf(input.effectiveAt, 'effectiveAt');
  const retrievedAt = instantOf(input.retrievedAt, 'retrievedAt');
  const knownAt = instantOf(input.knownAt, 'knownAt');
  assertKnowledge({ knowledgeSource: input.knowledgeSource, retrievedAt, knownAt });
  assertClaimNotAfterStore(retrievedAt, recordedAt);

  const members: UniverseSnapshotMember[] = [];
  const unresolved: UnresolvedUniverseMember[] = [];
  for (const m of input.members) {
    text(m.sourceMemberKey, 'sourceMemberKey', 200);
    text(m.providerSymbol, 'providerSymbol', 64);
    const instrumentId = resolve(m, effectiveAt, source);
    if (instrumentId === null) {
      unresolved.push({ sourceMemberKey: m.sourceMemberKey, providerSymbol: m.providerSymbol, providerInstrumentId: m.providerInstrumentId ?? null, exchange: m.exchange ?? null });
    } else {
      members.push({ instrumentId: text(instrumentId, 'instrumentId', 128), sourceMemberKey: m.sourceMemberKey, providerSymbol: m.providerSymbol, providerInstrumentId: m.providerInstrumentId ?? null });
    }
  }
  if (input.completeness === 'COMPLETE' && unresolved.length > 0) {
    fail('UNIVERSE_MEMBER_UNRESOLVED', 'a COMPLETE snapshot has ' + unresolved.length + ' member(s) with no NEXUS instrument (' + unresolved.map((u) => u.sourceMemberKey).join(', ') + '); nothing is stored');
  }
  const canonical = canonicalMembers(members);
  const canonicalGaps = canonicalUnresolved(unresolved);
  return {
    universeId: input.universeId,
    definitionVersion: definition.definitionVersion,
    sourceId: input.sourceId,
    snapshotKey: snapshotKeyOf(input.universeId, input.sourceId, effectiveAt),
    effectiveAt,
    retrievedAt,
    knowledgeSource: input.knowledgeSource,
    knownAt,
    completeness: input.completeness,
    members: canonical,
    unresolvedMembers: canonicalGaps,
    contentHash: contentHashOf({ universeId: input.universeId, definitionVersion: definition.definitionVersion, sourceId: input.sourceId, effectiveAt, completeness: input.completeness, members: canonical, unresolvedMembers: canonicalGaps }),
  };
}

/**
 * Decides what a prepared ingest does against the revisions of its snapshot key. Identical content is idempotent (the first claim and the
 * first proof stand). Different content is the next revision, and its claimed knowledge may not precede the revision it follows.
 */
export function planRevision(prepared: PreparedRevision, existing: readonly RevisionHead[], lastIngestSeq: number): RevisionPlan {
  const same = existing.find((r) => r.contentHash === prepared.contentHash);
  if (same) return { status: 'ALREADY_APPLIED', snapshotRevisionId: same.snapshotRevisionId };
  const last = [...existing].sort((a, b) => a.revision - b.revision).at(-1);
  if (last && parseUtc(prepared.knownAt) < parseUtc(last.knownAt)) {
    fail('UNIVERSE_KNOWLEDGE_REGRESSION', 'a revision claimed known at ' + prepared.knownAt + ' cannot follow revision ' + last.revision + ' claimed known at ' + last.knownAt);
  }
  const revision = (last?.revision ?? 0) + 1;
  const ingestSeq = lastIngestSeq + 1;
  const vintage = vintageOf(prepared.effectiveAt, prepared.knownAt);
  const provenanceHash = provenanceHashOf({ snapshotKey: prepared.snapshotKey, revision, retrievedAt: prepared.retrievedAt, knownAt: prepared.knownAt, knowledgeSource: prepared.knowledgeSource, vintage, vintagePolicy: UNIVERSE_VINTAGE_POLICY, ingestSeq });
  const stored: StoredUniverseRevision = Object.freeze({
    snapshotKey: prepared.snapshotKey,
    snapshotRevisionId: revisionIdOf(prepared.snapshotKey, revision, prepared.contentHash, provenanceHash),
    universeId: prepared.universeId,
    definitionVersion: prepared.definitionVersion,
    sourceId: prepared.sourceId,
    effectiveAt: prepared.effectiveAt,
    retrievedAt: prepared.retrievedAt,
    knowledgeSource: prepared.knowledgeSource,
    knownAt: prepared.knownAt,
    vintage,
    vintagePolicy: UNIVERSE_VINTAGE_POLICY,
    completeness: prepared.completeness,
    revision,
    contentHash: prepared.contentHash,
    provenanceHash,
    ingestSeq,
    memberCount: prepared.members.length,
    members: prepared.members,
    unresolvedMembers: prepared.unresolvedMembers,
  });
  return { status: 'APPLIED', revision: stored };
}

/**
 * Verifies a revision rebuilt from its stored header and child rows against its stored payload and its identities. Any difference is
 * tampering or corruption. The revision is refused, never repaired.
 */
export function assertRevisionIntegrity(rebuilt: StoredUniverseRevision, payload: StoredUniverseRevision): void {
  const id = payload.snapshotRevisionId;
  if (hashOf(rebuilt) !== hashOf(payload)) fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' does not match its header and member rows');
  if (snapshotKeyOf(rebuilt.universeId, rebuilt.sourceId, rebuilt.effectiveAt) !== rebuilt.snapshotKey) fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' has a snapshot key that does not match its identity');
  if (vintageOf(rebuilt.effectiveAt, rebuilt.knownAt) !== rebuilt.vintage) fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' has a vintage that does not follow from its times');
  if (rebuilt.memberCount !== rebuilt.members.length) fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' has a member count that does not match its members');
  const contentHash = contentHashOf({
    universeId: rebuilt.universeId,
    definitionVersion: rebuilt.definitionVersion,
    sourceId: rebuilt.sourceId,
    effectiveAt: rebuilt.effectiveAt,
    completeness: rebuilt.completeness,
    members: rebuilt.members,
    unresolvedMembers: rebuilt.unresolvedMembers,
  });
  if (contentHash !== rebuilt.contentHash) fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' content hash does not match its members');
  const provenanceHash = provenanceHashOf({
    snapshotKey: rebuilt.snapshotKey,
    revision: rebuilt.revision,
    retrievedAt: rebuilt.retrievedAt,
    knownAt: rebuilt.knownAt,
    knowledgeSource: rebuilt.knowledgeSource,
    vintage: rebuilt.vintage,
    vintagePolicy: rebuilt.vintagePolicy,
    ingestSeq: rebuilt.ingestSeq,
  });
  if (provenanceHash !== rebuilt.provenanceHash) fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' provenance hash does not match its header');
  if (revisionIdOf(rebuilt.snapshotKey, rebuilt.revision, rebuilt.contentHash, rebuilt.provenanceHash) !== rebuilt.snapshotRevisionId) {
    fail('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + id + ' identity does not match its content and provenance');
  }
}
