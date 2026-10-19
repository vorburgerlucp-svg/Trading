// O22 B5: the report of the one fixed identity read GET /api/v1/me, reduced to the granted scope names.
//
// The eToro reference (identity and scopes, checked 2026-10-19) documents /me as the first call with a key pair: it returns the
// user's profile and account identifiers (gcid, realCid, demoCid, username, names, date of birth, …) and `scopes`, "the array of
// OAuth scopes actually granted to this connection's token/key". `etoro-public:demo:write` is the demo-account umbrella that includes
// `etoro-public:trade.demo:write`.
//
// Untrusted input, and personal data: the report keeps ONLY the scope names, checked against a strict pattern, and four derived
// checks. No identifier, name, profile field or other key of the response is copied, counted or echoed; a refusal names the failed
// check, never a value. Nothing here releases anything: the build lock still refuses every demo write.

import { BrokerError } from '../broker-errors.js';

export const ME_SCOPES_REPORT_VERSION = 'etoro-me-scopes-observation:v1' as const;
export const ME_ENDPOINT = 'GET /api/v1/me';

/** The scopes that allow demo writes (O21 section 1): the demo umbrella, or the demo trading scope itself. */
export const DEMO_WRITE_SCOPES = Object.freeze(['etoro-public:demo:write', 'etoro-public:trade.demo:write'] as const);
const DEMO_READ_SCOPES = Object.freeze(['etoro-public:demo:read', 'etoro-public:trade.demo:read', ...DEMO_WRITE_SCOPES]);
const REAL_WRITE_SCOPES = Object.freeze(['etoro-public:real:write', 'etoro-public:trade.real:write']);
const REAL_READ_SCOPES = Object.freeze(['etoro-public:real:read', 'etoro-public:trade.real:read', ...REAL_WRITE_SCOPES]);

const SCOPE = /^[a-z][a-z0-9-]{0,40}:[a-z][a-z0-9.-]{0,60}(:[a-z][a-z0-9.-]{0,30})?$/;
const MAX_SCOPES = 64;

export interface MeScopeChecks {
  /** etoro-public:demo:write or etoro-public:trade.demo:write is granted. */
  readonly demoWrite: boolean;
  readonly demoRead: boolean;
  /** A real-account write scope is granted. The O22 cycle never uses it; reported so that a human can decide about the key. */
  readonly realWrite: boolean;
  readonly realRead: boolean;
}

export type MeScopesReport =
  | { readonly schema: typeof ME_SCOPES_REPORT_VERSION; readonly endpoint: string; readonly verdict: 'accepted'; readonly scopes: readonly string[]; readonly checks: MeScopeChecks }
  | { readonly schema: typeof ME_SCOPES_REPORT_VERSION; readonly endpoint: string; readonly verdict: 'refused'; readonly code: string; readonly detail: string };

function invalid(detail: string): BrokerError {
  return new BrokerError('BROKER_RESPONSE_INVALID', detail);
}

/** The granted scope names: an array of strict scope strings, without duplicates in the result, sorted. */
export function parseMeScopes(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('response is not an object');
  const scopes = (body as Record<string, unknown>).scopes;
  if (!Array.isArray(scopes)) throw invalid('scopes is not an array');
  if (scopes.length > MAX_SCOPES) throw invalid('scopes has too many entries');
  for (const s of scopes) if (typeof s !== 'string' || !SCOPE.test(s)) throw invalid('scopes has an entry that is not a scope name');
  return Object.freeze([...new Set(scopes as string[])].sort());
}

export function meScopeChecks(scopes: readonly string[]): MeScopeChecks {
  const any = (set: readonly string[]) => scopes.some((s) => set.includes(s));
  return Object.freeze({ demoWrite: any(DEMO_WRITE_SCOPES), demoRead: any(DEMO_READ_SCOPES), realWrite: any(REAL_WRITE_SCOPES), realRead: any(REAL_READ_SCOPES) });
}

/** The report of one /me read: scope names and checks only. A refusal carries the fixed code and the failed check, never a value. */
export function meScopesReport(body: unknown): MeScopesReport {
  try {
    const scopes = parseMeScopes(body);
    return { schema: ME_SCOPES_REPORT_VERSION, endpoint: ME_ENDPOINT, verdict: 'accepted', scopes, checks: meScopeChecks(scopes) };
  } catch (error) {
    if (error instanceof BrokerError) return { schema: ME_SCOPES_REPORT_VERSION, endpoint: ME_ENDPOINT, verdict: 'refused', code: error.code, detail: error.message };
    return { schema: ME_SCOPES_REPORT_VERSION, endpoint: ME_ENDPOINT, verdict: 'refused', code: 'UNEXPECTED', detail: 'the parser failed unexpectedly' };
  }
}
