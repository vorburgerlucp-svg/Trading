// R1: at most one research worker. The lock is a PostgreSQL session-level advisory lock on a dedicated connection: it is held
// exactly as long as that connection lives, so a crashed or killed worker releases it automatically, and a second process
// (another scheduled start, a manual start) is refused instead of running in parallel.

import type { PgClient, PgPool } from '../persistence/postgres/pool.js';

/** Advisory lock key of the research worker (two 32-bit keys: "NXRS", worker 1). Distinct from every other NEXUS lock. */
export const RESEARCH_WORKER_LOCK_KEY = [0x4e585253, 1] as const;

export interface WorkerLockHandle {
  /** Throws when the lock may have been lost (its connection is gone). Called between instruments. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface WorkerLock {
  /** The lock, or null when another worker holds it. Never waits. */
  tryAcquire(): Promise<WorkerLockHandle | null>;
}

export class WorkerLockLostError extends Error {
  override readonly name = 'WorkerLockLostError';
}

export class PostgresWorkerLock implements WorkerLock {
  constructor(private readonly pool: PgPool) {}

  async tryAcquire(): Promise<WorkerLockHandle | null> {
    const client: PgClient = await this.pool.connect();
    let lost = false;
    client.on('error', () => {
      lost = true;
    });
    try {
      const row = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [...RESEARCH_WORKER_LOCK_KEY])).rows[0];
      if (row?.ok !== true) {
        client.release();
        return null;
      }
    } catch (error) {
      client.release(true);
      throw error;
    }
    let released = false;
    return {
      assertHeld: async () => {
        if (released || lost) throw new WorkerLockLostError('research worker lock is not held');
        try {
          await client.query('SELECT 1');
        } catch {
          lost = true;
          throw new WorkerLockLostError('research worker lock connection is gone');
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          if (!lost) await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [...RESEARCH_WORKER_LOCK_KEY]);
          client.release();
        } catch {
          // Destroying the connection ends the session, which releases a session-level advisory lock.
          client.release(true);
        }
      },
    };
  }
}

/** TEST AND IN-MEMORY USE: the same contract within one process. */
export class InMemoryWorkerLock implements WorkerLock {
  private held = false;

  async tryAcquire(): Promise<WorkerLockHandle | null> {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return {
      assertHeld: async () => {
        if (released) throw new WorkerLockLostError('research worker lock is not held');
      },
      release: async () => {
        if (released) return;
        released = true;
        this.held = false;
      },
    };
  }
}
