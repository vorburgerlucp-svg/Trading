// Instrument Registry: canonical instrument identities and their provider mappings over time.
//
// A symbol is not an identity. NEXUS instruments have an opaque, permanent instrumentId; provider
// symbols are mappings with a validity window [validFrom, validTo). A ticker change closes the old
// mapping and opens a new one atomically (one event), so the history of the instrument stays intact
// and a backfill across the change asks the provider for the symbol that was valid at the time.
//
// Event-sourced on the hash-chained append-only log: every rule is checked again when the history is
// replayed, so a row written directly into the database cannot create overlapping mappings or change
// attributes that would re-interpret stored history (time zone, currency, asset class).

import { randomUUID } from 'node:crypto';
import type { Actor } from '../opportunities/opportunity-types.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import { ASSET_CLASSES, type Instrument, type ProviderInstrumentMapping } from './market-data-types.js';
import { getCalendar } from './sessions.js';
import { assertTimeZone, parseUtc, toUtcIso } from './time.js';

export type InstrumentChanges = Partial<Pick<Instrument, 'name' | 'symbol' | 'active' | 'tickSize' | 'lotSize' | 'exchange' | 'mic' | 'tradingCalendar'>>;
const CHANGEABLE: readonly (keyof InstrumentChanges)[] = ['name', 'symbol', 'active', 'tickSize', 'lotSize', 'exchange', 'mic', 'tradingCalendar'];

interface EventBase {
  eventId: string;
  at: string;
  by: Actor;
  reason: string;
}

export type InstrumentEvent =
  | (EventBase & { type: 'instrument_registered'; instrument: Instrument })
  | (EventBase & { type: 'instrument_updated'; instrumentId: string; changes: InstrumentChanges })
  | (EventBase & { type: 'mapping_added'; mapping: ProviderInstrumentMapping })
  | (EventBase & { type: 'mapping_closed'; instrumentId: string; provider: string; providerSymbol: string; validFrom: string; validTo: string })
  | (EventBase & { type: 'symbol_changed'; instrumentId: string; provider: string; newProviderSymbol: string; newSymbol: string; effectiveFrom: string; providerInstrumentId?: string; exchange?: string });

export class InstrumentRegistryError extends Error {
  override readonly name = 'InstrumentRegistryError';
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

export class InstrumentRegistryIntegrityError extends Error {
  override readonly name = 'InstrumentRegistryIntegrityError';
  readonly code = 'INSTRUMENT_REGISTRY_INTEGRITY_ERROR' as const;
}

type ChangeInput = { at: string; by: Actor; reason: string };

const CURRENCY = /^[A-Z0-9]{3,10}$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const MIC = /^[A-Z0-9]{4}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL.test(value)) throw new InstrumentRegistryError('invalid', field + ' must be a non-empty printable string of at most ' + max + ' characters');
  return value;
}

function instantOf(value: string, field: string): number {
  try {
    return parseUtc(value);
  } catch (error) {
    throw new InstrumentRegistryError('invalid', field + ': ' + (error as Error).message);
  }
}

function validateAttributes(i: Partial<Instrument>): void {
  if (i.symbol !== undefined) text(i.symbol, 'symbol', 64);
  if (i.name !== undefined) text(i.name, 'name', 200);
  if (i.exchange !== undefined) text(i.exchange, 'exchange', 64);
  if (i.mic !== undefined && !MIC.test(i.mic)) throw new InstrumentRegistryError('invalid', 'mic must be an ISO 10383 code');
  if (i.tickSize !== undefined && (!DECIMAL.test(i.tickSize) || /^0+(\.0+)?$/.test(i.tickSize))) throw new InstrumentRegistryError('invalid', 'tickSize must be a positive decimal string');
  if (i.lotSize !== undefined && (!DECIMAL.test(i.lotSize) || /^0+(\.0+)?$/.test(i.lotSize))) throw new InstrumentRegistryError('invalid', 'lotSize must be a positive decimal string');
  if (i.tradingCalendar !== undefined && !getCalendar(i.tradingCalendar)) throw new InstrumentRegistryError('invalid', 'unknown trading calendar ' + i.tradingCalendar);
  if (i.active !== undefined && typeof i.active !== 'boolean') throw new InstrumentRegistryError('invalid', 'active must be boolean');
}

