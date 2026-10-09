import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { decodeJson, encodeJson, JsonCodecError } from '../../src/persistence/json-codec.js';
import { assertNonDestructive, loadMigrations, MigrationError } from '../../src/persistence/postgres/migrator.js';
import { createPoolFromEnv, DatabaseConfigError } from '../../src/persistence/postgres/pool.js';

describe('Migrationen (ohne Datenbank)', () => {
  it('sind lückenlos versioniert, nicht destruktiv und haben stabile Prüfsummen', () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(migrations.map((m) => m.name)).toEqual(['ledger', 'append_only_logs', 'domain_projections', 'market_data', 'scanner_backtest_core', 'evidence_seals', 'corporate_action_provenance', 'market_bar_provenance']);
    expect(migrations.every((m) => /^[0-9a-f]{64}$/.test(m.checksum))).toBe(true);
    expect(loadMigrations().map((m) => m.checksum)).toEqual(migrations.map((m) => m.checksum));
  });

  it('verweigern Statements, die Finanzhistorie löschen oder Schutz entfernen', () => {
    for (const sql of ['DROP TABLE ledger_lines;', 'TRUNCATE ledger_transactions;', 'DELETE FROM ledger_lines;', 'UPDATE ledger_lines SET amount_minor = 0;', 'ALTER TABLE ledger_lines DROP COLUMN currency;', 'DROP TRIGGER ledger_lines_immutable ON ledger_lines;']) {
      expect(() => assertNonDestructive({ version: 9, name: 'x', sql }), sql).toThrow(MigrationError);
    }
    expect(() => assertNonDestructive({ version: 9, name: 'x', sql: 'CREATE TABLE ok (id INT);\n-- DELETE FROM in a comment is fine' })).not.toThrow();
  });
});

describe('DATABASE_URL', () => {
  it('kommt nur aus der Umgebung und erscheint nie in Fehlermeldungen', () => {
    expect(() => createPoolFromEnv({})).toThrow(DatabaseConfigError);
    expect(() => createPoolFromEnv({})).toThrow(/DATABASE_URL is not set/);
  });
});

describe('JSON-Codec für JSONB', () => {
  it('bigint und Decimal überleben verlustfrei; der Hash bleibt identisch', () => {
    const value = { a: 12345678901234567890n, q: Decimal.from('1.000000000000000001'), list: [1, null, 'x'], nested: { s: 0.1 } };
    const roundTripped = decodeJson(JSON.parse(JSON.stringify(encodeJson(value))));
    expect(roundTripped).toEqual(value);
    expect(hashOf(roundTripped)).toBe(hashOf(value));
  });

  it('verweigert Werte, die PostgreSQL verändern würde, statt sie still zu ändern', () => {
    expect(() => encodeJson({ s: 'a\u0000b' })).toThrow(JsonCodecError);
    expect(() => encodeJson({ n: Number.NaN })).toThrow(JsonCodecError);
    expect(() => encodeJson(new Date(0))).toThrow(JsonCodecError);
    expect(() => encodeJson({ $bigint: '1' })).toThrow(JsonCodecError);
  });
});
