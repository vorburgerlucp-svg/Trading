// Runtime configuration (nexus-runtime-config:v1). Fail closed.
//
// The environment is read here, once, at the composition root. Nothing below this file reads process.env.
// There is no configuration key for trading mode, live trading or build locks that could unlock anything:
// TRADING_MODE=live and ALLOW_LIVE_TRADING=true make the start fail, and every other value that is not the exact safe one is refused.
// Error messages never contain a secret or the database URL.

export const RUNTIME_CONFIG_VERSION = 'nexus-runtime-config:v1' as const;

export class RuntimeConfigError extends Error {
  override readonly name = 'RuntimeConfigError';
  constructor(
    readonly code: 'CONFIG_INVALID' | 'LIVE_TRADING_REFUSED',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

export interface RuntimeConfig {
  readonly version: typeof RUNTIME_CONFIG_VERSION;
  readonly host: string;
  readonly port: number;
  /** Server-side only. Never logged, never returned, never part of a URL that leaves the process. */
  readonly databaseUrl: string;
  readonly twelveData: {
    /** Production key, server-side only, sent as a header. Null when not configured. */
    readonly apiKey: string | null;
    /** Twelve Data's public demo key: data is labelled demo and is never usable for trading. */
    readonly demo: boolean;
  };
  readonly tradingMode: 'paper';
  readonly allowLiveTrading: false;
  readonly etoro: {
    /** ETORO_ENABLED=1. Off by default: NEXUS starts and runs without eToro and reports the broker as not connected. */
    readonly enabled: boolean;
    /** The eToro environment. Only 'demo' exists in this build: a real environment is refused at start. */
    readonly tradingMode: 'demo';
    /** Server-side only, sent as a request header. Null unless ETORO_ENABLED=1. Never logged, returned or persisted. */
    readonly apiKey: string | null;
    readonly userKey: string | null;
  };
}

/** The loggable view: every secret is replaced by its state. */
export interface RuntimeConfigSummary {
  host: string;
  port: number;
  tradingMode: 'paper';
  liveTrading: 'locked';
  database: 'configured';
  marketData: 'production' | 'demo' | 'not_configured';
  etoro: 'demo_read_only' | 'not_configured';
}

const API_KEY = /^[A-Za-z0-9]{8,128}$/;
/** An eToro key is bounded and printable, with no space or control character. Its exact format is not assumed. */
const ETORO_KEY = /^[\x21-\x7e]{1,256}$/;
const DATABASE_URL = /^postgres(ql)?:\/\/\S+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function invalid(message: string): never {
  throw new RuntimeConfigError('CONFIG_INVALID', message);
}

function text(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function loadRuntimeConfig(env: Environment): RuntimeConfig {
  const mode = text(env, 'TRADING_MODE');
  if (mode === 'live') {
    throw new RuntimeConfigError('LIVE_TRADING_REFUSED', 'live trading is locked in this build; the runtime refuses to start with TRADING_MODE=live');
  }
  if (mode !== undefined && mode !== 'paper') invalid('TRADING_MODE must be paper');

  const allow = text(env, 'ALLOW_LIVE_TRADING');
  if (allow === 'true') {
    throw new RuntimeConfigError('LIVE_TRADING_REFUSED', 'live trading is locked in this build; the runtime refuses to start with ALLOW_LIVE_TRADING=true');
  }
  if (allow !== undefined && allow !== 'false') invalid('ALLOW_LIVE_TRADING must be false');

  const host = text(env, 'HOST') ?? '127.0.0.1';
  if (host.length > 255 || /\s/.test(host) || !LOOPBACK_HOSTS.has(host)) {
    invalid('HOST must be a loopback address (127.0.0.1, localhost or ::1) until API authentication exists');
  }

  const rawPort = text(env, 'PORT') ?? '3000';
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    invalid('PORT must be an integer between 1 and 65535');
  }

  const databaseUrl = text(env, 'DATABASE_URL');
  if (databaseUrl === undefined) invalid('DATABASE_URL is required; the runtime does not start without PostgreSQL');
  if (!DATABASE_URL.test(databaseUrl)) invalid('DATABASE_URL must be a postgres:// URL');

  const rawKey = text(env, 'TWELVE_DATA_API_KEY');
  if (rawKey !== undefined && !API_KEY.test(rawKey)) invalid('TWELVE_DATA_API_KEY has an invalid format');
  const demo = text(env, 'NEXUS_TWELVE_DATA_DEMO');
  if (demo !== undefined && demo !== '1' && demo !== '0') invalid('NEXUS_TWELVE_DATA_DEMO must be 1 or 0');

  // eToro (O20). A real environment is refused before anything else is read, even when eToro is disabled.
  const etoroMode = text(env, 'ETORO_TRADING_MODE');
  if (etoroMode === 'real') {
    throw new RuntimeConfigError('LIVE_TRADING_REFUSED', 'eToro real trading is not available in this build; the runtime refuses to start with ETORO_TRADING_MODE=real');
  }
  if (etoroMode !== undefined && etoroMode !== 'demo') invalid('ETORO_TRADING_MODE must be demo');
  const etoroEnabledRaw = text(env, 'ETORO_ENABLED');
  if (etoroEnabledRaw !== undefined && etoroEnabledRaw !== '1' && etoroEnabledRaw !== '0') invalid('ETORO_ENABLED must be 1 or 0');
  const etoroEnabled = etoroEnabledRaw === '1';
  const etoroApiKey = text(env, 'ETORO_API_KEY');
  const etoroUserKey = text(env, 'ETORO_USER_KEY');
  if (etoroEnabled) {
    if (etoroApiKey === undefined || etoroUserKey === undefined) invalid('ETORO_API_KEY and ETORO_USER_KEY are required when ETORO_ENABLED=1');
    if (!ETORO_KEY.test(etoroApiKey)) invalid('ETORO_API_KEY has an invalid format');
    if (!ETORO_KEY.test(etoroUserKey)) invalid('ETORO_USER_KEY has an invalid format');
  }

  return Object.freeze({
    version: RUNTIME_CONFIG_VERSION,
    host,
    port,
    databaseUrl,
    twelveData: Object.freeze({
      apiKey: rawKey ?? null,
      // The demo mode is only used when no production key is configured: a production key is never silently replaced.
      demo: rawKey === undefined && demo === '1',
    }),
    tradingMode: 'paper' as const,
    allowLiveTrading: false as const,
    etoro: Object.freeze({
      enabled: etoroEnabled,
      tradingMode: 'demo' as const,
      apiKey: etoroEnabled && etoroApiKey !== undefined ? etoroApiKey : null,
      userKey: etoroEnabled && etoroUserKey !== undefined ? etoroUserKey : null,
    }),
  });
}

export function summarizeRuntimeConfig(config: RuntimeConfig): RuntimeConfigSummary {
  return {
    host: config.host,
    port: config.port,
    tradingMode: 'paper',
    liveTrading: 'locked',
    database: 'configured',
    marketData: config.twelveData.apiKey !== null ? 'production' : config.twelveData.demo ? 'demo' : 'not_configured',
    etoro: config.etoro.enabled ? 'demo_read_only' : 'not_configured',
  };
}
