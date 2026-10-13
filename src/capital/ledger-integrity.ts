// Ledger integrity: structural rules, full-history verification, checkpoints, fail-closed error.
//
// The hash chain is TAMPER-EVIDENT, not tamper-proof: an attacker with full write access to the
// database could rewrite history AND recompute every hash consistently. Checkpoints (sequence + hash)
// kept in separate storage (later: signed, external) make such a full rewrite detectable, because the
// rewritten chain no longer matches a previously recorded checkpoint.

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { GENESIS_HASH } from '../persistence/append-only-log.js';
import { parseAccountKey } from './accounts.js';
import { CAPITAL_TRANSACTION_TYPES, type EntryRefs, type JournalEntry, type JournalEntryDraft, type Posting } from './capital-types.js';

export const BASE_LEDGER_CURRENCY = 'CHF';

export type IntegrityIssueCode =
  | 'SEQUENCE_GAP'
  | 'BROKEN_CHAIN'
  | 'HASH_MISMATCH'
  | 'DUPLICATE_ID'
  | 'UNBALANCED'
  | 'INVALID_STRUCTURE'
  | 'UNSUPPORTED_CURRENCY'
  | 'INCOMPLETE_TRANSACTION'
  | 'INVALID_REVERSAL'
  | 'CHECKPOINT_MISMATCH'
  | 'LEDGER_BEHIND_CHECKPOINT';

export interface IntegrityIssue {
  code: IntegrityIssueCode;
  sequence?: number;
  message: string;
}

export interface IntegrityReport {
  ok: boolean;
  entries: number;
  headSequence: number;
  headHash: string;
  issues: IntegrityIssue[];
}

/** Raised when financial history cannot be trusted. Callers must fail closed (no capital decisions). */
export class FinancialIntegrityError extends Error {
  override readonly name = 'FinancialIntegrityError';
  readonly code = 'FINANCIAL_INTEGRITY_ERROR' as const;
  constructor(
    readonly issues: readonly IntegrityIssue[],
    context = 'ledger',
  ) {
    super('FINANCIAL_INTEGRITY_ERROR (' + context + '): ' + issues.map((i) => i.code + (i.sequence !== undefined ? '@' + i.sequence : '') + ' ' + i.message).join('; '));
  }
}

/** Structural rules of a single entry, independent of history. Shared by ledger, stores and verification. */
export function structuralIssues(entry: Pick<JournalEntry, 'id' | 'type' | 'description' | 'postings'>, allowedCurrencies: readonly string[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const add = (code: IntegrityIssueCode, message: string) => issues.push({ code, message: 'entry "' + entry.id + '": ' + message });
  if (typeof entry.id !== 'string' || entry.id.trim() === '') add('INVALID_STRUCTURE', 'id is required');
  if (!CAPITAL_TRANSACTION_TYPES.includes(entry.type)) add('INVALID_STRUCTURE', 'unknown type "' + entry.type + '"');
  if (typeof entry.description !== 'string' || entry.description.trim() === '') add('INVALID_STRUCTURE', 'description is required');
  if (entry.postings.length < 2) add('INCOMPLETE_TRANSACTION', 'needs at least two postings');

  const sums = new Map<string, bigint>();
  for (const posting of entry.postings) {
    const currency = posting.currency ?? BASE_LEDGER_CURRENCY;
    if (!allowedCurrencies.includes(currency)) add('UNSUPPORTED_CURRENCY', 'currency ' + currency + ' is not enabled for this ledger (no implicit conversion)');
    if (typeof posting.amount !== 'bigint') {
      add('INVALID_STRUCTURE', 'amount must be bigint minor units on ' + posting.account);
      continue;
    }
    let holdsQuantity = false;
    try {
      const info = parseAccountKey(posting.account);
      holdsQuantity = info.kind === 'position' || info.kind === 'inventory';
    } catch (error) {
      add('INVALID_STRUCTURE', error instanceof Error ? error.message : String(error));
    }
    if (holdsQuantity && posting.quantity === undefined) add('INVALID_STRUCTURE', 'posting to ' + posting.account + ' needs a quantity');
    if (!holdsQuantity && posting.quantity !== undefined) add('INVALID_STRUCTURE', 'posting to ' + posting.account + ' must not carry a quantity');
    if (posting.amount === 0n && (posting.quantity === undefined || posting.quantity.isZero())) add('INVALID_STRUCTURE', 'empty posting to ' + posting.account);
    sums.set(currency, (sums.get(currency) ?? 0n) + posting.amount);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0n) add('UNBALANCED', 'unbalanced by ' + sum + ' minor units of ' + currency);
  }
  return issues;
}

