// Runtime configuration (nexus-runtime-config:v1). Fail closed.
//
// The environment is read here, once, at the composition root. Nothing below this file reads process.env.
// There is no configuration key for trading mode, live trading or build locks that could unlock anything:
// TRADING_MODE=live and ALLOW_LIVE_TRADING=true make the start fail, and every other value that is not the exact safe one is refused.
// Error messages never contain a secret or the database URL.

import { isValidEtoroKey } from '../broker/etoro/etoro-credentials.js';
import { ACCESS_KEY_ID, ACCESS_KEY_SECRET } from '../broker/etoro/etoro-access-fingerprint.js';

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
  /**
   * The local operator of the O21 control plane (NEXUS_OPERATOR_ID, NEXUS_OPERATOR_TOKEN), or null. Without it every mutating demo
   * intent route is refused. The token is server-side only: never logged, returned or persisted.
   */
  readonly operator: { readonly id: string; readonly token: string } | null;
  /**
   * O22 Plan B review R3: the NEXUS key of the broker access fingerprint (HMAC-SHA256; etoro-access-fingerprint.ts), managed separately
   * from the broker keys: NEXUS_BROKER_ACCESS_KEY_ID / NEXUS_BROKER_ACCESS_KEY, and during a rotation the previous pair
   * NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID / NEXUS_BROKER_ACCESS_PREVIOUS_KEY. No default. Without it, no demo open or close passes the
   * gate. Server-side only: never logged, returned or persisted (only the key ids appear in stored stamps).
   */
  readonly brokerAccess: { readonly current: { readonly id: string; readonly secret: string } | null; readonly previous: { readonly id: string; readonly secret: string } | null };
  readonly etoroDemoExecution: {
    /**
     * ETORO_DEMO_EXECUTION_ENABLED=1 (O21). Off by default. It needs ETORO_ENABLED=1 and ETORO_TRADING_MODE=demo, and it does not
     * open the build lock BUILD_LOCKS.etoroDemoExecution: with the lock closed, every demo broker write is still refused.
     */
    readonly enabled: boolean;
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
  etoroDemoExecution: 'enabled' | 'disabled';
  operatorAuth: 'configured' | 'not_configured';
  /** O22 Plan B review R3: whether a broker access key is configured, and (not secret) its key ids. */
  brokerAccess: 'configured' | 'not_configured';
  brokerAccessKeyIds: { current: string | null; previous: string | null };
}

const API_KEY = /^[A-Za-z0-9]{8,128}$/;
const DATABASE_URL = /^postgres(ql)?:\/\/\S+$/;
const OPERATOR_ID = /^[A-Za-z0-9_.@-]{1,64}$/;
/** A long random secret: printable ASCII without space, 32 to 512 characters. There is no default. */
const OPERATOR_TOKEN = /^[\x21-\x7e]{32,512}$/;
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
    if (!isValidEtoroKey(etoroApiKey)) invalid('ETORO_API_KEY has an invalid format');
    if (!isValidEtoroKey(etoroUserKey)) invalid('ETORO_USER_KEY has an invalid format');
  }

  // eToro demo execution (O21). Exactly 0 or 1, not trimmed; missing or empty is off. On needs eToro on and the demo mode set.
  const executionRaw = env.ETORO_DEMO_EXECUTION_ENABLED;
  if (executionRaw !== undefined && executionRaw !== '' && executionRaw !== '0' && executionRaw !== '1') invalid('ETORO_DEMO_EXECUTION_ENABLED must be 1 or 0');
  const demoExecutionEnabled = executionRaw === '1';
  if (demoExecutionEnabled && (!etoroEnabled || etoroMode !== 'demo')) {
    invalid('ETORO_DEMO_EXECUTION_ENABLED=1 requires ETORO_ENABLED=1 and ETORO_TRADING_MODE=demo');
  }

  // Operator authentication (O21). Both variables or neither; no default; the token must not be one of the broker keys.
  const operatorId = text(env, 'NEXUS_OPERATOR_ID');
  const operatorToken = text(env, 'NEXUS_OPERATOR_TOKEN');
  if ((operatorId === undefined) !== (operatorToken === undefined)) invalid('NEXUS_OPERATOR_ID and NEXUS_OPERATOR_TOKEN must be set together');
  if (operatorId !== undefined && !OPERATOR_ID.test(operatorId)) invalid('NEXUS_OPERATOR_ID has an invalid format');
  if (operatorToken !== undefined) {
    if (!OPERATOR_TOKEN.test(operatorToken)) invalid('NEXUS_OPERATOR_TOKEN must be 32 to 512 printable characters without spaces');
    if (operatorToken === etoroApiKey || operatorToken === etoroUserKey) invalid('NEXUS_OPERATOR_TOKEN must not be a broker key');
  }

  // Broker access fingerprint key (O22 Plan B review R3). Each id/key pair together or not at all; the previous pair only with a
  // current one; ids and keys differ; no key may be a broker key or the operator token. Refusals name the variable, never a value.
  const accessPair = (idName: string, keyName: string): { id: string; secret: string } | null => {
    const id = text(env, idName);
    const secret = text(env, keyName);
    if ((id === undefined) !== (secret === undefined)) invalid(idName + ' and ' + keyName + ' must be set together');
    if (id === undefined || secret === undefined) return null;
    if (!ACCESS_KEY_ID.test(id)) invalid(idName + ' must be 1 to 32 characters: a-z, 0-9, ".", "_" or "-"');
    if (!ACCESS_KEY_SECRET.test(secret)) invalid(keyName + ' must be 32 to 512 printable characters without spaces');
    if (secret === etoroApiKey || secret === etoroUserKey || secret === operatorToken) invalid(keyName + ' must not be a broker key or the operator token');
    return { id, secret };
  };
  const accessCurrent = accessPair('NEXUS_BROKER_ACCESS_KEY_ID', 'NEXUS_BROKER_ACCESS_KEY');
  const accessPrevious = accessPair('NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID', 'NEXUS_BROKER_ACCESS_PREVIOUS_KEY');
  if (accessPrevious !== null && accessCurrent === null) invalid('NEXUS_BROKER_ACCESS_PREVIOUS_KEY needs a current NEXUS_BROKER_ACCESS_KEY');
  if (accessPrevious !== null && accessCurrent !== null && (accessPrevious.id === accessCurrent.id || accessPrevious.secret === accessCurrent.secret)) {
    invalid('the previous broker access key must differ from the current one (id and key)');
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
    operator: operatorId !== undefined && operatorToken !== undefined ? Object.freeze({ id: operatorId, token: operatorToken }) : null,
    etoroDemoExecution: Object.freeze({ enabled: demoExecutionEnabled }),
    brokerAccess: Object.freeze({ current: accessCurrent === null ? null : Object.freeze(accessCurrent), previous: accessPrevious === null ? null : Object.freeze(accessPrevious) }),
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
    etoroDemoExecution: config.etoroDemoExecution.enabled ? 'enabled' : 'disabled',
    operatorAuth: config.operator !== null ? 'configured' : 'not_configured',
    brokerAccess: config.brokerAccess.current !== null ? 'configured' : 'not_configured',
    brokerAccessKeyIds: { current: config.brokerAccess.current?.id ?? null, previous: config.brokerAccess.previous?.id ?? null },
  };
}
