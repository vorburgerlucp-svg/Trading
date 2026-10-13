// MCP transport (mcp-financial-transport:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §9). Transport only. A static allowlist maps each capability to one
// read tool, fixed at construction. Write tools are refused by name. The server's advertisement is data and never widens the map. A response is data:
// it never selects a tool, and the connector makes exactly the calls its map defines.

import type { ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { ConnectionState, ConnectorBody, ConnectorPayload, FinancialConnector, FinancialConnectorHealth } from './connector.js';
import type { FinancialRequest } from './financial-requests.js';
import { FinancialGatewayError, IMPLEMENTED_CAPABILITIES, type FinancialCapability, type FinancialTransport } from './financial-types.js';

export type McpConnectorBody = ConnectorBody;

/** Transport-only read client. There is no generic call: the connector passes a tool name taken from its own fixed map. */
export interface McpReadClient {
  connection(): ConnectionState;
  callReadTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpConnectorOptions {
  readonly connectorId: string;
  readonly provider: string;
  readonly serverId: string;
  readonly client: McpReadClient;
  readonly tools: Partial<Record<FinancialCapability, string>>;
  readonly map: (capability: FinancialCapability, raw: unknown, sent: { providerSymbol?: string | undefined }) => McpConnectorBody;
  readonly clock: () => Date;
  /** Runs on the frozen request before any call. It makes a mutation attempt observable in tests. */
  readonly before?: (request: FinancialRequest) => void;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const WRITE_TOKENS: ReadonlySet<string> = new Set(['buy', 'sell', 'submit', 'place', 'modify', 'cancel', 'transfer', 'withdraw', 'withdrawal', 'deposit', 'execute', 'trade', 'order', 'orders']);
const WRITE_POSITION = /(change|set|update|adjust|close|open)[_-]?position(?![a-z])|position[_-]?(change|update|set)(?![a-z])/i;
/** Compound write names, checked with the separators removed, so "placeorder" and "transferfunds" cannot slip past the token rule. */
const WRITE_COMPOUNDS = ['submitorder', 'placeorder', 'modifyorder', 'cancelorder', 'executeorder', 'buyorder', 'sellorder', 'transferfunds', 'moneytransfer', 'withdrawfunds'];

/** A write is refused by name: a write verb as a whole token, a compound write name, or a position change. Read names such as get_positions pass. */
export function isWriteToolName(name: string): boolean {
  const lower = name.toLowerCase();
  const tokens = lower.split(/[_.-]/);
  const squashed = lower.replace(/[_.-]/g, '');
  return tokens.some((token) => WRITE_TOKENS.has(token)) || WRITE_COMPOUNDS.some((compound) => squashed.includes(compound)) || WRITE_POSITION.test(name);
}

function argumentsFor(request: FinancialRequest, mapping: ProviderInstrumentMapping | null): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (mapping) args.providerSymbol = mapping.providerSymbol;
  if (request.capability === 'fundamentals') {
    args.period = request.period;
    args.currency = request.currency;
  }
  return args;
}

export class McpFinancialConnector implements FinancialConnector {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport = 'mcp';
  private readonly allowlist = new Map<FinancialCapability, string>();
  private lastErrorCode: string | null = null;

  constructor(private readonly options: McpConnectorOptions) {
    this.connectorId = options.connectorId;
    this.provider = options.provider;
    for (const [capability, tool] of Object.entries(options.tools) as Array<[FinancialCapability, string | undefined]>) {
      if (tool === undefined) continue;
      if (!(IMPLEMENTED_CAPABILITIES as readonly string[]).includes(capability)) throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', capability + ' has no validator in V1');
      if (isWriteToolName(tool)) throw new FinancialGatewayError('WRITE_TOOL_REFUSED', '"' + tool + '" is a write operation; the MCP transport is read-only');
      if (!TOOL_NAME.test(tool)) throw new FinancialGatewayError('TOOL_NOT_ALLOWED', 'a read tool name must be lower-case snake case');
      this.allowlist.set(capability, tool);
    }
  }

  capabilities(): readonly FinancialCapability[] {
    return [...this.allowlist.keys()];
  }

  connection(): ConnectionState {
    return this.options.client.connection();
  }

  health(): FinancialConnectorHealth {
    return { connectorId: this.connectorId, connection: this.connection(), lastErrorCode: this.lastErrorCode };
  }

  async fetch(request: FinancialRequest, mapping: ProviderInstrumentMapping | null): Promise<ConnectorPayload> {
    const tool = this.allowlist.get(request.capability);
    if (!tool) throw new FinancialGatewayError('TOOL_NOT_ALLOWED', 'no read tool is mapped for ' + request.capability + ' on ' + this.connectorId + '; no call was made');
    this.options.before?.(request);
    try {
      const raw = await this.options.client.callReadTool(this.options.serverId, tool, argumentsFor(request, mapping));
      const body = this.options.map(request.capability, raw, { providerSymbol: mapping?.providerSymbol });
      return { ...body, retrievedAt: this.options.clock().toISOString(), rawPayloadHash: hashOf(raw) };
    } catch (error) {
      this.lastErrorCode = error instanceof FinancialGatewayError ? error.code : 'transport_error';
      throw error;
    }
  }
}
