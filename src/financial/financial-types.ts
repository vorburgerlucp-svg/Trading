// Closed vocabularies and the error type of the Financial Connector Gateway (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §3, §5, §20, §22).
// Read-only by construction: there is no capability, mode or error for orders, transfers, withdrawals or position changes.

export const FINANCIAL_CAPABILITIES = [
  'fundamentals',
  'financial_statements',
  'earnings',
  'earnings_estimates',
  'analyst_estimates',
  'macro',
  'economic_calendar',
  'news',
  'company_events',
  'institutional_holdings',
  'insider_transactions',
  'options_reference',
  'portfolio_read',
  'broker_account_read',
  'market_data_reference',
] as const;

export type FinancialCapability = (typeof FINANCIAL_CAPABILITIES)[number];

/** Capabilities with a payload validator in V1. Every other value is reserved and refused at registration. */
export const IMPLEMENTED_CAPABILITIES: readonly FinancialCapability[] = ['fundamentals', 'news', 'portfolio_read'];

export const FINANCIAL_ENVIRONMENTS = ['shadow', 'research', 'production'] as const;
export type FinancialEnvironment = (typeof FINANCIAL_ENVIRONMENTS)[number];

export const FINANCIAL_MODES = ['SHADOW', 'RESEARCH', 'PRODUCTION'] as const;
export type FinancialMode = (typeof FINANCIAL_MODES)[number];

/** The environments each mode serves (§5). */
const SERVES: Readonly<Record<FinancialMode, readonly FinancialEnvironment[]>> = {
  SHADOW: ['shadow'],
  RESEARCH: ['research', 'shadow'],
  PRODUCTION: ['research', 'shadow', 'production'],
};

export function modeServes(mode: FinancialMode, environment: FinancialEnvironment): boolean {
  return SERVES[mode].includes(environment);
}

export type FinancialTransport = 'mcp' | 'rest' | 'internal';

export const FINANCIAL_VERSIONS = {
  gateway: 'financial-gateway:v1',
  /** v2 carries the canonical request snapshot, so a stored record can recompute its own identity (docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §2). */
  evidence: 'financial-evidence:v2',
  evidenceStore: 'financial-evidence-store:v1',
  knowledgeSeal: 'financial-knowledge-seal:v1',
  pitRead: 'financial-pit-read:v1',
  registry: 'financial-connector-registry:v1',
  mcpTransport: 'mcp-financial-transport:v1',
  license: 'financial-license-policy:v1',
  untrusted: 'financial-untrusted-policy:v1',
} as const;

export type FinancialErrorCode =
  | 'CONNECTOR_SELECTION_REQUIRED'
  | 'CONNECTOR_NOT_FOUND'
  | 'CONNECTOR_DISABLED'
  | 'CONNECTOR_ALREADY_REGISTERED'
  | 'REGISTRATION_INVALID'
  | 'ACTIVATION_REQUIRES_HUMAN'
  | 'ACTIVATION_GATE_FAILED'
  | 'DATA_NOT_CONNECTED'
  | 'DATA_DEGRADED'
  | 'CAPABILITY_NOT_ALLOWED'
  | 'CAPABILITY_NOT_IMPLEMENTED'
  | 'MODE_NOT_ALLOWED'
  | 'LICENSE_NOT_ALLOWED'
  | 'REQUEST_INVALID'
  | 'TOOL_NOT_ALLOWED'
  | 'WRITE_TOOL_REFUSED'
  | 'SCHEMA_INVALID'
  | 'PERIOD_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'INSTRUMENT_MAPPING_MISSING'
  | 'INSTRUMENT_MAPPING_MISMATCH'
  | 'CONNECTOR_ID_DUPLICATE'
  | 'CONNECTOR_IDENTITY_MISMATCH'
  | 'CONNECTOR_CAPABILITY_MISMATCH'
  | 'CONNECTOR_PAYLOAD_INVALID';

export class FinancialGatewayError extends Error {
  override readonly name = 'FinancialGatewayError';
  constructor(
    readonly code: FinancialErrorCode,
    message: string,
  ) {
    super(message);
  }
}