function validateInstrument(i: Instrument): void {
  text(i.instrumentId, 'instrumentId', 128);
  if (!ASSET_CLASSES.includes(i.assetClass)) throw new InstrumentRegistryError('invalid', 'unknown asset class');
  text(i.symbol, 'symbol', 64);
  if (typeof i.currency !== 'string' || !CURRENCY.test(i.currency)) throw new InstrumentRegistryError('invalid', 'currency must be an upper-case code');
  try {
    assertTimeZone(i.timezone);
  } catch {
    throw new InstrumentRegistryError('invalid', 'timezone must be an IANA zone');
  }
  if (typeof i.active !== 'boolean') throw new InstrumentRegistryError('invalid', 'active must be boolean');
  if (i.allowsNegativePrices !== undefined && typeof i.allowsNegativePrices !== 'boolean') throw new InstrumentRegistryError('invalid', 'allowsNegativePrices must be boolean');
  validateAttributes(i);
}

function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

function windowOf(m: ProviderInstrumentMapping): [number, number] {
  return [parseUtc(m.validFrom), m.validTo === undefined ? Number.POSITIVE_INFINITY : parseUtc(m.validTo)];
}

function symbolKey(provider: string, providerSymbol: string, exchange?: string): string {
  return provider + '|' + providerSymbol.toUpperCase() + '|' + (exchange ?? '').toUpperCase();
}

export class InstrumentRegistry {
  private readonly instruments = new Map<string, Instrument>();
  private readonly mappingList: ProviderInstrumentMapping[] = [];
  private log!: AppendOnlyLog<InstrumentEvent>;

  private constructor(private readonly newId: () => string) {}

  static async open(store: AppendOnlyStore<InstrumentEvent> = new InMemoryAppendOnlyStore(), options: { clock?: () => Date; newId?: () => string } = {}): Promise<InstrumentRegistry> {
    const registry = new InstrumentRegistry(options.newId ?? randomUUID);
    try {
      registry.log = await AppendOnlyLog.open<InstrumentEvent>('instruments', store, {
        ...(options.clock ? { clock: options.clock } : {}),
        onApply: (record) => registry.apply(record.payload),
      });
    } catch (error) {
      if (error instanceof InstrumentRegistryError) throw new InstrumentRegistryIntegrityError('instrument history violates registry rules: ' + error.message);
      throw error;
    }
    return registry;
  }

  async register(input: Omit<Instrument, 'instrumentId'> & { instrumentId?: string }, change: ChangeInput): Promise<Instrument> {
    const instrument: Instrument = { ...input, instrumentId: input.instrumentId ?? 'ins_' + this.newId() };
    await this.emit({ type: 'instrument_registered', eventId: this.newId(), ...this.changeOf(change), instrument });
    return this.require(instrument.instrumentId);
  }

  async update(instrumentId: string, changes: InstrumentChanges, change: ChangeInput): Promise<Instrument> {
    await this.emit({ type: 'instrument_updated', eventId: this.newId(), ...this.changeOf(change), instrumentId, changes });
    return this.require(instrumentId);
  }

  async addMapping(mapping: ProviderInstrumentMapping, change: ChangeInput): Promise<void> {
    await this.emit({ type: 'mapping_added', eventId: this.newId(), ...this.changeOf(change), mapping });
  }

  async closeMapping(ref: { instrumentId: string; provider: string; providerSymbol: string; validFrom: string; validTo: string }, change: ChangeInput): Promise<void> {
    await this.emit({ type: 'mapping_closed', eventId: this.newId(), ...this.changeOf(change), ...ref });
  }

  /** Ticker change: closes the current mapping at effectiveFrom and opens the new one, atomically. */
  async changeSymbol(
    ref: { instrumentId: string; provider: string; newProviderSymbol: string; newSymbol: string; effectiveFrom: string; providerInstrumentId?: string; exchange?: string },
    change: ChangeInput,
  ): Promise<Instrument> {
    await this.emit({ type: 'symbol_changed', eventId: this.newId(), ...this.changeOf(change), ...ref });
    return this.require(ref.instrumentId);
  }

  get(instrumentId: string): Instrument | undefined {
    const i = this.instruments.get(instrumentId);
    return i ? { ...i } : undefined;
  }

  list(): Instrument[] {
    return [...this.instruments.keys()].sort().map((id) => this.get(id)!);
  }

  mappings(instrumentId?: string): ProviderInstrumentMapping[] {
    return this.mappingList.filter((m) => instrumentId === undefined || m.instrumentId === instrumentId).map((m) => ({ ...m }));
  }

