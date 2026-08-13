import type { Area } from "../taxonomy/areas.js";
import type { DocumentType } from "../taxonomy/documentTypes.js";

export const areaDirectories: Record<Area, string> = {
  work: "Work",
  coding: "Coding",
  finance: "Finance",
  health: "Health",
  travel: "Travel",
  "job-applications": "Job Applications",
  personal: "Personal",
  other: "Other",
  unknown: "_Review",
};

export const documentTypeDirectories: Record<DocumentType, string> = {
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
