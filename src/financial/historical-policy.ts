// The historical source policy (sec-filing-date-next-ny-day:v1, docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §4–§5). An official filing dated D is eligible
// for historical research only when the America/New_York calendar date of asOf is strictly after D. This is a conservative research rule. It is not a claim
// that midnight of the next day is the exact dissemination time, and it never compares the UTC date.

import { localDateOf, parseUtc } from '../market-data/time.js';

export const SOURCE_POLICY_VERSION = 'sec-filing-date-next-ny-day:v1';
export const NEW_YORK_TIME_ZONE = 'America/New_York';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDateOk(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const [y = 0, m = 0, d = 0] = value.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** The New York calendar date (YYYY-MM-DD) of a strict UTC instant. Offsets and local times are refused. */
export function newYorkDateOf(instant: string): string {
  return localDateOf(parseUtc(instant), NEW_YORK_TIME_ZONE);
}

/** True when the New York calendar date of asOf is strictly after the official filing date. */
export function sourceEligibleOn(filingDate: string, asOf: string): boolean {
  if (!calendarDateOk(filingDate)) throw new Error('filingDate must be a valid calendar date (YYYY-MM-DD)');
  return newYorkDateOf(asOf) > filingDate;
}
