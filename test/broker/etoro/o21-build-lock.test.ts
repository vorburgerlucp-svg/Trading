// O21 compile-time build lock, without any mock: the service reads BUILD_LOCKS.etoroDemoExecution directly. It has no constructor
// option, configuration or setter for it, so no production code can construct an unlocked service. Every write is refused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../../src/nexus/safety.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { HUMAN, approvedOpen, o21Fixture } from './o21-fixture.js';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return error.code;
    throw error;
  }
  throw new Error('expected a DemoExecutionError');
}

describe('O21 build lock (no mock)', () => {
  it('the lock is closed in this build', () => {
    expect(BUILD_LOCKS.etoroDemoExecution).toBe(true);
    expect(Object.isFrozen(BUILD_LOCKS)).toBe(true);
    expect(() => {
      (BUILD_LOCKS as { etoroDemoExecution: boolean }).etoroDemoExecution = false;
    }).toThrow(TypeError);
    expect(BUILD_LOCKS.etoroDemoExecution).toBe(true);
  });

  it('create, risk approval and approval work; execute is EXECUTION_LOCKED_IN_BUILD with 0 broker requests', async () => {
    const f = await o21Fixture();
    expect(f.service.status().etoroDemoExecution.buildLocked).toBe(true);
    const id = await approvedOpen(f);
    expect((await f.service.get(id)).state).toBe('APPROVED');
    expect(await codeOf(f.service.execute(id, HUMAN))).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(f.intents.get(id + ':SUBMITTING')).toBeUndefined();
    expect(f.broker.requests).toHaveLength(0);
  });

  it('cancel is EXECUTION_LOCKED_IN_BUILD with 0 broker requests', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    expect(await codeOf(f.service.cancel(id, HUMAN))).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('a constructor option cannot open the lock: an unknown buildLocked dependency is ignored', async () => {
    const f = await o21Fixture();
    const deps = { ...(f.service as unknown as { deps: Record<string, unknown> }).deps, buildLocked: false };
    const Service = f.service.constructor as new (d: unknown) => typeof f.service;
    const forged = new Service(deps);
    const id = await approvedOpen(f);
    expect(await codeOf(forged.execute(id, HUMAN))).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('the service source reads the constant and declares no lock option', () => {
    const source = readFileSync('src/broker/etoro/execution/etoro-demo-execution-service.ts', 'utf8');
    expect(source).toMatch(/return BUILD_LOCKS\.etoroDemoExecution;/);
    expect(source).not.toMatch(/buildLocked\?:/);
    expect(source).not.toMatch(/deps\.buildLocked/);
  });
});