/** Full verification of a ledger history: sequence, chain, hashes, structure, balance, currencies, reversals, checkpoint. */
export function verifyLedgerEntries(
  entries: readonly JournalEntry[],
  options: { allowedCurrencies: readonly string[]; checkpoint?: LedgerCheckpoint | null },
): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const ids = new Set<string>();
  const types = new Map<string, JournalEntry['type']>();
  const reversed = new Set<string>();
  let prevHash = GENESIS_HASH;

  entries.forEach((entry, index) => {
    const sequence = index + 1;
    if (entry.sequence !== sequence) issues.push({ code: 'SEQUENCE_GAP', sequence: entry.sequence, message: 'expected sequence ' + sequence });
    if (entry.prevHash !== prevHash) issues.push({ code: 'BROKEN_CHAIN', sequence: entry.sequence, message: 'prevHash does not match the previous entry' });
    if (computeEntryHash(entry) !== entry.hash) issues.push({ code: 'HASH_MISMATCH', sequence: entry.sequence, message: 'content does not match its hash' });
    if (ids.has(entry.id)) issues.push({ code: 'DUPLICATE_ID', sequence: entry.sequence, message: 'duplicate id ' + entry.id });
    for (const issue of structuralIssues(entry, options.allowedCurrencies)) issues.push({ ...issue, sequence: entry.sequence });
    if (entry.type === 'reversal') {
      const target = entry.refs.reversesEntryId;
      if (target === undefined || !ids.has(target) || types.get(target) === 'reversal' || reversed.has(target)) {
        issues.push({ code: 'INVALID_REVERSAL', sequence: entry.sequence, message: 'reversal of ' + target + ' is not valid at this point' });
      }
      if (target !== undefined) reversed.add(target);
    }
    ids.add(entry.id);
    types.set(entry.id, entry.type);
    prevHash = entry.hash;
  });

  const headSequence = entries.length;
  const headHash = entries.at(-1)?.hash ?? GENESIS_HASH;
  const cp = options.checkpoint;
  if (cp) {
    if (cp.sequence > headSequence) {
      issues.push({ code: 'LEDGER_BEHIND_CHECKPOINT', sequence: cp.sequence, message: 'ledger has ' + headSequence + ' entries but a checkpoint exists for sequence ' + cp.sequence + ' (history truncated?)' });
    } else if (cp.sequence > 0 && entries[cp.sequence - 1]?.hash !== cp.hash) {
      issues.push({ code: 'CHECKPOINT_MISMATCH', sequence: cp.sequence, message: 'entry hash differs from the recorded checkpoint (history rewritten?)' });
    }
  }
  return { ok: issues.length === 0, entries: entries.length, headSequence, headHash, issues };
}

/** SHA-256 over a canonical JSON form (sorted keys, bigint/Decimal as strings) of everything except the hash. */
export function computeEntryHash(entry: Omit<JournalEntry, 'hash'>): string {
  const { sequence, id, occurredAt, recordedAt, type, description, postings, refs, source, requestFingerprint, prevHash } = entry;
  return hashOf({ sequence, id, occurredAt, recordedAt, type, description, postings, refs, source, requestFingerprint, prevHash });
}

/** Fingerprint of a plain draft (normalized), used when no command fingerprint is supplied. */
export function draftFingerprint(draft: JournalEntryDraft): string {
  return hashOf({
    id: draft.id,
    occurredAt: normalizeTimestamp(draft.occurredAt),
    type: draft.type,
    description: draft.description,
    postings: draft.postings.map(normalizePosting),
    refs: stripUndefined(draft.refs ?? {}),
    source: draft.source ?? 'engine',
  });
}

export function normalizePosting(posting: Posting): Posting {
  const currency = posting.currency === undefined || posting.currency === BASE_LEDGER_CURRENCY ? undefined : posting.currency;
  return {
    account: posting.account,
    amount: posting.amount,
    ...(posting.quantity !== undefined ? { quantity: Decimal.from(posting.quantity) } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}

export function normalizeTimestamp(value: string): string {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw new Error('not a valid ISO timestamp: "' + value + '"');
  return new Date(millis).toISOString();
}

export function stripUndefined(refs: EntryRefs): EntryRefs {
  return Object.fromEntries(Object.entries(refs).filter(([, v]) => v !== undefined)) as EntryRefs;
}

/**
 * Startup / health check of a stored ledger without opening it: sequence, chain, hashes, zero-sum,
 * completeness, currencies, reversals and the latest checkpoint. Never throws for integrity problems;
 * returns them so a health endpoint can report FINANCIAL_INTEGRITY_ERROR. CapitalLedger.open runs the
 * same verification and refuses to open (fail closed).
 */
export async function verifyStoredLedger(
  store: { ledgerId: string; allowedCurrencies: readonly string[]; loadAll(): Promise<readonly JournalEntry[]> },
  checkpoints?: LedgerCheckpointStore,
): Promise<IntegrityReport> {
  let entries: readonly JournalEntry[];
  try {
    entries = await store.loadAll();
  } catch (error) {
    if (error instanceof FinancialIntegrityError) return { ok: false, entries: 0, headSequence: 0, headHash: GENESIS_HASH, issues: [...error.issues] };
    throw error;
  }
  const checkpoint = checkpoints ? await checkpoints.getLatestCheckpoint(store.ledgerId) : null;
  return verifyLedgerEntries(entries, { allowedCurrencies: store.allowedCurrencies, checkpoint });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface LedgerCheckpoint {
  ledgerId: string;
  sequence: number;
  hash: string;
  createdAt: string;
  /** Reserved for signed checkpoints (e.g. HMAC/KMS signature). Null until signing exists. */
  signature: string | null;
}

/**
 * Checkpoints belong in storage that is SEPARATE from the ledger database (and later signed), so a
 * complete rewrite of the ledger cannot also rewrite the checkpoints.
 */
export interface LedgerCheckpointStore {
  saveCheckpoint(checkpoint: LedgerCheckpoint): Promise<void>;
  getLatestCheckpoint(ledgerId: string): Promise<LedgerCheckpoint | null>;
}

export class InMemoryLedgerCheckpointStore implements LedgerCheckpointStore {
  private readonly checkpoints = new Map<string, LedgerCheckpoint[]>();

  async saveCheckpoint(checkpoint: LedgerCheckpoint): Promise<void> {
    const list = this.checkpoints.get(checkpoint.ledgerId) ?? [];
    const latest = list.at(-1);
    if (latest && checkpoint.sequence < latest.sequence) throw new Error('checkpoints must not go backwards');
    list.push(Object.freeze({ ...checkpoint }));
    this.checkpoints.set(checkpoint.ledgerId, list);
  }

  async getLatestCheckpoint(ledgerId: string): Promise<LedgerCheckpoint | null> {
    return this.checkpoints.get(ledgerId)?.at(-1) ?? null;
  }
}