  /** NEXUS instrument behind a provider symbol at instant `at`. */
  resolve(provider: string, providerSymbol: string, at: string, exchange?: string): string | null {
    const t = parseUtc(at);
    const key = symbolKey(provider, providerSymbol, exchange);
    const hit = this.mappingList.find((m) => symbolKey(m.provider, m.providerSymbol, m.exchange) === key && windowOf(m)[0] <= t && t < windowOf(m)[1]);
    return hit?.instrumentId ?? null;
  }

  /** Provider symbol of an instrument valid at instant `at`. */
  mappingAt(instrumentId: string, provider: string, at: string): ProviderInstrumentMapping | null {
    const t = parseUtc(at);
    const hit = this.mappingList.find((m) => m.instrumentId === instrumentId && m.provider === provider && windowOf(m)[0] <= t && t < windowOf(m)[1]);
    return hit ? { ...hit } : null;
  }

  /** Mappings of an instrument intersecting [from, to), clipped, in time order (backfill across ticker changes). */
  mappingsOverlapping(instrumentId: string, provider: string, from: string, to: string): Array<{ mapping: ProviderInstrumentMapping; from: string; to: string }> {
    const f = parseUtc(from);
    const t = parseUtc(to);
    return this.mappingList
      .filter((m) => m.instrumentId === instrumentId && m.provider === provider && overlaps(windowOf(m)[0], windowOf(m)[1], f, t))
      .sort((a, b) => windowOf(a)[0] - windowOf(b)[0])
      .map((m) => ({ mapping: { ...m }, from: toUtcIso(Math.max(f, windowOf(m)[0])), to: toUtcIso(Math.min(t, windowOf(m)[1])) }));
  }

  async sync(): Promise<void> {
    try {
      await this.log.sync();
    } catch (error) {
      if (error instanceof InstrumentRegistryError) throw new InstrumentRegistryIntegrityError('instrument history violates registry rules: ' + error.message);
      throw error;
    }
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }

  private changeOf(change: ChangeInput): { at: string; by: Actor; reason: string } {
    return { at: change.at, by: { kind: change.by.kind, id: change.by.id }, reason: change.reason };
  }

  private async emit(event: InstrumentEvent): Promise<void> {
    await this.log.append(event.eventId, event, { precondition: () => this.check(event) });
  }

  private require(instrumentId: string): Instrument {
    const i = this.get(instrumentId);
    if (!i) throw new InstrumentRegistryError('not_found', 'unknown instrument ' + instrumentId);
    return i;
  }

  private checkMappingFree(candidate: ProviderInstrumentMapping, ignore?: ProviderInstrumentMapping): void {
    const [from, to] = windowOf(candidate);
    for (const m of this.mappingList) {
      if (m === ignore) continue;
      const [mf, mt] = windowOf(m);
      if (!overlaps(from, to, mf, mt)) continue;
      if (symbolKey(m.provider, m.providerSymbol, m.exchange) === symbolKey(candidate.provider, candidate.providerSymbol, candidate.exchange)) {
        throw new InstrumentRegistryError('conflict', candidate.provider + ' symbol ' + candidate.providerSymbol + ' is already mapped to ' + m.instrumentId + ' in an overlapping period');
      }
      if (m.instrumentId === candidate.instrumentId && m.provider === candidate.provider) {
        throw new InstrumentRegistryError('conflict', candidate.instrumentId + ' already has a ' + candidate.provider + ' mapping (' + m.providerSymbol + ') in an overlapping period');
      }
    }
  }

  private validateMapping(m: ProviderInstrumentMapping): void {
    if (!this.instruments.has(m.instrumentId)) throw new InstrumentRegistryError('not_found', 'unknown instrument ' + m.instrumentId);
    text(m.provider, 'provider', 64);
    text(m.providerSymbol, 'providerSymbol', 64);
    if (m.providerInstrumentId !== undefined) text(m.providerInstrumentId, 'providerInstrumentId', 128);
    if (m.exchange !== undefined) text(m.exchange, 'exchange', 64);
    const from = instantOf(m.validFrom, 'validFrom');
    if (m.validTo !== undefined && instantOf(m.validTo, 'validTo') <= from) throw new InstrumentRegistryError('invalid', 'validTo must be after validFrom');
  }

