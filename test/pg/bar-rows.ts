// Raw bar revisions for the schema tests. They write what the DATABASE must accept or refuse, so they bypass the application.
// The 008 columns default to the mirror of the V2 knowledge (the persistence rule); a test may override them to break a rule.

import { v1MirrorOf, type V1Mirror } from '../../src/persistence/postgres/bar-compat.js';
import type { BarKnowledgeSource, BarVintage } from '../../src/market-data/market-data-types.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';

/** Format-valid placeholder hash: the database checks the format, the application verifies the value on read. */
export const RAW_HASH = 'c'.repeat(64);

export interface V2Fields {
  source: string | null;
  known: string | null;
  vintage: string | null;
  policy: string | null;
  /** Defaults to RAW_HASH when the V2 model is present. */
  hash?: string | null;
}

export interface RawBar {
  instrument: string;
  source: string;
  interval?: '1d' | '15m';
  start: string;
  end: string;
  revision?: number;
  isFinal?: boolean;
  observed: string;
  available: string;
  retrieved: string;
  v2?: V2Fields | null;
  /** Overrides the 008 knowledge values (default: the mirror of v2). */
  v1?: { provenance: string | null; known: string | null };
  /** Overrides the 008 hash (default: RAW_HASH when the 008 values exist). */
  v1Hash?: string | null;
}

const COLUMNS =
  'instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash, knowledge_provenance, revision_known_at, provenance_hash, knowledge_source_v2, known_at_v2, vintage_v2, vintage_policy_v2, knowledge_vintage_hash';

const SQL = `INSERT INTO market_bars (${COLUMNS}) VALUES ($1, $2, $3, 'regular', 'raw', $4::timestamptz, $5::timestamptz, $6::integer, 250, 250, 250, 250, 1000, $7::boolean, $8::timestamptz, $9::timestamptz, $10::timestamptz, (SELECT COALESCE(MAX(head_seq), 0) + 1 FROM market_data_heads WHERE instrument_id = $1), $11::text, $12::text, $13::timestamptz, $14::text, $15::text, $16::timestamptz, $17::text, $18::text, $19::text)`;

function mirrorOf(v2: V2Fields | null | undefined): V1Mirror | null {
  if (!v2 || v2.source === null || v2.known === null || v2.vintage === null) return null;
  if (v2.source !== 'captured_by_nexus' && v2.source !== 'provider_published_at') return null;
  return v1MirrorOf({ knownAt: v2.known, knowledgeSource: v2.source as BarKnowledgeSource, vintage: v2.vintage as BarVintage, vintagePolicy: v2.policy });
}

export async function putRawBar(pool: PgPool, r: RawBar): Promise<void> {
  const mirror = r.v1 ? { knowledgeProvenance: r.v1.provenance, revisionKnownAt: r.v1.known } : mirrorOf(r.v2);
  const v1Hash = r.v1Hash !== undefined ? r.v1Hash : mirror ? RAW_HASH : null;
  const v2Hash = r.v2 ? (r.v2.hash !== undefined ? r.v2.hash : RAW_HASH) : null;
  await pool.query(SQL, [
    r.instrument,
    r.source,
    r.interval ?? '1d',
    r.start,
    r.end,
    r.revision ?? 1,
    r.isFinal ?? true,
    r.observed,
    r.available,
    r.retrieved,
    RAW_HASH,
    mirror?.knowledgeProvenance ?? null,
    mirror?.revisionKnownAt ?? null,
    v1Hash,
    r.v2?.source ?? null,
    r.v2?.known ?? null,
    r.v2?.vintage ?? null,
    r.v2?.policy ?? null,
    v2Hash,
  ]);
}
