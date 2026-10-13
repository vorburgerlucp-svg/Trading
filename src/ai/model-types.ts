// Shared AI vocabulary. No provider is tied to a domain here: domain assignments are measured
// (model performance) or configured as initial preferences (champions), never hard-coded.

import { chf, MoneyError, type Rappen } from '../money/money.js';

export const DOMAINS = [
  'macro',
  'crypto',
  'equities',
  'fundamentals',
  'technical_analysis',
  'news',
  'risk_analysis',
  'business_opportunity',
  'physical_commerce',
  'capital_allocation',
  'ipo',
  'forex',
  'commodities',
  'coding',
  'research',
  'multimodal',
] as const;
export type Domain = (typeof DOMAINS)[number];

export const SUBTASKS = [
  'discovery',
  'classification',
  'deep_research',
  'bull_case',
  'bear_case',
  'risk_review',
  'news_sentiment',
  'fundamental_analysis',
  'macro_analysis',
  'technical_interpretation',
  'opportunity_comparison',
  'capital_allocation',
] as const;
export type Subtask = (typeof SUBTASKS)[number];

export const MODEL_CAPABILITIES = ['structured_output', 'tool_use', 'long_context', 'vision', 'web_search', 'reasoning', 'code'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** `${provider}/${model}` */
export type ModelKey = string;
export function modelKey(provider: string, model: string): ModelKey {
  return provider + '/' + model;
}

/** Roles are assigned per task by the planner/router, never fixed to a provider. */
export type CouncilRole = 'analyst' | 'counter_analyst' | 'critic';

export type Stance = 'bullish' | 'bearish' | 'neutral' | 'insufficient_data';
export type Recommendation = 'buy' | 'sell' | 'hold' | 'no_trade';

export const CRITIC_CHECKS = [
  'hidden_risk',
  'counter_argument',
  'data_gap',
  'correlation',
  'liquidity',
  'event_risk',
  'alternative_explanation',
  'wrong_assumption',
  'over_optimistic_forecast',
] as const;
export type CriticCheck = (typeof CRITIC_CHECKS)[number];

export type ClaimCategory = 'fact' | 'hypothesis' | 'risk' | 'catalyst' | 'contradiction' | 'calculation' | 'critique';
const CLAIM_CATEGORIES: readonly ClaimCategory[] = ['fact', 'hypothesis', 'risk', 'catalyst', 'contradiction', 'calculation', 'critique'];

export interface ModelClaim {
  category: ClaimCategory;
  statement: string;
  evidenceRefIds: string[];
  confidence?: number;
}

export interface RiskFlag {
  check: CriticCheck;
  severity: 'blocking' | 'major' | 'minor';
  statement: string;
  evidenceRefIds: string[];
}

/** The only shape a model answer can take. Anything else is rejected as invalid output. */
export interface ModelOpinion {
  stance: Stance;
  recommendation: Recommendation;
  /** 0..1 confidence SCORE, not a calibrated probability. */
  confidence: number;
  /** Upper-bound hint only. The Capital Engine and allocation policy decide the amount. */
  suggestedCapitalChf: Rappen | null;
  claims: ModelClaim[];
  riskFlags: RiskFlag[];
  modelVersion: string;
}

export class InvalidModelOutputError extends Error {
  override readonly name = 'InvalidModelOutputError';
}

const MAX_TEXT = 2000;
const MAX_ITEMS = 50;

/** Strict validation of raw model output (schema nexus.opinion.v1). */
export function parseModelOpinion(raw: unknown): ModelOpinion {
  const fail = (message: string): never => {
    throw new InvalidModelOutputError(message);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('output must be an object');
  const o = raw as Record<string, unknown>;

  const stance = oneOf(o.stance, ['bullish', 'bearish', 'neutral', 'insufficient_data'] as const) ?? fail('invalid stance');
  const recommendation = oneOf(o.recommendation, ['buy', 'sell', 'hold', 'no_trade'] as const) ?? fail('invalid recommendation');
  const confidence = unitNumber(o.confidence) ?? fail('confidence must be a number within 0..1');
  const modelVersion = text(o.modelVersion, 200) ?? fail('modelVersion is required');

  let suggestedCapitalChf: Rappen | null = null;
  if (o.suggestedCapitalChf !== undefined && o.suggestedCapitalChf !== null) {
    if (typeof o.suggestedCapitalChf !== 'string') fail('suggestedCapitalChf must be a decimal string');
    try {
      suggestedCapitalChf = chf(o.suggestedCapitalChf as string);
    } catch (error) {
      fail('suggestedCapitalChf: ' + (error instanceof MoneyError ? error.message : 'not a CHF amount'));
    }
    if (suggestedCapitalChf !== null && suggestedCapitalChf < 0n) fail('suggestedCapitalChf must not be negative');
  }

  const claims = list(o.claims, 'claims').map((c, i): ModelClaim => {
    const claim = asRecord(c) ?? fail('claims[' + i + '] must be an object');
    const parsed: ModelClaim = {
      category: oneOf(claim.category, CLAIM_CATEGORIES) ?? fail('claims[' + i + '].category invalid'),
      statement: text(claim.statement, MAX_TEXT) ?? fail('claims[' + i + '].statement invalid'),
      evidenceRefIds: ids(claim.evidenceRefIds) ?? fail('claims[' + i + '].evidenceRefIds invalid'),
    };
    if (claim.confidence !== undefined) parsed.confidence = unitNumber(claim.confidence) ?? fail('claims[' + i + '].confidence invalid');
    return parsed;
  });

  const riskFlags = list(o.riskFlags, 'riskFlags').map((f, i): RiskFlag => {
    const flag = asRecord(f) ?? fail('riskFlags[' + i + '] must be an object');
    return {
      check: oneOf(flag.check, CRITIC_CHECKS) ?? fail('riskFlags[' + i + '].check invalid'),
      severity: oneOf(flag.severity, ['blocking', 'major', 'minor'] as const) ?? fail('riskFlags[' + i + '].severity invalid'),
      statement: text(flag.statement, MAX_TEXT) ?? fail('riskFlags[' + i + '].statement invalid'),
      evidenceRefIds: ids(flag.evidenceRefIds) ?? fail('riskFlags[' + i + '].evidenceRefIds invalid'),
    };
  });

  return { stance, recommendation, confidence, suggestedCapitalChf, claims, riskFlags, modelVersion };

  function list(value: unknown, label: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(label + ' must be an array with at most ' + MAX_ITEMS + ' items');
    return value as unknown[];
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function unitNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : undefined;
}

function ids(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every((v) => typeof v === 'string' && v.trim() !== '')) return undefined;
  return value as string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
