// Point-in-Time Universe V1 (universe-engine:v1): the model, the canonical identities, the replay selection and the derived evidence.
// Pure functions only: the in-memory and PostgreSQL stores share them, so they cannot disagree. See docs/PIT_UNIVERSE_V1.md.
//
// A universe revision is an immutable COMPLETE (or explicitly PARTIAL) constituent snapshot. Two axes are kept apart: effectiveAt
// (when the constituent set is in force) and knownAt (when NEXUS could know this exact revision). The replay mode decides which revisions
// may be used; the evidence is derived from the selected revision, the mode and asOf. Nothing here accepts a point-in-time claim.

import { hashOf } from '../persistence/canonical-json.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import type { LicenseClass, SourceEnvironment } from '../market-data/market-data-types.js';

export const UNIVERSE_ENGINE_VERSION = 'universe-engine:v1';
export const UNIVERSE_VINTAGE_POLICY = 'universe-vintage:v1';

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
  effectiveAt: string;
  retrievedAt: string;
  knowledgeSource: UniverseKnowledgeSource;
  /** The knowledge time: the retrieval for captured data, the provider's publication time only when it is stated. */
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

/** One immutable revision of a snapshot key. The row shape of universe_snapshot_revisions. */
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

/** Derived evidence. Computed from the selected revision, the replay mode and asOf. Never accepted from a caller. */
export interface UniverseEvidence {
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
  /** The source states a complete member set. Says nothing about knowledge or time. */
  complete: boolean;
  /** NEXUS held this revision at asOf. */
  decisionTimeKnowledgeProven: boolean;
  contemporaneousVintage: boolean;
  /** Not strict: the membership was reconstructed, or NEXUS learned it after asOf. */
  historicalReconstruction: boolean;
  /** Live-grade: complete, from a production source, known at asOf, and contemporaneous. */
  strictDecisionTime: boolean;
  replayMode: UniverseReplayMode;
  asOf: string;
  memberCount: number | null;
  fingerprint: string;
}

/** A selection as a scanner or a backtest consumes it: the evidence, and the members of the selected revision (empty when unavailable). */
export interface UniverseSelection {
  evidence: UniverseEvidence;
  revision: StoredUniverseRevision | null;
  /** Instrument ids of the selected revision, sorted. Empty when no revision was selected. */
  members: string[];
}

function fail(code: UniverseError['code'], message: string): never {
  throw new UniverseError(code, message);
}

const HEX = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

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

/** Vintage under universe-vintage:v1: contemporaneous iff NEXUS held the revision no later than its effective instant. */
export function vintageOf(effectiveAt: string, knownAt: string): UniverseVintage {
  return parseUtc(knownAt) <= parseUtc(effectiveAt) ? 'contemporaneous' : 'historical_reconstruction';
}

/** Checks the knowledge shape of an input: captured data is known exactly at its retrieval; a provider time is never after it. */
export function assertKnowledge(input: { knowledgeSource: UniverseKnowledgeSource; retrievedAt: string; knownAt: string }): void {
  if (input.knowledgeSource === 'captured_by_nexus') {
    if (input.knownAt !== input.retrievedAt) fail('UNIVERSE_INVALID', 'captured knowledge is exactly the retrieval');
  } else if (input.knowledgeSource === 'provider_published_at') {
    if (parseUtc(input.knownAt) > parseUtc(input.retrievedAt)) fail('UNIVERSE_INVALID', 'a provider publication time is not after the retrieval');
  } else {
    fail('UNIVERSE_INVALID', 'unknown knowledge source');
  }
}

/**
 * Replay selection. decision_time: revisions NEXUS held by asOf, effective by asOf; the latest effective key, then its latest known
 * revision. historical_research: the same, without the knowledge gate (the newest ex-post revision, labelled by the evidence).
 * Future-effective revisions are never selected. No fallback to another source.
 */
export function selectRevision(
  revisions: readonly StoredUniverseRevision[],
  q: { sourceId: string; asOf: string; mode: UniverseReplayMode; storedThrough?: number },
): StoredUniverseRevision | null {
  const asOfMs = parseUtc(q.asOf);
  let best: StoredUniverseRevision | null = null;
  for (const r of revisions) {
    if (r.sourceId !== q.sourceId) continue;
    if (q.storedThrough !== undefined && r.ingestSeq > q.storedThrough) continue;
    const effective = parseUtc(r.effectiveAt);
    if (effective > asOfMs) continue;
    if (q.mode === 'decision_time' && parseUtc(r.knownAt) > asOfMs) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const bestEffective = parseUtc(best.effectiveAt);
    if (effective > bestEffective || (effective === bestEffective && r.revision > best.revision)) best = r;
  }
  return best;
}

