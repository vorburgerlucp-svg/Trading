import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { v1bIdSnapshot } from './v1b-golden-snapshot.js';

// docs/PATTERN_ENGINE_V1C.md §1. The V1B id golden was captured on 3bfb9ae, before any V1C change. The V1 golden is in v1-regression.test.ts.
const golden = JSON.parse(readFileSync(new URL('./golden/v1b-ids.json', import.meta.url), 'utf8')) as unknown;

describe('V1B instance-id golden (docs/PATTERN_ENGINE_V1C.md §1)', () => {
  it('every V1 and V1B structure keeps its instance id after V1C', () => {
    expect(v1bIdSnapshot()).toEqual(golden);
  });
});
