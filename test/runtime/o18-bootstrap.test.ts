// The runtime start is fail-closed. These cases need no PostgreSQL: each one must stop before a server listens.
import { describe, expect, it } from 'vitest';
import { MigrationError } from '../../src/persistence/postgres/migrator.js';
import { describeFailure, startRuntime } from '../../src/runtime/bootstrap.js';

// Port 1 on loopback has no listener: the database is unreachable and the start must refuse, not wait for a fallback.
const SECRET = 's3cret-o18-password';
const UNREACHABLE = { DATABASE_URL: 'postgres://nexus:' + SECRET + '@127.0.0.1:1/nexus', PORT: '3000' };

describe('O18 runtime start is fail-closed', () => {
  it('refuses TRADING_MODE=live and ALLOW_LIVE_TRADING=true before any database connection is attempted', async () => {
    await expect(startRuntime({ ...UNREACHABLE, TRADING_MODE: 'live' })).rejects.toMatchObject({ code: 'LIVE_TRADING_REFUSED' });
    await expect(startRuntime({ ...UNREACHABLE, ALLOW_LIVE_TRADING: 'true' })).rejects.toMatchObject({ code: 'LIVE_TRADING_REFUSED' });
  });

  it('refuses to start without DATABASE_URL', async () => {
    await expect(startRuntime({ PORT: '3000' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('does not start without a reachable PostgreSQL, and its error never contains the connection secret', async () => {
    const error = await startRuntime(UNREACHABLE).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });
});

describe('O18 startup failure report', () => {
  it('prints the fixed message of a typed error and only the name and code of any other error', () => {
    expect(describeFailure(new MigrationError('migration 3_x was modified after it was applied (checksum mismatch)'))).toContain('checksum mismatch');
    const driver = Object.assign(new Error('password authentication failed for postgres://nexus:' + SECRET + '@db'), { code: '28P01' });
    const report = describeFailure(driver);
    expect(report).toBe('startup failed (Error 28P01)');
    expect(report).not.toContain(SECRET);
  });
});
