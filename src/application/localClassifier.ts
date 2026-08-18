import { z } from "zod";
import { areaSchema, areas } from "../core/taxonomy/areas.js";
import { isCompatibleClassification } from "../core/taxonomy/classificationCompatibility.js";
import { documentTypeSchema, documentTypes } from "../core/taxonomy/documentTypes.js";
import type { FileInspection } from "../domain/inspection.js";

export const localClassifierPolicy = {
  confidenceThreshold: 0.75,
  maxFilenameLength: 1_024,
  maxExtensionLength: 64,
  maxMimeTypeLength: 255,
  maxExtractionLength: 16_384,
  maxRuleEvidenceItems: 32,
  maxRuleIdLength: 128,
  maxMatchedValueLength: 512,
  maxRationaleLength: 1_000,
} as const;

const classifierFormats = [
  "text",
  "markdown",
  "csv",
  "json",
  "zip",
  "pdf",
  "xlsx",
  "docx",
  "pptx",
  "jpeg",
  "png",
  "unsupported",
] as const;

const safeFileMetadataSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(localClassifierPolicy.maxFilenameLength)
      .refine((value) => !value.includes("/") && !value.includes("\\")),
    extension: z.string().max(localClassifierPolicy.maxExtensionLength),
    mimeType: z.string().min(1).max(localClassifierPolicy.maxMimeTypeLength),
    size: z.number().int().nonnegative().finite(),
    modifiedAt: z.iso.datetime(),
  })
  .strict();

const boundedInspectionExtractionSchema = z
  .object({
    status: z.enum(["extracted", "rejected", "malformed", "unsupported"]),
    format: z.enum(classifierFormats),
    content: z.string().max(localClassifierPolicy.maxExtractionLength),
    truncated: z.boolean(),
  })
  .strict();

const trustedRuleEvidenceSchema = z
  .object({
    ruleId: z.string().min(1).max(localClassifierPolicy.maxRuleIdLength),
    source: z.enum(["filename", "extension"]),
    matchedValue: z.string().max(localClassifierPolicy.maxMatchedValueLength),
    areaSignal: areaSchema.optional(),
    documentTypeSignal: documentTypeSchema,
  })
  .strict();

