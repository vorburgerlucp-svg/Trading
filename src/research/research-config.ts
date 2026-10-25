// R1 research configuration. The research instance reads its environment here, once, and nowhere else. It is deliberately not
// the runtime configuration (src/runtime/config.ts): the research instance has no broker, no operator control plane and no
// trading mode, and it refuses to start when any of their variables is present, so a production environment can never be
// reused for it by mistake. Fail closed: every unknown or out-of-range value is a refusal, never a silent default.

/** The only environment file the research entry points read (never .env, the runtime's file). */
export const RESEARCH_ENV_FILE = '.env.research';

export class ResearchConfigError extends Error {
  override readonly name = 'ResearchConfigError';
  constructor(
    readonly code: 'RESEARCH_CONFIG_INVALID' | 'RESEARCH_FORBIDDEN_VARIABLE' | 'RESEARCH_DATABASE_REFUSED',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Variables that belong to the broker, the trading mode, the operator control plane or the production database. Their presence
 * means the process got the wrong environment. Only their names are ever reported, never their values.
 */
const FORBIDDEN_VARIABLES: readonly RegExp[] = [
  /^ETORO_/i,
  /BROKER/i,
  /^NEXUS_OPERATOR_/i,
  /^TRADING_MODE$/i,
  /^ALLOW_LIVE_TRADING$/i,
  /^DATABASE_URL$/i,
  /^NEXUS_TWELVE_DATA_DEMO$/i,
];

/** Twelve Data Basic plan limits (checked 2026-10-25, see docs/R1_RESEARCH_MVP.md). The research budget may never exceed them. */
export const PLAN_DAILY_CREDITS = 800;
export const PLAN_MINUTE_CREDITS = 8;

/** The only database names the research instance connects to: nexus_research, or a suffixed copy (e.g. a restore test). */
const RESEARCH_DATABASE = /^nexus_research(_[a-z0-9]{1,32})?$/;
/** Roles of the productive NEXUS database and the superuser; the research instance never connects as one of them. */
const REFUSED_ROLES = new Set(['postgres', 'nexus_app', 'nexus_readonly']);

export interface ResearchBudget {
  /** Credits per UTC day. */
  dailyCredits: number;
  /** Credits per rolling minute. */
  minuteCredits: number;
}

export interface ResearchConfig {
  databaseUrl: string;
  /** Database and role, for messages (never the password). */
  database: { name: string; user: string; host: string };
  twelveDataApiKey: string;
  catalogFile: string;
  /**
   * Reference of the documented human decision that Twelve Data's terms allow storing this data for this use (who, when, what was
   * checked). Absent: the instance fetches nothing and records LICENSE_NOT_CLEARED.
   */
  dataClearance: string | null;
  budget: ResearchBudget;
  maxRunMs: number;
  minFreeMemoryMb: number;
  maxCatchUpMs: number;
  codeVersion: string;
}

export const DEFAULT_RESEARCH_LIMITS = Object.freeze({
  dailyCredits: 400,
  minuteCredits: 6,
  maxRunSeconds: 240,
  minFreeMemoryMb: 2048,
  maxCatchUpHours: 24,
});

function text(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function invalid(message: string): never {
  throw new ResearchConfigError('RESEARCH_CONFIG_INVALID', message);
}

function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,7}$/.test(raw)) invalid(name + ' must be a whole number');
  const value = Number(raw);
  if (value < min || value > max) invalid(name + ' must be between ' + min + ' and ' + max);
  return value;
}

/** The names (never values) of forbidden variables present in the environment. */
export function forbiddenVariablesIn(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && env[name] !== '' && FORBIDDEN_VARIABLES.some((pattern) => pattern.test(name)))
    .sort();
}

