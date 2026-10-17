// The O21A observation tool: one read of one eToro demo source, reported as a sanitized schema report (etoro-observation.ts).
// It is not part of the runtime and nothing imports it. The source is mandatory and selects exactly one fixed GET of the O20
// transport: --source=portfolio -> portfolio.demo (GET /api/v1/trading/info/demo/portfolio), --source=pnl -> pnl.demo
// (GET /api/v1/trading/info/demo/pnl). One invocation sends exactly one request: no default source, no fallback from one source to
// the other, no retry. It writes nothing to disk: the report goes to stdout, the response body is dropped after the report is
// built. Keys are read from the environment and never printed; a failure prints a fixed code only.
//
//   npm run etoro:observe-demo -- --source=portfolio|pnl --confirm-live-read [--pseudonymize-ids] [--show-instrument-ids]
//
// It refuses to run without exactly one valid --source, without --confirm-live-read, without ETORO_TRADING_MODE=demo, or with
// malformed keys.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BrokerError } from '../broker-errors.js';
import { isValidEtoroKey } from './etoro-credentials.js';
import { observeDemoResponse, type ObservationReport, type ObservationSource } from './etoro-observation.js';
import type { EtoroOperation } from './etoro-readonly.js';
import { HttpsEtoroTransport, type EtoroTransport } from './etoro-transport.js';

export const CONFIRM_FLAG = '--confirm-live-read';
const KNOWN_FLAGS = new Set([CONFIRM_FLAG, '--pseudonymize-ids', '--show-instrument-ids']);
const SOURCE_PREFIX = '--source=';

/** The one fixed operation of each source. */
export const SOURCE_OPERATIONS: Readonly<Record<ObservationSource, EtoroOperation>> = Object.freeze({ portfolio: 'portfolio.demo', pnl: 'pnl.demo' });

function sourceOf(value: string): ObservationSource | null {
  return value === 'portfolio' || value === 'pnl' ? value : null;
}

export type ObservationOutcome =
  | { readonly exitCode: 0; readonly report: ObservationReport }
  | { readonly exitCode: 1 | 2; readonly error: string };

export interface ObservationRun {
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
  /** Tests inject a transport here. The default is the O20 HTTPS transport with the keys from the environment. */
  transport?: (credentials: { apiKey: string; userKey: string }) => EtoroTransport;
}

/** Runs one observation. Usage errors are exit code 2 and send no request; a broker failure is exit code 1 with its code only. */
export async function runObservation(run: ObservationRun): Promise<ObservationOutcome> {
  const sources = run.argv.filter((a) => a.startsWith(SOURCE_PREFIX));
  const unknown = run.argv.filter((a) => !KNOWN_FLAGS.has(a) && !a.startsWith(SOURCE_PREFIX));
  if (unknown.length > 0) return { exitCode: 2, error: 'unknown argument' };
  if (sources.length !== 1) return { exitCode: 2, error: 'refused: pass exactly one --source=portfolio or --source=pnl' };
  const source = sourceOf(sources[0]!.slice(SOURCE_PREFIX.length));
  if (source === null) return { exitCode: 2, error: 'refused: --source must be portfolio or pnl' };
  if (!run.argv.includes(CONFIRM_FLAG)) return { exitCode: 2, error: 'refused: pass ' + CONFIRM_FLAG + ' to send one read request to the eToro demo portfolio' };
  if (run.env.ETORO_TRADING_MODE !== 'demo') return { exitCode: 2, error: 'refused: ETORO_TRADING_MODE must be demo' };
  const apiKey = run.env.ETORO_API_KEY?.trim();
  const userKey = run.env.ETORO_USER_KEY?.trim();
  if (!isValidEtoroKey(apiKey) || !isValidEtoroKey(userKey)) return { exitCode: 2, error: 'refused: ETORO_API_KEY and ETORO_USER_KEY must be set and well-formed' };

  try {
    const credentials = { apiKey, userKey };
    const transport = run.transport ? run.transport(credentials) : new HttpsEtoroTransport({ credentials });
    // Exactly one request, of the selected source only. An empty or refused response never leads to a second request.
    const response = await transport.call(SOURCE_OPERATIONS[source]);
    if (response.status !== 200) return { exitCode: 1, error: 'broker returned HTTP ' + response.status };
    const report = observeDemoResponse(source, response.body, {
      pseudonymizeIds: run.argv.includes('--pseudonymize-ids'),
      showInstrumentIds: run.argv.includes('--show-instrument-ids'),
    });
    return { exitCode: 0, report };
  } catch (error) {
    return { exitCode: 1, error: error instanceof BrokerError ? error.code : 'OBSERVATION_FAILED' };
  }
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const outcome = await runObservation({ env: process.env, argv: process.argv.slice(2) });
  if (outcome.exitCode === 0) process.stdout.write(JSON.stringify(outcome.report, null, 2) + '\n');
  else process.stderr.write(outcome.error + '\n');
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