const classifierTaxonomySchema = z
  .object({
    areas: z.array(areaSchema).length(areas.length),
    documentTypes: z.array(documentTypeSchema).length(documentTypes.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (!sameValues(value.areas, areas)) {
      context.addIssue({ code: "custom", message: "The area taxonomy must be exact." });
    }
    if (!sameValues(value.documentTypes, documentTypes)) {
      context.addIssue({ code: "custom", message: "The document-type taxonomy must be exact." });
    }
  });

const classifierLimitsSchema = z
  .object({
    confidenceThreshold: z.literal(localClassifierPolicy.confidenceThreshold),
    maxExtractionLength: z.literal(localClassifierPolicy.maxExtractionLength),
    maxRationaleLength: z.literal(localClassifierPolicy.maxRationaleLength),
  })
  .strict();

export const localClassifierInputSchema = z
  .object({
    file: safeFileMetadataSchema,
    extraction: boundedInspectionExtractionSchema,
    ruleEvidence: z.array(trustedRuleEvidenceSchema).max(localClassifierPolicy.maxRuleEvidenceItems),
    taxonomy: classifierTaxonomySchema,
    limits: classifierLimitsSchema,
  })
  .strict();

export const localClassifierCandidateSchema = z
  .object({
    area: areaSchema,
    documentType: documentTypeSchema,
    confidence: z.number().finite().min(0).max(1),
    rationale: z.string().max(localClassifierPolicy.maxRationaleLength),
  })
  .strict()
  .refine((value) => isCompatibleClassification(value.area, value.documentType));

export const localClassifierOutputSchema = z
  .object({
    area: areaSchema,
    documentType: documentTypeSchema,
    confidence: z.number().finite().min(0).max(1),
    rationale: z.string().max(localClassifierPolicy.maxRationaleLength),
    reviewRouting: z.enum(["accepted", "review-required"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isCompatibleClassification(value.area, value.documentType)) {
      context.addIssue({ code: "custom", message: "The classification is incompatible." });
    }
    if (
      value.reviewRouting === "accepted" &&
      (value.confidence < localClassifierPolicy.confidenceThreshold || value.area === "unknown")
    ) {
      context.addIssue({ code: "custom", message: "The classification requires review." });
    }
    if (
      value.reviewRouting === "review-required" &&
      (value.area !== "unknown" || value.documentType !== "unknown")
    ) {
      context.addIssue({ code: "custom", message: "Review must use the review taxonomy." });
    }
  });

export type LocalClassifierInput = z.infer<typeof localClassifierInputSchema>;
export type LocalClassifierCandidate = z.infer<typeof localClassifierCandidateSchema>;
export type LocalClassifierOutput = z.infer<typeof localClassifierOutputSchema>;

export interface LocalClassifier {
  classify(input: LocalClassifierInput): Promise<LocalClassifierOutput>;
}

export function classifierInputFromInspection(inspection: FileInspection): LocalClassifierInput {
  const normalized = normalizeExtraction(inspection.extraction);
  const content = normalized.content.slice(0, localClassifierPolicy.maxExtractionLength);
  return localClassifierInputSchema.parse({
    file: {
      filename: inspection.file.filename,
      extension: inspection.file.extension,
      mimeType: inspection.file.mimeType,
      size: inspection.file.size,
      modifiedAt: inspection.file.modifiedAt,
    },
    extraction: {
      status: normalized.status,
      format: normalized.format,
      content,
      truncated: normalized.truncated || content.length < normalized.content.length,
    },
    ruleEvidence: inspection.ruleEvidence.map((evidence) => ({
      ruleId: evidence.ruleId,
      source: evidence.source,
      matchedValue: evidence.matchedValue,
      ...(evidence.areaSignal ? { areaSignal: evidence.areaSignal } : {}),
      documentTypeSignal: evidence.documentTypeSignal,
    })),
    taxonomy: localClassifierTaxonomy(),
    limits: localClassifierLimits(),
  });
}

export function routeLocalClassifierCandidate(candidate: unknown): LocalClassifierOutput {
  const parsed = localClassifierCandidateSchema.parse(candidate);
  const reviewRequired =
    parsed.confidence < localClassifierPolicy.confidenceThreshold || parsed.area === "unknown";

  return localClassifierOutputSchema.parse({
    ...parsed,
    area: reviewRequired ? "unknown" : parsed.area,
    documentType: reviewRequired ? "unknown" : parsed.documentType,
    reviewRouting: reviewRequired ? "review-required" : "accepted",
  });
}

export function localClassifierTaxonomy(): LocalClassifierInput["taxonomy"] {
  return { areas: [...areas], documentTypes: [...documentTypes] };
}

export function localClassifierLimits(): LocalClassifierInput["limits"] {
  return {
    confidenceThreshold: localClassifierPolicy.confidenceThreshold,
    maxExtractionLength: localClassifierPolicy.maxExtractionLength,
    maxRationaleLength: localClassifierPolicy.maxRationaleLength,
  };
}

function sameValues<T>(actual: T[], expected: readonly T[]): boolean {
  return actual.every((value, index) => value === expected[index]);
}

type NormalizedExtraction = LocalClassifierInput["extraction"];

function normalizeExtraction(extraction: FileInspection["extraction"]): NormalizedExtraction {
  if (extraction.status !== "extracted") {
    return {
      status: extraction.status,
      format: "format" in extraction ? extraction.format : "unsupported",
      content: extraction.reason,
      truncated: false,
    };
  }

  switch (extraction.format) {
    case "text":
    case "markdown":
      return {
        status: "extracted",
        format: extraction.format,
        content: extraction.excerpt,
        truncated: extraction.truncated,
      };
    case "csv":
      return normalizedJson("csv", {
        headers: extraction.headers,
        sampledRows: extraction.sampledRows,
        totalRowCount: extraction.totalRowCount,
      }, extraction.rowsTruncated || extraction.columnsTruncated || extraction.fieldsTruncated);
    case "json":
      return normalizedJson("json", extraction.preview,
        extraction.depthTruncated || extraction.objectKeysTruncated ||
        extraction.arrayItemsTruncated || extraction.stringsTruncated);
    case "zip":
      return normalizedJson("zip", {
        entryCount: extraction.entryCount,
        entries: extraction.entries.map((entry) => ({
          filename: entry.filename,
          isDirectory: entry.isDirectory,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
        })),
      }, false);
    case "pdf":
      return normalizedJson("pdf", {
        version: extraction.version,
        pageCount: extraction.pageCount,
        metadata: extraction.metadata.map(({ key, value }) => ({ key, value })),
      }, extraction.metadataFieldsTruncated || extraction.metadataStringsTruncated);
    case "xlsx":
      return normalizedJson("xlsx", {
        sheetCount: extraction.sheetCount,
        sheets: extraction.sheets.map(({ name }) => name),
        sheetPreviews: extraction.sheetPreviews.map((sheet) => ({
          sheetNumber: sheet.sheetNumber,
          rows: sheet.rows.map((row) => ({
            rowNumber: row.rowNumber,
            cells: row.cells.map(({ reference, type, value }) => ({ reference, type, value })),
          })),
        })),
      }, extraction.sheetNamesTruncated || extraction.sheetNameStringsTruncated ||
        extraction.sheetPreviewsTruncated || extraction.sheetPreviews.some((sheet) =>
          sheet.rowsTruncated || sheet.charactersTruncated || sheet.rows.some((row) =>
            row.cellsTruncated || row.cells.some((cell) => cell.truncated))));
    case "docx":
      return normalizedJson("docx", {
        metadata: extraction.metadata.map(({ key, value }) => ({ key, value })),
        paragraphs: extraction.bodyText.paragraphs,
      }, extraction.metadataFieldsTruncated || extraction.metadataStringsTruncated ||
        extraction.bodyText.paragraphsTruncated || extraction.bodyText.charactersTruncated);
    case "pptx":
      return normalizedJson("pptx", {
        slideCount: extraction.slideCount,
        metadata: extraction.metadata.map(({ key, value }) => ({ key, value })),
        slides: extraction.slides.map(({ slideNumber, textBlocks }) => ({ slideNumber, textBlocks })),
      }, extraction.metadataFieldsTruncated || extraction.metadataStringsTruncated ||
        extraction.slidesTruncated || extraction.slides.some((slide) =>
          slide.textBlocksTruncated || slide.charactersTruncated));
    case "jpeg":
    case "png":
      return normalizedJson(extraction.format, {
        width: extraction.width,
        height: extraction.height,
        metadata: extraction.metadata.map(({ key, value }) => ({ key, value })),
      }, extraction.metadataFieldsTruncated || extraction.metadataStringsTruncated);
  }
}

function normalizedJson(
  format: NormalizedExtraction["format"],
  value: unknown,
  truncated: boolean,
): NormalizedExtraction {
  return { status: "extracted", format, content: JSON.stringify(value), truncated };
}
