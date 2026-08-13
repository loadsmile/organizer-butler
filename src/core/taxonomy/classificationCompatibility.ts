import type { Area } from "./areas.js";
import type { DocumentType } from "./documentTypes.js";

export function isCompatibleClassification(area: Area, documentType: DocumentType): boolean {
  return (area === "unknown") === (documentType === "unknown");
}