/** Parses the research database URL and refuses every database and role that is not the research one. */
export function researchDatabaseOf(url: string): { name: string; user: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResearchConfigError('RESEARCH_DATABASE_REFUSED', 'NEXUS_RESEARCH_DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new ResearchConfigError('RESEARCH_DATABASE_REFUSED', 'NEXUS_RESEARCH_DATABASE_URL must be a postgres URL');
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(parsed.username);
  if (!RESEARCH_DATABASE.test(name)) throw new ResearchConfigError('RESEARCH_DATABASE_REFUSED', 'the research instance only connects to the database nexus_research (got another database name)');
  if (user === '' || REFUSED_ROLES.has(user.toLowerCase()) || !user.startsWith('nexus_research')) {
    throw new ResearchConfigError('RESEARCH_DATABASE_REFUSED', 'the research instance only connects as a nexus_research role');
  }
  if (parsed.searchParams.has('options')) throw new ResearchConfigError('RESEARCH_DATABASE_REFUSED', 'connection options in the URL are not allowed');
  return { name, user, host: parsed.hostname };
}

function refuseForbidden(env: Readonly<Record<string, string | undefined>>): void {
  const forbidden = forbiddenVariablesIn(env);
  if (forbidden.length > 0) {
    throw new ResearchConfigError('RESEARCH_FORBIDDEN_VARIABLE', 'the research instance refuses to start with broker, trading or production variables set: ' + forbidden.join(', '));
  }
}

/** Only the research database (for research:migrate and research:status): the same refusals, no provider key needed. */
export function loadResearchDatabaseConfig(env: Readonly<Record<string, string | undefined>>): Pick<ResearchConfig, 'databaseUrl' | 'database'> {
  refuseForbidden(env);
  const databaseUrl = text(env, 'NEXUS_RESEARCH_DATABASE_URL') ?? invalid('NEXUS_RESEARCH_DATABASE_URL is not set');
  return { databaseUrl, database: researchDatabaseOf(databaseUrl) };
}

export function loadResearchConfig(env: Readonly<Record<string, string | undefined>>): ResearchConfig {
  const { databaseUrl, database } = loadResearchDatabaseConfig(env);
  const twelveDataApiKey = text(env, 'TWELVE_DATA_API_KEY') ?? invalid('TWELVE_DATA_API_KEY is not set');
  if (!/^[\x21-\x7e]{1,256}$/.test(twelveDataApiKey) || twelveDataApiKey === 'demo') invalid('TWELVE_DATA_API_KEY is malformed (the public demo key is not a research source)');
  const catalogFile = text(env, 'NEXUS_RESEARCH_CATALOG_FILE') ?? invalid('NEXUS_RESEARCH_CATALOG_FILE is not set');
  const clearance = text(env, 'NEXUS_RESEARCH_DATA_CLEARANCE');
  if (clearance !== undefined && !/^[\x20-\x7e]{8,200}$/.test(clearance)) invalid('NEXUS_RESEARCH_DATA_CLEARANCE must be 8 to 200 printable characters');
  const codeVersion = text(env, 'NEXUS_RESEARCH_CODE_VERSION') ?? 'unversioned';
  if (!/^(unversioned|[0-9a-f]{7,40})$/.test(codeVersion)) invalid('NEXUS_RESEARCH_CODE_VERSION must be a git commit id');
  return {
    databaseUrl,
    database,
    twelveDataApiKey,
    catalogFile,
    dataClearance: clearance ?? null,
    budget: {
      dailyCredits: integer(env, 'NEXUS_RESEARCH_DAILY_CREDIT_LIMIT', DEFAULT_RESEARCH_LIMITS.dailyCredits, 1, PLAN_DAILY_CREDITS),
      minuteCredits: integer(env, 'NEXUS_RESEARCH_MINUTE_CREDIT_LIMIT', DEFAULT_RESEARCH_LIMITS.minuteCredits, 1, PLAN_MINUTE_CREDITS),
    },
    maxRunMs: integer(env, 'NEXUS_RESEARCH_MAX_RUN_SECONDS', DEFAULT_RESEARCH_LIMITS.maxRunSeconds, 30, 600) * 1000,
    minFreeMemoryMb: integer(env, 'NEXUS_RESEARCH_MIN_FREE_MEMORY_MB', DEFAULT_RESEARCH_LIMITS.minFreeMemoryMb, 512, 65_536),
    maxCatchUpMs: integer(env, 'NEXUS_RESEARCH_MAX_CATCH_UP_HOURS', DEFAULT_RESEARCH_LIMITS.maxCatchUpHours, 1, 72) * 3_600_000,
    codeVersion,
  };
}
