import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from '../../src/persistence/postgres/migrator.js';

// Committed migration history is immutable. Each checksum below is the one a database records when it applies the migration.
// A change to any of these files is a change to committed history and must fail here. See docs/MIGRATION_HISTORY.md.

const PINNED: Readonly<Record<number, string>> = Object.freeze({
  1: 'a314422d97c9eea5363b505e9541799bd10098d013c446307032079ccde3e8a1',
  2: 'f0cb8d654368137ad910219403d4cea8bf6c25b0a69b703294764de42518e2db',
  3: '0c7880adb6d870994f66be82371860c472828780a4c1e2e420ce1a49ceff7da6',
  4: 'c1f6859e4a6f6cd0169a83a01ba614a6f9e33ad96d4ab9cd56e22e6165a126b3',
  5: 'f4b702e97fb0a97c4aca35b7cad324804270923c4e2dafe876dccbe473c1c18d',
  6: '760a9c2745721a67c7f62fe939bf303d0aa8ebef0bf5aca90befbfabf2ada899',
  7: '56d5af140de5c52215834b1d3551e41636c310b8800259fdd7a1d5ddad0a9021',
  /** The 008 released in de4c3f4. Restored byte-for-byte: the database that applied it keeps accepting it. */
  8: 'c8f14c983ead6a38fa14f08f298b3d228690603475e78084c8378a607f36861e',
  9: 'b2812e5e40906c397d914cac6af646d48f89154f8b3356fc2672bd8805cdf5ec',
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGINAL_008 = join(HERE, '..', 'fixtures', 'migrations', '008_market_bar_provenance.de4c3f4.sql');

describe('committed migration history is immutable', () => {
  it('every migration has its pinned checksum (001-008 are immutable; 009 is pinned as released)', () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual(Object.keys(PINNED).map(Number));
    for (const m of migrations) expect(m.checksum, m.version + '_' + m.name).toBe(PINNED[m.version]);
  });

  it('the 008 on disk is byte-identical to the one released in de4c3f4 (the fixture is that release)', () => {
    const onDisk = readFileSync(join(DEFAULT_MIGRATIONS_DIR, '008_market_bar_provenance.sql'));
    const released = readFileSync(ORIGINAL_008);
    expect(onDisk.equals(released)).toBe(true);
  });

  it('the released 008 has the checksum a database that applied it recorded', () => {
    const released = readFileSync(ORIGINAL_008, 'utf8').replace(/\r\n/g, '\n');
    expect(loadMigrations().find((m) => m.version === 8)!.sql).toBe(released);
  });
});
