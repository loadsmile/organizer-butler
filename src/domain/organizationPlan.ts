import type { Area } from "../core/taxonomy/areas.js";
import type { DocumentType } from "../core/taxonomy/documentTypes.js";

export type DestinationConflict = "none" | "existing-file" | "existing-directory" | "existing-other";

export type OrganizationPlanPreview = {
  planId: string;
  fileId: string;
  expiresAt: string;
  destination: {
    area: Area;
    documentType: DocumentType;
    areaDirectory: string;
    documentTypeDirectory: string;
    filename: string;
  };
  conflict: DestinationConflict;
};

export type OrganizationPlanConfirmation = {
  confirmationId: string;
  planId: string;
  fileId: string;
  expiresAt: string;
};

export type OrganizationExecutionResult = {
  confirmationId: string;
  planId: string;
  fileId: string;
  status: "completed";
};
