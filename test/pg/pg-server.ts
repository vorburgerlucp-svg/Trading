// TEST INFRASTRUCTURE ONLY: starts a real, throwaway PostgreSQL server for integration tests.
// It uses the official PostgreSQL binaries shipped in the @embedded-postgres/<platform> package
// (no emulation). Credentials are random per run, live only in memory and are never logged.
// Speed settings (fsync off etc.) are for disposable test data only, never for real databases.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';

export interface PgConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface RunningPostgres {
  connection: PgConnectionInfo;
  version: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Locates the PostgreSQL binaries and copies them to a plain temp directory (works around sandboxed/virtualized app folders). */
function binaries(): string {
  const require = createRequire(import.meta.url);
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const pkg = '@embedded-postgres/' + platform + '-' + process.arch;
  let native: string;
  try {
    // The package only exports dist/index.js; the binaries live next to it in ../native.
    native = join(dirname(require.resolve(pkg)), '..', 'native');
  } catch {
    throw new Error('PostgreSQL binaries for ' + process.platform + '-' + process.arch + ' are not installed (' + pkg + ')');
  }
  const target = join(tmpdir(), 'nexus-pg-bin-' + process.platform + '-' + process.arch);
  const exe = process.platform === 'win32' ? '.exe' : '';
  if (!existsSync(join(target, 'bin', 'postgres' + exe))) cpSync(native, target, { recursive: true });
  return join(target, 'bin');
}

export async function startPostgres(): Promise<RunningPostgres> {
  const bin = binaries();
  const exe = process.platform === 'win32' ? '.exe' : '';
  const root = mkdtempSync(join(tmpdir(), 'nexus-pgdata-'));
  const data = join(root, 'data');
  const user = 'nexus_test';
  const password = randomBytes(24).toString('hex');
  const pwfile = join(root, 'pw');
  writeFileSync(pwfile, password);
  const init = spawnSync(join(bin, 'initdb' + exe), ['-D', data, '-U', user, '--auth=scram-sha-256', '--pwfile=' + pwfile, '-E', 'UTF8', '--locale=C', '--no-sync'], { encoding: 'utf8' });
  rmSync(pwfile, { force: true });
  if (init.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error('initdb failed: ' + (init.error?.message ?? init.stderr.split('\n').slice(-5).join(' ')));
  }

  const port = await freePort();
  // Server output goes to a file, not to pipes: on Windows the postmaster's children inherit pipe
  // handles and would keep this process alive after shutdown.
  const logFile = join(root, 'postgres.log');
  const logFd = openSync(logFile, 'a');
  const server: ChildProcess = spawn(
    join(bin, 'postgres' + exe),
    ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=200'],
    { stdio: ['ignore', logFd, logFd] },
  );
  closeSync(logFd);
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-4000) : '');

  const connection: PgConnectionInfo = { host: '127.0.0.1', port, user, password };
  let version = '';
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ ...connection, database: 'postgres' });
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt > 150 || server.exitCode !== null) {
        server.kill();
        const detail = log();
        rmSync(root, { recursive: true, force: true });
        throw new Error('PostgreSQL did not start: ' + (error instanceof Error ? error.message : String(error)) + '\n' + detail);
      }
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    version = (await client.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? '';
    await client.end();
    break;
  }

  return {
    connection,
    version,
    stop: async () => {
      if (server.exitCode === null) {
        const exited = new Promise((r) => server.once('exit', r));
        // Clean "fast" shutdown through pg_ctl stops the postmaster AND all its backends.
        spawnSync(join(bin, 'pg_ctl' + exe), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '30'], { stdio: 'ignore' });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, 15_000)))]);
        clearTimeout(timer);
        if (server.exitCode === null) server.kill('SIGKILL');
      }
      server.unref();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}
