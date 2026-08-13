import { z } from "zod";
import type {
  ClassificationProposal,
  ClassificationProposalResult,
} from "../../domain/classification.js";
import { OrganizerError } from "../../domain/error.js";
import type { FileInspection } from "../../domain/inspection.js";
import { areaSchema } from "../taxonomy/areas.js";
import { isCompatibleClassification } from "../taxonomy/classificationCompatibility.js";
import { documentTypeSchema } from "../taxonomy/documentTypes.js";
import { registerValidatedClassification } from "./classificationCapability.js";

export const submittedClassificationSchema = z
  .object({
    area: areaSchema,
    documentType: documentTypeSchema,
    rationale: z.string().max(1_000),
  })
  .strict();

export function validateSubmittedClassification(
  inspection: FileInspection,
  input: ClassificationProposal,
): ClassificationProposalResult {
  const parsed = submittedClassificationSchema.safeParse(input);
  if (!parsed.success || !isCompatibleClassification(parsed.data.area, parsed.data.documentType)) {
    throw new OrganizerError(
      "CLASSIFICATION_INVALID_SUBMISSION",
      "The submitted classification is invalid.",
    );
  }

  return registerValidatedClassification({
    fileId: inspection.file.fileId,
    proposal: parsed.data,
    ruleEvidence: inspection.ruleEvidence.map((evidence) => ({ ...evidence })),
  } as ClassificationProposalResult);
}
