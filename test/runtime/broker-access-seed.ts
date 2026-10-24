// O22 Plan B review R3, TEST ONLY: since every demo open needs the newest stored snapshot to have been read with the configured broker
// access, a runtime test that expects an open to pass the gate first stores one stamped, empty read. It goes through its own fixture
// transport, so the test's read-only transport (and its call count) is untouched. No network.
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { EtoroBrokerService } from '../../src/broker/etoro/etoro-broker-service.js';
import { EtoroBrokerSyncAdapter } from '../../src/broker/etoro/etoro-sync-adapter.js';
import type { AccessVerifier } from '../../src/broker/etoro/etoro-access-fingerprint.js';
import type { ComposeInput } from '../../src/runtime/compose.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';

export async function seedStampedSync(etoro: NonNullable<ComposeInput['etoro']>, clock: () => Date, access: AccessVerifier): Promise<void> {
  const seed = new EtoroBrokerService({
    adapter: new EtoroBrokerSyncAdapter({ transport: new FixtureEtoroTransport(), clock }),
    ledger: await CapitalLedger.inMemory(),
    snapshots: etoro.snapshots,
    reconciliations: etoro.reconciliations,
    syncs: etoro.syncs,
    clock,
    access,
  });
  await seed.sync();
}
