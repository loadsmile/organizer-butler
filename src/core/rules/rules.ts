import type { Area } from "../taxonomy/areas.js";
import type { DocumentType } from "../taxonomy/documentTypes.js";

export type FilenameRule = {
  id: string;
  source: "filename";
  pattern: RegExp;
  areaSignal?: Area;
  documentTypeSignal: DocumentType;
};

export type ExtensionRule = {
  id: string;
  source: "extension";
  extensions: readonly string[];
  areaSignal?: Area;
  documentTypeSignal: DocumentType;
};

export type RuleDefinition = FilenameRule | ExtensionRule;

export const rules: readonly RuleDefinition[] = [
  {
    id: "filename.invoice",
    source: "filename",
    pattern: /(?:^|[^a-z0-9])invoice(?:[^a-z0-9]|$)/i,
    areaSignal: "finance",
    documentTypeSignal: "invoice",
  },
  {
    id: "filename.receipt",
    source: "filename",
    pattern: /(?:^|[^a-z0-9])receipt(?:[^a-z0-9]|$)/i,
    areaSignal: "finance",
    documentTypeSignal: "receipt",
  },
  {
    id: "filename.boarding-pass",
    source: "filename",
    pattern: /(?:^|[^a-z0-9])boarding[\s_-]*pass(?:[^a-z0-9]|$)/i,
    areaSignal: "travel",
    documentTypeSignal: "ticket",
  },
  {
    id: "filename.bank-statement",
    source: "filename",
    pattern: /(?:^|[^a-z0-9])(?:bank[\s_-]*)?statement(?:[^a-z0-9]|$)/i,
    areaSignal: "finance",
    documentTypeSignal: "statement",
  },
  {
    id: "filename.reservation",
    source: "filename",
    pattern: /(?:^|[^a-z0-9])(?:reservation|itinerary|booking)(?:[^a-z0-9]|$)/i,
    areaSignal: "travel",
    documentTypeSignal: "reservation",
  },
  {
    id: "filename.cv-resume",
    source: "filename",
    pattern: /(?:^|[^a-z0-9])(?:cv|resume|résumé)(?:[^a-z0-9]|$)/i,
    areaSignal: "job-applications",
    documentTypeSignal: "cv",
  },
  {
    id: "extension.installer",
    source: "extension",
    extensions: [".dmg", ".pkg"],
    documentTypeSignal: "installer",
  },
  {
    id: "extension.archive",
    source: "extension",
    extensions: [".7z", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".zip"],
    documentTypeSignal: "archive",
  },
  {
    id: "extension.spreadsheet",
    source: "extension",
    extensions: [".csv", ".ods", ".xls", ".xlsx"],
    documentTypeSignal: "spreadsheet",
  },
  {
    id: "extension.presentation",
    source: "extension",
    extensions: [".ppt", ".pptx"],
    documentTypeSignal: "presentation",
  },
  {
    id: "extension.image",
    source: "extension",
    extensions: [".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".webp"],
    documentTypeSignal: "image",
  },
  {
    id: "extension.code",
    source: "extension",
    extensions: [".c", ".cpp", ".css", ".go", ".html", ".java", ".js", ".jsx", ".py", ".rb", ".rs", ".sh", ".ts", ".tsx"],
    areaSignal: "coding",
    documentTypeSignal: "code",
  },
] as const;
