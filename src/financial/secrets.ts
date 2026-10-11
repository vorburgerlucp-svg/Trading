// Secret handling (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §10–§11). A connector holds a credential reference, never a value. Only the REST transport
// resolves the reference, and only into a request header. Registry events, evidence, hashes, logs and errors carry the reference at most.

import { FinancialGatewayError } from './financial-types.js';

export const CREDENTIAL_REF = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface SecretProvider {
  get(credentialRef: string): string | undefined;
}

export function credentialRefOf(value: unknown): string {
  if (typeof value !== 'string' || !CREDENTIAL_REF.test(value)) {
    throw new FinancialGatewayError('REGISTRATION_INVALID', 'credentialRef must be a configuration name such as alpha-vantage-prod');
  }
  return value;
}
