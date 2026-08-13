import type { Area } from "../core/taxonomy/areas.js";
import type { DocumentType } from "../core/taxonomy/documentTypes.js";
import type { RuleEvidence } from "./inspection.js";

declare const validatedClassificationProposal: unique symbol;

export type ClassificationProposal = {
  area: Area;
  documentType: DocumentType;
  rationale: string;
};

export type ClassificationProposalResult = {
  fileId: string;
  proposal: ClassificationProposal;
  ruleEvidence: RuleEvidence[];
  readonly [validatedClassificationProposal]: true;
};