  /** Throws if the event would violate a rule. Pure: no state change. */
  private check(e: InstrumentEvent): void {
    text(e.eventId, 'eventId', 128);
    instantOf(e.at, 'at');
    if (!e.by || (e.by.kind !== 'human' && e.by.kind !== 'system')) throw new InstrumentRegistryError('invalid', 'registry changes need a human or system actor');
    text(e.reason, 'reason', 500);
    switch (e.type) {
      case 'instrument_registered':
        validateInstrument(e.instrument);
        if (this.instruments.has(e.instrument.instrumentId)) throw new InstrumentRegistryError('conflict', 'instrument ' + e.instrument.instrumentId + ' already exists');
        return;
      case 'instrument_updated': {
        if (!this.instruments.has(e.instrumentId)) throw new InstrumentRegistryError('not_found', 'unknown instrument ' + e.instrumentId);
        const keys = Object.keys(e.changes);
        if (keys.length === 0) throw new InstrumentRegistryError('invalid', 'no changes');
        for (const k of keys) {
          if (!CHANGEABLE.includes(k as keyof InstrumentChanges)) throw new InstrumentRegistryError('invalid', k + ' cannot be changed (it would re-interpret stored history); register a new instrument instead');
        }
        validateAttributes(e.changes);
        return;
      }
      case 'mapping_added':
        this.validateMapping(e.mapping);
        this.checkMappingFree(e.mapping);
        return;
      case 'mapping_closed': {
        const target = this.findMapping(e.instrumentId, e.provider, e.providerSymbol, e.validFrom);
        if (target.validTo !== undefined) throw new InstrumentRegistryError('conflict', 'mapping is already closed');
        if (instantOf(e.validTo, 'validTo') <= parseUtc(target.validFrom)) throw new InstrumentRegistryError('invalid', 'validTo must be after validFrom');
        return;
      }
      case 'symbol_changed': {
        text(e.newSymbol, 'newSymbol', 64);
        const effective = instantOf(e.effectiveFrom, 'effectiveFrom');
        const current = this.mappingList.find((m) => m.instrumentId === e.instrumentId && m.provider === e.provider && m.validTo === undefined);
        if (!current) throw new InstrumentRegistryError('not_found', 'no open ' + e.provider + ' mapping for ' + e.instrumentId);
        if (effective <= parseUtc(current.validFrom)) throw new InstrumentRegistryError('invalid', 'effectiveFrom must be after the current mapping started');
        const next = this.nextMappingOf(e);
        this.validateMapping(next);
        this.checkMappingFree(next, current);
        return;
      }
    }
  }

  private nextMappingOf(e: Extract<InstrumentEvent, { type: 'symbol_changed' }>): ProviderInstrumentMapping {
    return {
      instrumentId: e.instrumentId,
      provider: e.provider,
      providerSymbol: e.newProviderSymbol,
      validFrom: toUtcIso(parseUtc(e.effectiveFrom)),
      ...(e.providerInstrumentId !== undefined ? { providerInstrumentId: e.providerInstrumentId } : {}),
      ...(e.exchange !== undefined ? { exchange: e.exchange } : {}),
    };
  }

  private findMapping(instrumentId: string, provider: string, providerSymbol: string, validFrom: string): ProviderInstrumentMapping {
    const from = instantOf(validFrom, 'validFrom');
    const target = this.mappingList.find((m) => m.instrumentId === instrumentId && m.provider === provider && m.providerSymbol === providerSymbol && parseUtc(m.validFrom) === from);
    if (!target) throw new InstrumentRegistryError('not_found', 'no such mapping');
    return target;
  }

  private apply(e: InstrumentEvent): void {
    this.check(e);
    switch (e.type) {
      case 'instrument_registered':
        this.instruments.set(e.instrument.instrumentId, { ...e.instrument });
        return;
      case 'instrument_updated':
        this.instruments.set(e.instrumentId, { ...this.instruments.get(e.instrumentId)!, ...e.changes });
        return;
      case 'mapping_added':
        this.mappingList.push({ ...e.mapping, validFrom: toUtcIso(parseUtc(e.mapping.validFrom)), ...(e.mapping.validTo !== undefined ? { validTo: toUtcIso(parseUtc(e.mapping.validTo)) } : {}) });
        return;
      case 'mapping_closed':
        this.findMapping(e.instrumentId, e.provider, e.providerSymbol, e.validFrom).validTo = toUtcIso(parseUtc(e.validTo));
        return;
      case 'symbol_changed': {
        const current = this.mappingList.find((m) => m.instrumentId === e.instrumentId && m.provider === e.provider && m.validTo === undefined)!;
        current.validTo = toUtcIso(parseUtc(e.effectiveFrom));
        this.mappingList.push(this.nextMappingOf(e));
        this.instruments.set(e.instrumentId, { ...this.instruments.get(e.instrumentId)!, symbol: e.newSymbol });
        return;
      }
    }
  }
}
