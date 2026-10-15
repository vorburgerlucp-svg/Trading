import { describe, expect, it } from 'vitest';
import { brokerAccountKey, maskAccountId } from '../../src/broker/broker-snapshot-model.js';

describe('O19 broker snapshot account identity', () => {
  it('keeps the display reference masked while binding persistence to the actual broker account', () => {
    const first = { broker: 'ibkr', accountId: 'U1234567' };
    const second = { broker: 'ibkr', accountId: 'U9999567' };

    expect(maskAccountId(first.accountId)).toBe('U****567');
    expect(maskAccountId(second.accountId)).toBe('U****567');
    expect(brokerAccountKey(first)).toMatch(/^bacct_[0-9a-f]{40}$/);
    expect(brokerAccountKey(second)).toMatch(/^bacct_[0-9a-f]{40}$/);
    expect(brokerAccountKey(first)).not.toBe(brokerAccountKey(second));
  });
});
