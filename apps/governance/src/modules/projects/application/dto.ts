import type { ClassificationLevel, DataZone } from '../domain/value-objects/data-classification.js';

export interface CreateProjectCommand {
  slug: string;
  name: string;
  description?: string;
  dataClassification: string;
  legalBasis: string;
  purpose: string;
  costCenter?: string;
  ownerPrincipalId?: string;
}

export interface SetBudgetCommand {
  projectId: string;
  limitMicros: number;
  currency: string;
  period: 'daily' | 'monthly';
  blockAtLimit?: boolean;
  alertThresholds?: number[];
}

export interface SetPolicyCommand {
  projectId: string;
  allowedDataZones?: DataZone[];
  modelRules?: { alias: string; allowed: boolean; maxOutputTokens?: number }[];
  maxConcurrentRequests?: number;
  contentCapture?: boolean;
}

export interface ProjectView {
  id: string;
  slug: string;
  name: string;
  description?: string;
  dataClassification: ClassificationLevel;
  legalBasis: string;
  purpose: string;
  costCenter?: string;
  ownerPrincipalId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Politica efetiva consumida pelo inference-router.
 *
 * `version` permite ao router saber se o cache local envelheceu sem precisar
 * comparar o objeto inteiro.
 */
export interface ProjectPolicyView {
  projectId: string;
  dataClassification: ClassificationLevel;
  allowedDataZones: DataZone[];
  modelRules: { alias: string; allowed: boolean; maxOutputTokens?: number }[];
  maxConcurrentRequests: number;
  contentCapture: boolean;
  version: number;
  budget?: {
    currency: string;
    limitMicros: number;
    spentMicros: number;
    reservedMicros: number;
    blockAtLimit: boolean;
    periodEnd: Date;
  };
}

export interface BudgetView {
  projectId: string;
  currency: string;
  limitMicros: number;
  spentMicros: number;
  reservedMicros: number;
  period: 'daily' | 'monthly';
  periodStart: Date;
  periodEnd: Date;
  blockAtLimit: boolean;
  alertThresholds: number[];
  usageRatio: number;
}
