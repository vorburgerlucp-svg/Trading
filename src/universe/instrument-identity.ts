// Instrument identity for universe members: the permanent NEXUS instrument behind a provider symbol at the effective instant, read from the
// InstrumentRegistry. The ticker is never the identity: a symbol means something only at the instant it was mapped, and the instrument's
// current `active` flag is never read for historical membership.

import type { InstrumentRegistry } from '../market-data/instrument-registry.js';
import type { MemberResolver } from './universe-model.js';

export function registryResolver(registry: InstrumentRegistry): MemberResolver {
  return (member, effectiveAt, source) => registry.resolve(source.provider, member.providerSymbol, effectiveAt, member.exchange);
}
