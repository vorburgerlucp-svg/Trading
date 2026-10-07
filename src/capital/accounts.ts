// Chart of accounts. Every key is built here and parsed here, nowhere else.
//
//   asset:cash:<bank|broker|crypto|physical>:<id>
//   asset:cash:<type>:<id>:reserved:<purpose>:<reservationId>
//   asset:position:<brokerId>:<instrumentId>
//   asset:inventory:<productId>[:reserved]
//   asset:receivable:<counterpartyId>
//   liability:payable:<counterpartyId>
//   liability:tax:<taxKind>
//   equity:contributions
//   income:trading:<brokerId>:<instrumentId>      realized trading P&L per position
//   income:sales:<productId>
//   income:other:<kind>
//   expense:cogs:<productId>
//   expense:fee:<feeKind>[:<scope>...]
//   expense:<shipping|advertising|returns|tax|other>[:<scope>...]

import type {
  AccountInfo,
  AccountKey,
  CashType,
  ExpenseCategory,
  FeeKind,
  ReservationPurpose,
} from './capital-types.js';

export class AccountError extends Error {
  override readonly name = 'AccountError';
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CASH_TYPES: readonly CashType[] = ['bank', 'broker', 'crypto', 'physical'];
const RESERVATION_PURPOSES: readonly ReservationPurpose[] = ['earmark', 'open_order', 'purchase_commitment'];
const FEE_KINDS: readonly FeeKind[] = ['trading', 'marketplace', 'payment', 'bank', 'custody', 'fx', 'other'];
const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['fee', 'shipping', 'advertising', 'returns', 'tax', 'other'];

function segment(value: string, label: string): string {
  if (!SEGMENT.test(value)) throw new AccountError(label + ' "' + value + '" must match ' + SEGMENT.source);
  return value;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new AccountError('unknown ' + label + ' "' + value + '"');
  }
  return value as T;
}

export const accounts = {
  cash: (cashType: CashType, cashId: string): AccountKey =>
    'asset:cash:' + oneOf(cashType, CASH_TYPES, 'cash type') + ':' + segment(cashId, 'cash id'),
  bank: (bankId: string): AccountKey => accounts.cash('bank', bankId),
  brokerCash: (brokerId: string): AccountKey => accounts.cash('broker', brokerId),
  cryptoCash: (walletId: string): AccountKey => accounts.cash('crypto', walletId),
  physicalCash: (id = 'wallet'): AccountKey => accounts.cash('physical', id),

  reservation: (cashAccount: AccountKey, purpose: ReservationPurpose, reservationId: string): AccountKey => {
    const parent = parseAccountKey(cashAccount);
    if (parent.kind !== 'cash') throw new AccountError('reservations must hang off a plain cash account, got ' + cashAccount);
    return cashAccount + ':reserved:' + oneOf(purpose, RESERVATION_PURPOSES, 'reservation purpose') + ':' + segment(reservationId, 'reservation id');
  },

  position: (brokerId: string, instrumentId: string): AccountKey =>
    'asset:position:' + segment(brokerId, 'broker id') + ':' + segment(instrumentId, 'instrument id'),
  inventory: (productId: string): AccountKey => 'asset:inventory:' + segment(productId, 'product id'),
  inventoryReserved: (productId: string): AccountKey => accounts.inventory(productId) + ':reserved',
  receivable: (counterpartyId: string): AccountKey => 'asset:receivable:' + segment(counterpartyId, 'counterparty id'),

  payable: (counterpartyId: string): AccountKey => 'liability:payable:' + segment(counterpartyId, 'counterparty id'),
  taxPayable: (taxKind: string): AccountKey => 'liability:tax:' + segment(taxKind, 'tax kind'),

  contributions: 'equity:contributions' as AccountKey,

  tradingPnl: (brokerId: string, instrumentId: string): AccountKey =>
    'income:trading:' + segment(brokerId, 'broker id') + ':' + segment(instrumentId, 'instrument id'),
  salesRevenue: (productId: string): AccountKey => 'income:sales:' + segment(productId, 'product id'),
  otherIncome: (kind: string): AccountKey => 'income:other:' + segment(kind, 'income kind'),

  cogs: (productId: string): AccountKey => 'expense:cogs:' + segment(productId, 'product id'),
  fee: (feeKind: FeeKind, ...scope: string[]): AccountKey =>
    ['expense:fee', oneOf(feeKind, FEE_KINDS, 'fee kind'), ...scope.map((s) => segment(s, 'scope'))].join(':'),
  expense: (category: Exclude<ExpenseCategory, 'fee'>, ...scope: string[]): AccountKey =>
    ['expense', oneOf(category, EXPENSE_CATEGORIES, 'expense category'), ...scope.map((s) => segment(s, 'scope'))].join(':'),
} as const;

