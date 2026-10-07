// Runs the shared contract suites against the in-memory reference stores.

import { InMemoryLedgerStore } from '../../src/capital/ledger-store.js';
import { InMemoryAppendOnlyStore, type AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { ledgerStoreContract } from '../contracts/ledger-store.contract.js';
import { logStoresContract } from '../contracts/log-stores.contract.js';

ledgerStoreContract('InMemoryLedgerStore', async () => {
  const store = new InMemoryLedgerStore('main');
  return { connect: async () => store, cleanup: async () => undefined };
});

logStoresContract('InMemoryAppendOnlyStore', async () => {
  const stores = new Map<string, AppendOnlyStore<unknown>>();
  const named = <T>(name: string): AppendOnlyStore<T> => {
    if (!stores.has(name)) stores.set(name, new InMemoryAppendOnlyStore<unknown>());
    return stores.get(name) as AppendOnlyStore<T>;
  };
  return {
    generic: async <T>(name: string) => named<T>('generic:' + name),
    audit: async () => named('audit'),
    registry: async () => named('model-registry'),
    champions: async () => named('champions'),
    memory: async () => named('memory'),
    evidence: async () => named('evidence'),
    cleanup: async () => undefined,
  };
});
