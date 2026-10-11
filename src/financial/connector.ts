// The connector contract (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §8). A connector gets a frozen request and returns a payload derived from one raw answer.
// It never sees the registry, never holds another connector's credentials, and never names a tool outside its own static map.

import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import type { FinancialRequest } from './financial-requests.js';
import type { FinancialCapability, FinancialTransport } from './financial-types.js';

export type ConnectionState = 'connected' | 'not_connected' | 'degraded';

export interface ConnectorBody {
  /** The raw provider answer, mapped to the candidate shape the capability validator reads. */
  readonly candidate: unknown;
  /** The provider's own symbol for the instrument, if the answer names one. Checked against the mapping. */
  readonly providerSymbol?: string | undefined;
  readonly providerPublishedAt?: string | undefined;
  readonly effectiveAt?: string | undefined;
  /** External text. It is quarantined by the gateway before it can be read as data. */
  readonly textBlocks?: ReadonlyArray<{ readonly source: string; readonly text: string }> | undefined;
}

export interface ConnectorPayload extends ConnectorBody {
  /** When the transport completed the fetch (process time, not part of identity). */
  readonly retrievedAt: string;
  readonly rawPayloadHash: string;
}

export interface FinancialConnectorHealth {
  readonly connectorId: string;
  readonly connection: ConnectionState;
  readonly lastErrorCode: string | null;
}

export interface FinancialConnector {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  connection(): ConnectionState;
  capabilities(): readonly FinancialCapability[];
  fetch(request: FinancialRequest, mapping: ProviderInstrumentMapping | null): Promise<ConnectorPayload>;
  health(): FinancialConnectorHealth;
}
