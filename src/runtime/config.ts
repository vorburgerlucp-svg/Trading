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
}

/** The loggable view: every secret is replaced by its state. */
export interface RuntimeConfigSummary {
  host: string;
  port: number;
  tradingMode: 'paper';
  liveTrading: 'locked';
  database: 'configured';
  marketData: 'production' | 'demo' | 'not_configured';
}

const API_KEY = /^[A-Za-z0-9]{8,128}$/;
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
  };
}
