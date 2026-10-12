import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §33. Historical source attestation is evidence and research infrastructure only. Its modules import no
// broker, capital, risk, execution gate or model adapter, and they expose no order operation.

const ROOT = new URL('../../', import.meta.url);

const ATTESTATION_MODULES = [
  'src/financial/historical-policy.ts',
  'src/financial/financial-source-attestation.ts',
  'src/financial/sec-archive-header.ts',
  'src/financial/sec-source-attestation.ts',
  'src/financial/financial-source-attestation-store.ts',
  'src/financial/financial-replay-reader.ts',
  'src/persistence/postgres/postgres-financial-source-attestation-store.ts',
];

const FORBIDDEN = [/broker/, /capital/, /risk/, /nexus\/safety/, /\/ai\//, /execution/, /opportunities\/(?!opportunity-types)/];

const importsOf = (text: string) => [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('static boundaries for historical source attestation (brief 33)', () => {
  it.each(ATTESTATION_MODULES)('%s imports no broker, capital, risk, execution or AI module', (file) => {
    const text = readFileSync(new URL(file, ROOT), 'utf8');
    for (const spec of importsOf(text)) {
      const hit = FORBIDDEN.find((rule) => rule.test(spec));
      expect({ file, spec, hit: hit?.source ?? null }).toEqual({ file, spec, hit: null });
    }
  });

  it.each(ATTESTATION_MODULES)('%s exposes no order, transfer or withdrawal operation', (file) => {
    const text = readFileSync(new URL(file, ROOT), 'utf8');
    expect(text).not.toMatch(/placeOrder|cancelOrder|modifyOrder|submitOrder|transfer\(|withdraw\(/i);
  });
});
