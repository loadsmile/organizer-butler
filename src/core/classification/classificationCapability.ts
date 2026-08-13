import type { ClassificationProposalResult } from "../../domain/classification.js";

const validatedProposals = new WeakSet<object>();

export function registerValidatedClassification(
  classification: ClassificationProposalResult,
): ClassificationProposalResult {
  validatedProposals.add(classification);
  return classification;
}

export function isValidatedClassification(value: ClassificationProposalResult): boolean {
  return validatedProposals.has(value);
}
