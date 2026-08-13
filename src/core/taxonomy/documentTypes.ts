import { z } from "zod";

export const documentTypes = [
  "invoice",
  "receipt",
  "statement",
  "contract",
  "reservation",
  "ticket",
  "research",
  "cv",
  "job-description",
  "presentation",
  "spreadsheet",
  "image",
  "code",
  "archive",
  "document",
  "installer",
  "other",
  "unknown",
] as const;

export const documentTypeSchema = z.enum(documentTypes);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const documentTypeDisplayNames: Record<DocumentType, string> = {
  invoice: "Invoices",
  receipt: "Receipts",
  statement: "Statements",
  contract: "Contracts",
  reservation: "Reservations",
  ticket: "Tickets",
  research: "Research",
  cv: "CVs",
  "job-description": "Job Descriptions",
  presentation: "Presentations",
  spreadsheet: "Spreadsheets",
  image: "Images",
  code: "Code",
  archive: "Archives",
  document: "Documents",
  installer: "Installers",
  other: "Other",
  unknown: "_Review",
};
