import type { BrokerOrderResult, OrderIntent, TradingMode } from './contracts.js';

export interface BrokerAdapter {
  readonly name:string;
  readonly mode:TradingMode;
  preview(intent:OrderIntent):Promise<{ok:boolean;message:string}>;
  place(intent:OrderIntent):Promise<BrokerOrderResult>;
}

abstract class LockedBroker implements BrokerAdapter {
  abstract readonly name:string;
  constructor(public readonly mode:TradingMode){}
  async preview(intent:OrderIntent){ return {ok:true,message:this.name+' preview prepared for '+intent.symbol}; }
  async place(intent:OrderIntent):Promise<BrokerOrderResult>{ return {broker:this.name,mode:this.mode,accepted:false,message:'Execution locked in V0.1 for '+intent.clientOrderId}; }
}

export class EtoroBroker extends LockedBroker { readonly name='etoro'; }
export class IbkrBroker extends LockedBroker { readonly name='ibkr'; }
