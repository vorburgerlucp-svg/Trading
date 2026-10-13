// Runs the shared contract suites against PostgreSQL. Every connect() opens a separate connection
// pool on the same database, i.e. a separate NEXUS server process as far as the database can tell.

import { describe } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { PostgresLedgerStore } from '../../src/persistence/postgres/postgres-ledger-store.js';
import { auditProjector, championProjector, evidenceProjector, memoryProjector, registryProjector } from '../../src/persistence/postgres/projectors.js';
import { ledgerStoreContract } from '../contracts/ledger-store.contract.js';
import { logStoresContract } from '../contracts/log-stores.contract.js';
import { createTestDatabase, pgAvailable, pgSkipReason } from './db.js';

describe.skipIf(!pgAvailable)('PostgreSQL contracts' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  ledgerStoreContract('PostgresLedgerStore', async () => {
    const db = await createTestDatabase();
    return {
      connect: () => PostgresLedgerStore.open(db.extraPool(), { ledgerId: 'main' }),
      cleanup: () => db.drop(),
    };
  });

  logStoresContract('PostgresAppendOnlyStore', async () => {
    const db = await createTestDatabase();
    return {
      generic: (name) => PostgresAppendOnlyStore.open(db.extraPool(), name),
      audit: () => PostgresAppendOnlyStore.open(db.extraPool(), 'audit', { projector: auditProjector }),
      registry: () => PostgresAppendOnlyStore.open(db.extraPool(), 'model-registry', { projector: registryProjector }),
      champions: () => PostgresAppendOnlyStore.open(db.extraPool(), 'champions', { projector: championProjector }),
      memory: () => PostgresAppendOnlyStore.open(db.extraPool(), 'memory', { projector: memoryProjector }),
      evidence: () => PostgresAppendOnlyStore.open(db.extraPool(), 'evidence', { projector: evidenceProjector }),
      cleanup: () => db.drop(),
    };
  });
});
