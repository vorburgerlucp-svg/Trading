// Source license policy (financial-license-policy:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §6). Data that is not production-approved is never served
// to a production request, and evidence always carries the license it was served under.

import { FinancialGatewayError, type FinancialEnvironment } from './financial-types.js';

export const LICENSE_STATUSES = ['unreviewed', 'research_only', 'production_approved', 'restricted'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const REDISTRIBUTIONS = ['unknown', 'forbidden', 'internal_only', 'allowed'] as const;
export type Redistribution = (typeof REDISTRIBUTIONS)[number];

export interface FinancialSourceLicense {
  readonly status: LicenseStatus;
  readonly redistribution: Redistribution;
  readonly note?: string;
}

export function licenseOf(value: unknown): FinancialSourceLicense {
  if (typeof value !== 'object' || value === null) throw new FinancialGatewayError('REGISTRATION_INVALID', 'license must be an object');
  const l = value as Record<string, unknown>;
  if (typeof l.status !== 'string' || !(LICENSE_STATUSES as readonly string[]).includes(l.status)) throw new FinancialGatewayError('REGISTRATION_INVALID', 'license status is not recognised');
  if (typeof l.redistribution !== 'string' || !(REDISTRIBUTIONS as readonly string[]).includes(l.redistribution)) throw new FinancialGatewayError('REGISTRATION_INVALID', 'license redistribution is not recognised');
  if (l.note !== undefined && typeof l.note !== 'string') throw new FinancialGatewayError('REGISTRATION_INVALID', 'license note must be a string');
  return Object.freeze({
    status: l.status as LicenseStatus,
    redistribution: l.redistribution as Redistribution,
    ...(typeof l.note === 'string' ? { note: l.note } : {}),
  });
}

/** Whether the source may serve a request in this environment. Restricted sources serve nothing. */
export function licenseServes(license: FinancialSourceLicense, environment: FinancialEnvironment): boolean {
  if (license.status === 'restricted') return false;
  if (environment !== 'production') return true;
  return license.status === 'production_approved' && (license.redistribution === 'internal_only' || license.redistribution === 'allowed');
}
