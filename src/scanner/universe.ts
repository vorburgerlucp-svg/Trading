import { hashOf } from '../persistence/canonical-json.js';
import { parseUtc } from '../market-data/time.js';

export interface InstrumentUniverse {
  universeId: string;
  version: string;
  source: string;
  pointInTimeSafe: boolean;
}

export interface UniverseMembership {
  universeId: string;
  instrumentId: string;
  validFrom: string;
  validTo?: string;
  /** When NEXUS could first know this membership. */
  availableAt: string;
  source: string;
}

export interface UniverseSnapshot {
  universeId: string;
  version: string;
  asOf: string;
  members: string[];
  pointInTimeSafe: boolean;
  fingerprint: string;
}

export class InMemoryInstrumentUniverseStore {
  private readonly universes = new Map<string, InstrumentUniverse>();
  private readonly memberships: UniverseMembership[] = [];

  register(universe: InstrumentUniverse): void {
    const existing = this.universes.get(universe.universeId);
    if (existing && hashOf(existing) !== hashOf(universe)) throw new Error('universe conflict: ' + universe.universeId);
    this.universes.set(universe.universeId, Object.freeze({ ...universe }));
  }

  addMembership(membership: UniverseMembership): void {
    if (!this.universes.has(membership.universeId)) throw new Error('unknown universe ' + membership.universeId);
    parseUtc(membership.validFrom);
    if (membership.validTo) parseUtc(membership.validTo);
    parseUtc(membership.availableAt);
    this.memberships.push(Object.freeze({ ...membership }));
  }

  snapshot(universeId: string, asOf: string): UniverseSnapshot {
    const universe = this.universes.get(universeId);
    if (!universe) throw new Error('unknown universe ' + universeId);
    const t = parseUtc(asOf);
    const members = [...new Set(this.memberships
      .filter((m) => m.universeId === universeId)
      .filter((m) => parseUtc(m.availableAt) <= t)
      .filter((m) => parseUtc(m.validFrom) <= t && (m.validTo === undefined || t < parseUtc(m.validTo)))
      .map((m) => m.instrumentId))].sort();
    const fingerprint = hashOf({ universe, asOf, members });
    return { universeId, version: universe.version, asOf, members, pointInTimeSafe: universe.pointInTimeSafe, fingerprint };
  }
}
