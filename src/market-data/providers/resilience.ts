// Resilient calls to external providers: timeout, bounded retries with exponential backoff and
// jitter, Retry-After, a client-side request pacer, and a circuit breaker.
//
// Retried: rate limits, timeouts, network errors, 5xx. Never retried: invalid symbol, auth failure,
// missing entitlement, bad request, schema violations (repeating them cannot help and may burn quota).

import { MarketDataError, type MarketDataErrorCode, type ProviderHealthSnapshot } from '../market-data-provider.js';

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponseLike>;

export interface ResiliencePolicy {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Waiting longer than this (e.g. a Retry-After of 10 minutes) is not done inside a call. */
  maxRetryAfterMs: number;
  /** Delay after a rate-limit answer without Retry-After. */
  rateLimitFallbackMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  /** Minimum spacing of requests (client-side pacing of the provider's credit limit). */
  minIntervalMs: number;
}

export const DEFAULT_RESILIENCE: ResiliencePolicy = Object.freeze({
  timeoutMs: 15_000,
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxRetryAfterMs: 65_000,
  rateLimitFallbackMs: 15_000,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 60_000,
  minIntervalMs: 0,
});

export interface ResilienceDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 0 ≤ x < 1, used for jitter. */
  random: () => number;
}

export const REAL_DEPS: ResilienceDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  random: () => Math.random(),
};

/** Retry-After as seconds or HTTP-date → milliseconds (undefined if absent/invalid). */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

export class ResilientCaller {
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastErrorCode: MarketDataErrorCode | undefined;
  private nextAllowedAt = 0;
  readonly policy: ResiliencePolicy;

  constructor(
    readonly provider: string,
    policy: Partial<ResiliencePolicy> = {},
    private readonly deps: ResilienceDeps = REAL_DEPS,
  ) {
    this.policy = { ...DEFAULT_RESILIENCE, ...policy };
  }

  health(): ProviderHealthSnapshot {
    return {
      provider: this.provider,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
      ...(this.openedAt !== null ? { openedAt: new Date(this.openedAt).toISOString() } : {}),
    };
  }

  async call<T>(attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let lastError: MarketDataError | null = null;
    for (let n = 1; n <= this.policy.maxAttempts; n++) {
      this.checkCircuit();
      await this.pace();
      try {
        const result = await this.withTimeout(attempt);
        this.state = 'closed';
        this.consecutiveFailures = 0;
        this.openedAt = null;
        return result;
      } catch (raw) {
        const error = this.classify(raw);
        // Unknown failures (programming errors) are not "transient": never retried, never masked.
        if (!error) throw raw;
        lastError = error;
        this.lastErrorCode = error.code;
        if (!error.retryable) throw error;
        this.consecutiveFailures++;
        if (this.state === 'half_open' || this.consecutiveFailures >= this.policy.circuitFailureThreshold) {
          this.state = 'open';
          this.openedAt = this.deps.now();
          throw error;
        }
        if (n === this.policy.maxAttempts) break;
        const backoff = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (n - 1)) * (0.5 + this.deps.random() * 0.5);
        const delay = error.details.retryAfterMs ?? (error.code === 'rate_limited' ? Math.max(backoff, this.policy.rateLimitFallbackMs) : backoff);
        if (delay > this.policy.maxRetryAfterMs) throw error;
        await this.deps.sleep(delay);
      }
    }
    throw lastError ?? new MarketDataError('provider_unavailable', this.provider, 'no attempt was made');
  }

  private checkCircuit(): void {
    if (this.state !== 'open') return;
    if (this.openedAt !== null && this.deps.now() - this.openedAt >= this.policy.circuitCooldownMs) {
      this.state = 'half_open';
      return;
    }
    throw new MarketDataError('circuit_open', this.provider, 'circuit open after ' + this.consecutiveFailures + ' consecutive transient failures; no request sent');
  }

  private async pace(): Promise<void> {
    if (this.policy.minIntervalMs <= 0) return;
    const wait = this.nextAllowedAt - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait);
    this.nextAllowedAt = this.deps.now() + this.policy.minIntervalMs;
  }

  private async withTimeout<T>(attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new MarketDataError('timeout', this.provider, 'no response within ' + this.policy.timeoutMs + ' ms'));
      }, this.policy.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([attempt(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(error: unknown): MarketDataError | null {
    if (error instanceof MarketDataError) return error;
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return new MarketDataError('timeout', this.provider, 'request aborted');
    // fetch() network failures (DNS, connection reset) surface as TypeError('fetch failed').
    if (error instanceof TypeError && /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(error.message + ' ' + String((error as { cause?: unknown }).cause ?? ''))) {
      return new MarketDataError('provider_unavailable', this.provider, 'network error');
    }
    return null;
  }
}