export function parseAccountKey(key: AccountKey): AccountInfo {
  const parts = key.split(':');
  for (const part of parts) segment(part, 'account key segment');
  const [type, group, a, b, c, d, e, ...rest] = parts;
  const invalid = () => new AccountError('invalid account key "' + key + '"');

  switch (type) {
    case 'asset':
      if (group === 'cash' && a !== undefined && b !== undefined) {
        const cashType = oneOf(a, CASH_TYPES, 'cash type');
        if (c === undefined) return { kind: 'cash', type: 'asset', key, cashType, cashId: b };
        if (c === 'reserved' && d !== undefined && e !== undefined && rest.length === 0) {
          return {
            kind: 'cash_reservation',
            type: 'asset',
            key,
            cashType,
            cashId: b,
            parent: parts.slice(0, 4).join(':'),
            purpose: oneOf(d, RESERVATION_PURPOSES, 'reservation purpose'),
            reservationId: e,
          };
        }
      }
      if (group === 'position' && a !== undefined && b !== undefined && c === undefined) {
        return { kind: 'position', type: 'asset', key, brokerId: a, instrumentId: b };
      }
      if (group === 'inventory' && a !== undefined && (b === undefined || (b === 'reserved' && c === undefined))) {
        return { kind: 'inventory', type: 'asset', key, productId: a, reserved: b === 'reserved' };
      }
      if (group === 'receivable' && a !== undefined && b === undefined) {
        return { kind: 'receivable', type: 'asset', key, counterpartyId: a };
      }
      throw invalid();
    case 'liability':
      if (group === 'payable' && a !== undefined && b === undefined) return { kind: 'payable', type: 'liability', key, counterpartyId: a };
      if (group === 'tax' && a !== undefined && b === undefined) return { kind: 'tax_payable', type: 'liability', key, taxKind: a };
      throw invalid();
    case 'equity':
      if (group === 'contributions' && a === undefined) return { kind: 'contributions', type: 'equity', key };
      throw invalid();
    case 'income':
      if (group === 'trading' && a !== undefined && b !== undefined && c === undefined) {
        return { kind: 'trading_pnl', type: 'income', key, brokerId: a, instrumentId: b };
      }
      if (group === 'sales' && a !== undefined && b === undefined) return { kind: 'sales_revenue', type: 'income', key, productId: a };
      if (group === 'other' && a !== undefined && b === undefined) return { kind: 'other_income', type: 'income', key, incomeKind: a };
      throw invalid();
    case 'expense': {
      if (group === 'cogs' && a !== undefined && b === undefined) return { kind: 'cogs', type: 'expense', key, productId: a };
      const category = oneOf(group, EXPENSE_CATEGORIES, 'expense category');
      if (category === 'fee') {
        const feeKind = oneOf(a, FEE_KINDS, 'fee kind');
        return { kind: 'expense', type: 'expense', key, category, feeKind, scope: parts.slice(3) };
      }
      return { kind: 'expense', type: 'expense', key, category, scope: parts.slice(2) };
    }
    default:
      throw invalid();
  }
}

export function isCashLike(info: AccountInfo): info is Extract<AccountInfo, { kind: 'cash' | 'cash_reservation' }> {
  return info.kind === 'cash' || info.kind === 'cash_reservation';
}
