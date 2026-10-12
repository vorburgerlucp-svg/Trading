import { describe, expect, it } from 'vitest';
import { newYorkDateOf, sourceEligibleOn, SOURCE_POLICY_VERSION } from '../../src/financial/historical-policy.js';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §4–§5. The policy compares the America/New_York calendar date of asOf, strictly, with the official SEC
// filing date. It never compares the UTC date. Every instant below is checked by hand against the New York offset in force at that moment.

describe('policy identity', () => {
  it('names the policy version', () => {
    expect(SOURCE_POLICY_VERSION).toBe('sec-filing-date-next-ny-day:v1');
  });
});

describe('the New York calendar date (America/New_York)', () => {
  it.each([
    ['EST, mid-January', '2024-01-15T12:00:00.000Z', '2024-01-15'],
    ['EDT, midsummer', '2024-07-04T12:00:00.000Z', '2024-07-04'],
    ['spring transition: the last EST minute of 10 March 2024', '2024-03-10T06:59:59.999Z', '2024-03-10'],
    ['spring transition: 03:00 EDT on 10 March 2024', '2024-03-10T07:00:00.000Z', '2024-03-10'],
    ['end of 10 March 2024 in EDT', '2024-03-11T03:59:59.999Z', '2024-03-10'],
    ['start of 11 March 2024 in EDT', '2024-03-11T04:00:00.000Z', '2024-03-11'],
    ['autumn transition: the first 01:30 on 3 November 2024 (EDT)', '2024-11-03T05:30:00.000Z', '2024-11-03'],
    ['autumn transition: the second 01:30 on 3 November 2024 (EST)', '2024-11-03T06:30:00.000Z', '2024-11-03'],
    ['end of 3 November 2024 in EST', '2024-11-04T04:59:59.999Z', '2024-11-03'],
    ['start of 4 November 2024 in EST', '2024-11-04T05:00:00.000Z', '2024-11-04'],
    ['23:59:59.999 New York on 1 November 2024 (EDT)', '2024-11-02T03:59:59.999Z', '2024-11-01'],
    ['00:00 New York on 2 November 2024 (EDT)', '2024-11-02T04:00:00.000Z', '2024-11-02'],
    ['UTC is already 2 November but New York is still 1 November', '2024-11-02T02:00:00.000Z', '2024-11-01'],
  ])('%s', (_label, instant, expected) => {
    expect(newYorkDateOf(instant)).toBe(expected);
  });
});

describe('strict eligibility for a filing dated 2024-11-01 (brief 30)', () => {
  const filingDate = '2024-11-01';

  it.each([
    ['the previous evening, New York 2024-10-31', '2024-11-01T00:00:00.000Z'],
    ['09:00 New York on the filing day', '2024-11-01T13:00:00.000Z'],
    ['19:59 New York on the filing day', '2024-11-01T23:59:59.999Z'],
    ['23:59:59.999 New York on the filing day', '2024-11-02T03:59:59.999Z'],
    ['UTC is already 2 November, New York is still the filing day', '2024-11-02T02:00:00.000Z'],
  ])('is not eligible: %s', (_label, asOf) => {
    expect(sourceEligibleOn(filingDate, asOf)).toBe(false);
  });

  it('is eligible from 00:00 New York on the next day, strictly greater than the filing date', () => {
    expect(sourceEligibleOn(filingDate, '2024-11-02T04:00:00.000Z')).toBe(true);
    expect(sourceEligibleOn(filingDate, '2024-11-05T12:00:00.000Z')).toBe(true);
  });
});

describe('input validation', () => {
  it('refuses an as-of that is not a canonical UTC instant', () => {
    expect(() => newYorkDateOf('2024-11-02')).toThrow();
    expect(() => sourceEligibleOn('2024-11-01', '2024-11-02')).toThrow();
  });

  it('refuses an impossible filing date', () => {
    expect(() => sourceEligibleOn('2024-02-30', '2024-11-02T04:00:00.000Z')).toThrow();
  });
});
