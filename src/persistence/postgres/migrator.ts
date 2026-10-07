// Versioned SQL migrations (db/migrations/NNN_name.sql). No ORM, no automatic schema sync.
//  - deterministic: files are applied in version order, each in its own transaction
//  - verifiable: the SHA-256 of every applied file is stored; an edited, already-applied migration
//    is a hard error, as is a gap or an applied version missing from the repository
//  - serialized: a session advisory lock prevents two servers from migrating at the same time
//  - safe for financial history: statements that delete or rewrite data or remove protections
//    (DROP TABLE/TRIGGER/FUNCTION, TRUNCATE, DELETE FROM, UPDATE ... SET, ALTER TABLE ... DROP/DISABLE)
//    are refused. Such a change needs an explicit, reviewed process outside the migrator.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../canonical-json.js';
import type { PgPool } from './pool.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const ADVISORY_LOCK_KEY = 4_242_017_001;

const DESTRUCTIVE: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'DROP', pattern: /^\s*DROP\s+(TABLE|SCHEMA|DATABASE|TRIGGER|FUNCTION|VIEW|INDEX|TYPE)\b/im },
  { rule: 'TRUNCATE', pattern: /^\s*TRUNCATE\b/im },
  { rule: 'DELETE', pattern: /^\s*DELETE\s+FROM\b/im },
  { rule: 'UPDATE', pattern: /^\s*UPDATE\s+[a-z_."]+\s+SET\b/im },
  { rule: 'ALTER_DROP', pattern: /^\s*ALTER\s+TABLE\s+[a-z_."]+\s+(DROP|DISABLE\s+TRIGGER|ALTER\s+COLUMN\s+\S+\s+TYPE)\b/im },
];

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new MigrationError('migration file name must match NNN_name.sql: ' + file);
      // Line endings are normalized so the checksum is identical on every platform.
      const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      return { version: Number(match[1]), name: match[2] ?? file, sql, checksum: sha256Hex(sql) };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError('migration versions must be contiguous from 001; found ' + m.version + ' at position ' + (i + 1));
    assertNonDestructive(m);
  });
  return migrations;
}

/**
 * Refuses top-level statements that could silently delete or rewrite financial history or remove its
 * protection. Dollar-quoted function bodies (trigger code) are excluded from this scan; they are part
 * of the reviewed schema and are exercised by the database integration tests.
 */
export function assertNonDestructive(migration: Pick<Migration, 'version' | 'name' | 'sql'>): void {
  const topLevel = migration.sql
    .replace(/--[^\n]*/g, '')
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, '$$$$');
  for (const { rule, pattern } of DESTRUCTIVE) {
    if (pattern.test(topLevel)) throw new MigrationError('migration ' + migration.version + '_' + migration.name + ' contains a destructive statement (' + rule + '); refused');
  }
}

export interface MigrationReport {
  applied: number[];
  alreadyApplied: number[];
}

export async function migrate(pool: PgPool, migrations: readonly Migration[] = loadMigrations()): Promise<MigrationReport> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = (await client.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows;
    verifyApplied(applied, migrations);

    const report: MigrationReport = { applied: [], alreadyApplied: applied.map((a) => a.version) };
    for (const migration of migrations.slice(applied.length)) {
      assertNonDestructive(migration);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, migration.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError('migration ' + migration.version + '_' + migration.name + ' failed and was rolled back: ' + (error instanceof Error ? error.message : String(error)));
      }
      report.applied.push(migration.version);
    }
    return report;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch {
      // connection may be gone; the session lock dies with it
    }
    client.release(failure instanceof MigrationError ? undefined : (failure as Error | undefined));
  }
}

/** Read-only check that the database schema matches the repository's migrations exactly. */
export async function verifyMigrations(pool: PgPool, migrations: readonly Migration[] = loadMigrations()): Promise<{ upToDate: boolean; pending: number[] }> {
  const exists = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
  const applied = exists.rows[0]?.exists ? (await pool.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows : [];
  verifyApplied(applied, migrations);
  const pending = migrations.slice(applied.length).map((m) => m.version);
  return { upToDate: pending.length === 0, pending };
}

function verifyApplied(applied: readonly { version: number; name: string; checksum: string }[], migrations: readonly Migration[]): void {
  applied.forEach((row, i) => {
    const expected = migrations[i];
    if (row.version !== i + 1) throw new MigrationError('schema_migrations has a gap at version ' + (i + 1));
    if (!expected) throw new MigrationError('database has migration ' + row.version + ' that does not exist in the repository');
    if (row.checksum !== expected.checksum) throw new MigrationError('migration ' + row.version + '_' + row.name + ' was modified after it was applied (checksum mismatch)');
  });
}
