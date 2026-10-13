import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import type { MemoryRecord, MemoryRecordInput, RecallQuery } from './memory-types.js';

export class MemoryError extends Error {
  override readonly name = 'MemoryError';
}

/** Append-only, hash-chained, point-in-time structured memory. */
export class NexusMemory {
  private constructor(private readonly log: AppendOnlyLog<MemoryRecordInput>) {}

  static async open(store: AppendOnlyStore<MemoryRecordInput> = new InMemoryAppendOnlyStore(), options: { clock?: () => Date } = {}): Promise<NexusMemory> {
    return new NexusMemory(await AppendOnlyLog.open('memory', store, options));
  }

  async remember<C>(input: MemoryRecordInput<C>): Promise<MemoryRecord<C>> {
    const occurred = Date.parse(input.occurredAt);
    const available = Date.parse(input.availableAt);
    if (Number.isNaN(occurred) || Number.isNaN(available)) throw new MemoryError('occurredAt and availableAt must be ISO timestamps');
    if (available < occurred) throw new MemoryError('availableAt cannot be before occurredAt');
    if (input.subject.trim() === '' || input.source.trim() === '') throw new MemoryError('subject and source are required');
    if (input.supersedes !== undefined && !this.log.get(input.supersedes)) throw new MemoryError('cannot supersede unknown record "' + input.supersedes + '"');
    const { record } = await this.log.append(input.id, { ...input, tags: [...input.tags] });
    return { ...(record.payload as MemoryRecordInput<C>), recordedAt: record.recordedAt };
  }

  /** Records known at `asOf`, oldest first; records superseded by a correction known at `asOf` are hidden. */
  recall<C = unknown>(query: RecallQuery): MemoryRecord<C>[] {
    const asOfMs = Date.parse(query.asOf);
    if (Number.isNaN(asOfMs)) throw new MemoryError('asOf must be an ISO timestamp');
    const storedThrough = query.storedThrough ?? Number.POSITIVE_INFINITY;
    const visible = this.log.all().filter((r) => Date.parse(r.payload.availableAt) <= asOfMs && r.sequence <= storedThrough);
    const superseded = new Set(visible.map((r) => r.payload.supersedes).filter((id): id is string => id !== undefined));
    const result = visible
      .filter((r) => r.payload.kind === query.kind && !superseded.has(r.id))
      .filter((r) => query.subject === undefined || r.payload.subject === query.subject)
      .filter((r) => (query.tags ?? []).every((t) => r.payload.tags.includes(t)))
      .map((r) => ({ ...(r.payload as MemoryRecordInput<C>), recordedAt: r.recordedAt }));
    return query.limit === undefined ? result : result.slice(-query.limit);
  }

  /** Number of records stored so far (the memory log position); records never move. */
  get position(): number {
    return this.log.all().length;
  }

  get<C = unknown>(id: string): MemoryRecord<C> | undefined {
    const record = this.log.get(id);
    return record ? { ...(record.payload as MemoryRecordInput<C>), recordedAt: record.recordedAt } : undefined;
  }

  /** Catches up with records written by other NEXUS processes (verified). */
  sync(): Promise<void> {
    return this.log.sync();
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }
}
