// R1 architecture test: the complete import graph of every research entry point. Two graphs are checked:
//   runtime graph (value imports, executed code): every reachable file must lie in an allowlisted area;
//   full graph (also `import type`): no reachable file may be a broker, execution, runtime, model, capital, safety or trading module.
// A new import that leaves the allowed areas fails here until it is reviewed. The graph is read from the source text, so the
// test needs no build and also sees dynamic import().
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';

const ROOT = resolve(__dirname, '..', '..');
const ENTRY_POINTS = ['src/research/research-main.ts', 'src/research/research-status-cli.ts', 'src/research/research-migrate.ts'];

/** Areas the research instance may EXECUTE code from. */
const RUNTIME_ALLOWED = [/^src\/research\//, /^src\/market-data\//, /^src\/persistence\//, /^src\/money\//, /^src\/capital\/ledger-errors\.ts$/];
/**
 * Leaf files outside those areas that the persistence layer needs. Each must stay a leaf (no import at all), so it can never
 * become a bridge into its area: src/capital/ledger-errors.ts is the error class pg-errors.ts maps PostgreSQL failures to.
 */
const LEAVES = ['src/capital/ledger-errors.ts'];
/** Areas it may not reach at all, not even for a type. */
const FORBIDDEN = [
  /^src\/broker\//,
  /^src\/broker-adapter\.ts$/,
  /^src\/runtime\//,
  /^src\/nexus\//,
  /^src\/ai\//,
  /^src\/ai-adapter\.ts$/,
  /^src\/safety\//,
  /^src\/risk-engine\.ts$/,
  /^src\/evaluation\//,
  /^src\/inventory\//,
  /^src\/capital\/(?!capital-types\.ts$|ledger-errors\.ts$)/,
  /execution/i,
  /etoro/i,
];
/** Node built-ins the research instance may use. No processes, sockets of its own, workers or clusters. */
const BUILTINS_ALLOWED = new Set(['node:crypto', 'node:fs', 'node:os', 'node:path', 'node:url', 'node:stream', 'node:util', 'node:timers']);
const PACKAGES_ALLOWED = new Set(['pg']);

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
}

function edgesOf(file: string): Edge[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const edges: Edge[] = [];
  for (const m of text.matchAll(IMPORT)) edges.push({ from: file, to: m[3]!, typeOnly: m[2] !== undefined });
  for (const m of text.matchAll(DYNAMIC)) edges.push({ from: file, to: m[1]!, typeOnly: false });
  return edges;
}

function resolveLocal(from: string, specifier: string): string {
  const target = relative(ROOT, resolve(ROOT, dirname(from), specifier)).replace(/\\/g, '/').replace(/\.js$/, '.ts');
  if (!existsSync(join(ROOT, target))) throw new Error('unresolved import ' + specifier + ' in ' + from);
  return target;
}

function graph(entry: string, includeTypes: boolean): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const edge of edgesOf(file)) {
      if (edge.typeOnly && !includeTypes) continue;
      if (edge.to.startsWith('.')) pending.push(resolveLocal(file, edge.to));
      else externals.add(edge.to);
    }
  }
  return { files, externals };
}

describe('R1 research isolation: import graph of the research entry points', () => {
  for (const entry of ENTRY_POINTS) {
    it(entry + ': the executed code stays in research, market data, persistence and money', () => {
      const { files, externals } = graph(entry, false);
      const outside = [...files].filter((f) => !RUNTIME_ALLOWED.some((p) => p.test(f)));
      expect(outside).toEqual([]);
      expect([...externals].filter((e) => !BUILTINS_ALLOWED.has(e) && !PACKAGES_ALLOWED.has(e))).toEqual([]);
    });

    it(entry + ': not even a type import reaches a broker, execution, runtime, model, capital, safety or trading module', () => {
      const { files } = graph(entry, true);
      expect([...files].filter((f) => FORBIDDEN.some((p) => p.test(f)))).toEqual([]);
      expect(files.size).toBeGreaterThan(10); // the walk really followed the graph
    });
  }

  it('the research code itself contains no order, broker or trading call and no unlock', () => {
    const { files } = graph('src/research/research-main.ts', true);
    for (const file of [...files].filter((f) => f.startsWith('src/research/'))) {
      const text = readFileSync(join(ROOT, file), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(text, file).not.toMatch(/BUILD_LOCKS|placeOrder|submitOrder|cancelOrder|\.execute\(|child_process|worker_threads/);
    }
  });

  it('research:status cannot fetch, reserve credits, take the worker lock or run the worker: none of that code is reachable', () => {
    const { files } = graph('src/research/research-status-cli.ts', false);
    const writers = ['src/research/research-main.ts', 'src/research/research-worker.ts', 'src/research/research-budget.ts', 'src/research/research-lock.ts', 'src/research/research-migrate.ts', 'src/market-data/market-data-service.ts', 'src/market-data/providers/twelve-data.ts'];
    expect(writers.filter((f) => files.has(f))).toEqual([]);
    const text = readFileSync(join(ROOT, 'src/research/research-status-cli.ts'), 'utf8');
    expect(text).toMatch(/readOnly: true/);
    expect(text).toMatch(/openResearchStoresReadOnly/);
    expect(text).not.toMatch(/openResearchStores\(|\bmigrate\(|fetch\(/);
  });

  it('the allowed leaves outside the research areas import nothing', () => {
    for (const leaf of LEAVES) expect(edgesOf(leaf), leaf).toEqual([]);
  });

  it('the walk catches a forbidden import (self-test with a synthetic edge)', () => {
    expect(FORBIDDEN.some((p) => p.test('src/broker/etoro/execution/etoro-demo-execution-service.ts'))).toBe(true);
    expect(FORBIDDEN.some((p) => p.test('src/runtime/compose.ts'))).toBe(true);
    expect(RUNTIME_ALLOWED.some((p) => p.test('src/runtime/config.ts'))).toBe(false);
    expect(() => resolveLocal('src/research/research-main.ts', './does-not-exist.js')).toThrow(/unresolved/);
  });

  it('all four build locks stay closed', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
  });
});
