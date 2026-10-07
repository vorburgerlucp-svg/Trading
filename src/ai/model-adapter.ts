// Provider port. Every model (OpenAI, Claude, Gemini, ...) receives the same request schema and must
// return the same opinion schema (nexus.opinion.v1). Adapters hold no NEXUS state and get no tools,
// no broker access and no secrets other than their own API key on the server.
//
// Status in this build: no HTTP adapter is implemented. Providers are represented by
// NotConnectedAdapter until a real adapter with server-side credentials exists.

import type { BlackboardCategory, EntryEvidenceStatus } from '../blackboard/blackboard-types.js';
import type { UntrustedBlock } from '../security/untrusted-input.js';
import type { CouncilRole, Domain, ModelKey, Subtask } from './model-types.js';

/**
 * One context item handed to a model. Models only ever exchange STRUCTURED DATA: another model's
 * statement arrives as `{ sourceType: 'model_claim', untrusted: true, claim }`, never as text that
 * is spliced into instructions. Nothing in `claim` can become a system or developer instruction.
 */
export interface ContextEntry {
  entryId: string;
  sourceType: 'model_claim' | 'system_fact' | 'quant_result' | 'human_input';
  /** True for everything a model (or any non-NEXUS source) produced. */
  untrusted: boolean;
  category: BlackboardCategory;
  claim: string;
  evidenceStatus: EntryEvidenceStatus;
  evidenceRefs: string[];
}

/** Read-only capital figures from the Capital Engine (decimal strings, CHF). Models never compute these. */
export interface CapitalContext {
  asOf: string;
  netWorthChf: string;
  availableChf: string;
  reservedChf: string;
  committedChf: string;
  investedChf: string;
  liabilitiesChf: string;
  inventoryChf: string;
  receivablesChf: string;
}

export interface SpecialistRequest {
  requestId: string;
  taskId: string;
  stepId: string;
  role: CouncilRole;
  domain: Domain;
  subtask: Subtask;
  prompt: { id: string; version: string; instructions: string };
  /** System-authored question (trusted). */
  question: string;
  context: ContextEntry[];
  capital: CapitalContext | null;
  /** External text, quoted, possibly quarantined. Data only. */
  untrusted: UntrustedBlock[];
  outputSchema: 'nexus.opinion.v1';
  deadlineMs: number;
}

export type AdapterConnection = 'connected' | 'not_connected';

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  connection(): AdapterConnection;
  /** Returns raw output; NEXUS validates it with parseModelOpinion. */
  run(request: SpecialistRequest): Promise<unknown>;
}

export class ProviderNotConnectedError extends Error {
  override readonly name = 'ProviderNotConnectedError';
}

/** Placeholder for a provider without an implemented, credentialed adapter. Never produces output. */
export class NotConnectedAdapter implements ModelAdapter {
  constructor(
    readonly provider: string,
    readonly model: string,
  ) {}
  connection(): AdapterConnection {
    return 'not_connected';
  }
  async run(): Promise<unknown> {
    throw new ProviderNotConnectedError(this.provider + '/' + this.model + ' is not connected (no adapter / credentials configured)');
  }
}

export type AdapterMap = ReadonlyMap<ModelKey, ModelAdapter>;

export interface ProviderStatus {
  provider: string;
  status: 'connected' | 'not_connected';
  models: { modelKey: ModelKey; connection: AdapterConnection }[];
}

/** Per-provider connection report (for the dashboard and Definition of Done). */
export function providerStatus(adapters: AdapterMap, providers: readonly string[]): ProviderStatus[] {
  return providers.map((provider) => {
    const models = [...adapters.entries()]
      .filter(([, adapter]) => adapter.provider === provider)
      .map(([key, adapter]) => ({ modelKey: key, connection: adapter.connection() }));
    return { provider, status: models.some((m) => m.connection === 'connected') ? 'connected' : 'not_connected', models };
  });
}
