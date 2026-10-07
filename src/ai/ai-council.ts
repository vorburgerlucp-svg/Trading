// AI Council: runs the models of one plan step.
//  - every model of a step gets the identical request built BEFORE the step (independence:
//    nobody sees another council member's answer of the same step)
//  - each call has a hard timeout; output must pass the opinion schema
//  - a failed primary is replaced by a fallback, preferring a provider not yet represented
//  - if not enough valid answers remain, the step is reported unsatisfied; NEXUS never fills the gap
//  - shadow models run on the same request; their answers are kept for benchmarking only

import type { CouncilRole, ModelKey } from './model-types.js';
import { InvalidModelOutputError, parseModelOpinion } from './model-types.js';
import { ProviderNotConnectedError, type AdapterMap, type SpecialistRequest } from './model-adapter.js';
import type { ModelRegistry } from './model-registry.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { AttemptRecord, PlanStep } from '../nexus/nexus-types.js';

export class ModelTimeoutError extends Error {
  override readonly name = 'ModelTimeoutError';
}

export interface ConsultInput {
  step: PlanStep;
  primaries: readonly ModelKey[];
  fallbacks: readonly ModelKey[];
  shadow: readonly ModelKey[];
  /** Builds the (identical) request for this step; called once per model with a fresh request id. */
  buildRequest: (requestId: string) => SpecialistRequest;
  timeoutMs: number;
}

export interface ConsultResult {
  successes: AttemptRecord[];
  shadowResults: AttemptRecord[];
  attempts: AttemptRecord[];
  satisfied: boolean;
}

export class AiCouncil {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly adapters: AdapterMap,
    private readonly options: { clock: () => Date; newId: () => string },
  ) {}

  async consult(input: ConsultInput): Promise<ConsultResult> {
    const { step } = input;
    const shadowRuns = Promise.all(input.shadow.map((key) => this.call(key, step.id, step.role, input, true)));
    const first = await Promise.all(input.primaries.map((key) => this.call(key, step.id, step.role, input, false)));

    const attempts = [...first];
    const successes = first.filter((a) => a.status === 'ok');
    const queue = [...input.fallbacks];

    for (const failed of first.filter((a) => a.status !== 'ok')) {
      while (successes.length < step.models && queue.length > 0) {
        const providers = new Set(successes.map((s) => s.provider));
        const index = queue.findIndex((key) => !providers.has(this.providerOf(key)));
        const [next] = queue.splice(index >= 0 ? index : 0, 1);
        if (next === undefined) break;
        const attempt = await this.call(next, step.id, step.role, input, false, failed.modelKey);
        attempts.push(attempt);
        if (attempt.status === 'ok') {
          successes.push(attempt);
          break;
        }
      }
    }

    const shadowResults = await shadowRuns;
    const distinct = new Set(successes.map((s) => s.provider)).size;
    return {
      successes,
      shadowResults,
      attempts: [...attempts, ...shadowResults],
      satisfied: successes.length >= step.models && distinct >= step.minDistinctProviders,
    };
  }

  private async call(key: ModelKey, stepId: string, role: CouncilRole, input: ConsultInput, shadow: boolean, fallbackFor?: ModelKey): Promise<AttemptRecord> {
    const request = input.buildRequest(this.options.newId());
    const adapter = this.adapters.get(key);
    const [provider = key, ...rest] = key.split('/');
    const base = {
      stepId,
      role,
      modelKey: key,
      provider,
      model: rest.join('/'),
      shadow,
      ...(fallbackFor !== undefined ? { fallbackFor } : {}),
      promptId: request.prompt.id,
      promptVersion: request.prompt.version,
      requestHash: hashOf(request),
    };
    const at = () => this.options.clock().toISOString();
    if (!adapter || adapter.connection() !== 'connected') {
      if (!shadow) this.registry.recordFailure(key, { at: at(), kind: 'not_connected' });
      return { ...base, status: 'not_connected', error: 'adapter not connected', latencyMs: 0 };
    }

    const started = Date.now();
    try {
      const raw = await withTimeout(adapter.run(request), input.timeoutMs);
      const latencyMs = Date.now() - started;
      const opinion = parseModelOpinion(raw);
      this.registry.recordSuccess(key, { at: at(), latencyMs });
      return { ...base, status: 'ok', latencyMs, responseHash: hashOf(raw), modelVersion: opinion.modelVersion, opinion };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const status: AttemptRecord['status'] =
        error instanceof ModelTimeoutError
          ? 'timeout'
          : error instanceof InvalidModelOutputError
            ? 'invalid_output'
            : error instanceof ProviderNotConnectedError
              ? 'not_connected'
              : 'failed';
      this.registry.recordFailure(key, { at: at(), kind: status });
      return { ...base, status, error: error instanceof Error ? error.message : String(error), latencyMs };
    }
  }

  private providerOf(key: ModelKey): string {
    return key.split('/')[0] ?? key;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModelTimeoutError('model did not answer within ' + ms + ' ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
