import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { v1Snapshot } from './golden-snapshot.js';

// docs/PATTERN_ENGINE_V1B.md §20. The golden file was captured at the base commit 36dd8ab, before any V1B source change.
const golden = JSON.parse(readFileSync(new URL('./golden/v1-observations.json', import.meta.url), 'utf8')) as unknown;

describe('V1 golden regression (docs/PATTERN_ENGINE_V1B.md §20)', () => {
  it('every V1 structure keeps its geometry, status, timestamps and instance identity', () => {
    expect(v1Snapshot()).toEqual(golden);
  });
});
