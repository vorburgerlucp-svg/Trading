// A connector that is declared but not configured (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §4). It never returns empty evidence in place of data.

import type { ConnectionState, ConnectorPayload, FinancialConnector, FinancialConnectorHealth } from './connector.js';
import { FinancialGatewayError, type FinancialCapability, type FinancialTransport } from './financial-types.js';

export interface NotConnectedOptions {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  readonly capabilities: readonly FinancialCapability[];
}

export class NotConnectedFinancialConnector implements FinancialConnector {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  private readonly declared: readonly FinancialCapability[];

  constructor(options: NotConnectedOptions) {
    this.connectorId = options.connectorId;
    this.provider = options.provider;
    this.transport = options.transport;
    this.declared = [...options.capabilities];
  }

  capabilities(): readonly FinancialCapability[] {
    return this.declared;
  }

  connection(): ConnectionState {
    return 'not_connected';
  }

  async fetch(): Promise<ConnectorPayload> {
    throw new FinancialGatewayError('DATA_NOT_CONNECTED', this.connectorId + ' is not connected: no credentials or configuration');
  }

  health(): FinancialConnectorHealth {
    return { connectorId: this.connectorId, connection: 'not_connected', lastErrorCode: null };
  }
}
