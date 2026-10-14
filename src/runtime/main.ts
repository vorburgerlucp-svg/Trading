// Entry point of the local NEXUS runtime (npm run dev, npm start). The work is in bootstrap.ts: this file reads the optional
// local .env, starts the runtime, reports it, and shuts it down on SIGINT or SIGTERM. Nothing it prints contains a secret.

import { existsSync } from 'node:fs';
import { describeFailure, startRuntime } from './bootstrap.js';

let stopping = false;

async function main(): Promise<void> {
  // The local .env is optional and never committed. A variable that is already set in the environment wins over the file.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const runtime = await startRuntime(process.env);
  console.log('NEXUS runtime listening on ' + runtime.url);
  console.log('mode: ' + JSON.stringify(runtime.config));

  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(signal + ': shutting down');
    runtime.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(describeFailure(error));
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