/** Derived evidence of a selection. The fingerprint covers every field a consumer may rely on. */
export function evidenceOf(
  revision: StoredUniverseRevision | null,
  q: { universeId: string; definitionVersion: string; sourceId: string; source: UniverseSource | undefined; asOf: string; mode: UniverseReplayMode },
): UniverseEvidence {
  const asOfMs = parseUtc(q.asOf);
  const sourceProduction = q.source?.environment === 'production';
  const base = {
    universeId: q.universeId,
    definitionVersion: q.definitionVersion,
    sourceId: q.sourceId,
    sourceProduction,
    replayMode: q.mode,
    asOf: q.asOf,
  };
  const core =
    revision === null
      ? {
          status: 'UNAVAILABLE' as const,
          snapshotKey: null,
          snapshotRevisionId: null,
          revision: null,
          effectiveAt: null,
          knownAt: null,
          vintage: null,
          completeness: null,
          complete: false,
          decisionTimeKnowledgeProven: false,
          contemporaneousVintage: false,
          historicalReconstruction: false,
          strictDecisionTime: false,
          memberCount: null,
        }
      : (() => {
          const known = parseUtc(revision.knownAt) <= asOfMs;
          const contemporaneous = revision.vintage === 'contemporaneous';
          const complete = revision.completeness === 'COMPLETE';
          return {
            status: 'SELECTED' as const,
            snapshotKey: revision.snapshotKey,
            snapshotRevisionId: revision.snapshotRevisionId,
            revision: revision.revision,
            effectiveAt: revision.effectiveAt,
            knownAt: revision.knownAt,
            vintage: revision.vintage,
            completeness: revision.completeness,
            complete,
            decisionTimeKnowledgeProven: known,
            contemporaneousVintage: contemporaneous,
            historicalReconstruction: !contemporaneous || !known,
            strictDecisionTime: complete && sourceProduction && known && contemporaneous,
            memberCount: revision.memberCount,
          };
        })();
  return { ...base, ...core, fingerprint: hashOf({ kind: 'universe-evidence:v1', ...base, ...core }) };
}

/** Members of a selection: the instrument ids of the selected revision, sorted. */
export function selectionOf(revision: StoredUniverseRevision | null, evidence: UniverseEvidence): UniverseSelection {
  return {
    evidence,
    revision,
    members: revision === null ? [] : revision.members.map((m) => m.instrumentId).sort(),
  };
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
 * Validates an ingest and resolves its members. A COMPLETE snapshot with an unresolved member is refused here, before anything is stored
 * (silent loss is forbidden). The universe and the source must already be registered.
 */
export function prepareRevision(
  input: UniverseSnapshotInput,
  definition: UniverseDefinition | undefined,
  source: UniverseSource | undefined,
  resolve: MemberResolver,
): PreparedRevision {
  if (!definition) fail('UNIVERSE_NOT_FOUND', 'universe ' + input.universeId + ' is not defined');
  if (!source) fail('UNIVERSE_NOT_FOUND', 'source ' + input.sourceId + ' is not registered');
  if (input.completeness !== 'COMPLETE' && input.completeness !== 'PARTIAL') fail('UNIVERSE_INVALID', 'completeness must be COMPLETE or PARTIAL');
  const effectiveAt = instantOf(input.effectiveAt, 'effectiveAt');
  const retrievedAt = instantOf(input.retrievedAt, 'retrievedAt');
  const knownAt = instantOf(input.knownAt, 'knownAt');
  assertKnowledge({ knowledgeSource: input.knowledgeSource, retrievedAt, knownAt });

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
 * Decides what a prepared ingest does against the revisions of its snapshot key. Identical content is idempotent (the first knowledge
 * stands). Different content is the next revision, and it may not be learned before the revision it follows. Nothing is overwritten.
 */
export function planRevision(prepared: PreparedRevision, existing: readonly RevisionHead[], lastIngestSeq: number): RevisionPlan {
  const same = existing.find((r) => r.contentHash === prepared.contentHash);
  if (same) return { status: 'ALREADY_APPLIED', snapshotRevisionId: same.snapshotRevisionId };
  const last = [...existing].sort((a, b) => a.revision - b.revision).at(-1);
  if (last && parseUtc(prepared.knownAt) < parseUtc(last.knownAt)) {
    fail('UNIVERSE_KNOWLEDGE_REGRESSION', 'a revision learned at ' + prepared.knownAt + ' cannot follow revision ' + last.revision + ' learned at ' + last.knownAt);
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

/** True when the fingerprint is the hash of the evidence's own fields. An evidence object edited after derivation fails this. */
export function evidenceFingerprintMatches(evidence: UniverseEvidence): boolean {
  const { fingerprint, ...fields } = evidence;
  return hashOf({ kind: 'universe-evidence:v1', ...fields }) === fingerprint;
}
