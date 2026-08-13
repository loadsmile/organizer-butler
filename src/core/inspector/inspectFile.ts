import type { OrganizerConfig } from "../../config/config.js";
import type { ScannedFile } from "../../domain/file.js";
import type { FileInspection, TextExtraction } from "../../domain/inspection.js";
import type { FileRegistry } from "../scanner/scanDownloads.js";
import { evaluateRules } from "../rules/rulesEngine.js";
import { inspectCsv } from "./inspectCsv.js";
import { inspectDocx } from "./inspectDocx.js";
import { inspectJson } from "./inspectJson.js";
import { inspectImage } from "./inspectImage.js";
import { inspectPdf } from "./inspectPdf.js";
import { inspectPptx } from "./inspectPptx.js";
import { inspectText } from "./inspectText.js";
import { inspectXlsx } from "./inspectXlsx.js";
import { inspectZip } from "./inspectZip.js";

type InspectionConfig = Pick<
  OrganizerConfig,
  | "maxExtractedTextLength"
  | "maxCsvSampledRows"
  | "maxCsvColumns"
  | "maxCsvFieldLength"
  | "maxJsonSourceBytes"
  | "maxJsonDepth"
  | "maxJsonObjectKeys"
  | "maxJsonArrayItems"
  | "maxJsonStringLength"
  | "maxZipArchiveSize"
  | "maxZipEntries"
  | "maxZipFilenameLength"
  | "maxZipMetadataRead"
  | "maxPdfSourceBytes"
  | "maxPdfObjects"
  | "maxPdfMetadataFields"
  | "maxPdfMetadataStringLength"
  | "maxXlsxSourceBytes"
  | "maxXlsxPackageEntries"
  | "maxXlsxCompressedMetadataBytes"
  | "maxXlsxUncompressedMetadataBytes"
  | "maxXlsxWorksheets"
  | "maxXlsxRetainedSheetNames"
  | "maxXlsxSheetNameLength"
  | "maxDocxSourceBytes"
  | "maxDocxPackageEntries"
  | "maxDocxCompressedMetadataBytes"
  | "maxDocxUncompressedMetadataBytes"
  | "maxDocxMetadataFields"
  | "maxDocxMetadataStringLength"
  | "maxPptxSourceBytes"
  | "maxPptxPackageEntries"
  | "maxPptxCompressedMetadataBytes"
  | "maxPptxUncompressedMetadataBytes"
  | "maxPptxSlides"
  | "maxPptxMetadataFields"
  | "maxPptxMetadataStringLength"
  | "maxImageSourceBytes"
  | "maxImageDimension"
  | "maxImagePixels"
  | "maxImageStructures"
  | "maxImageMetadataFields"
  | "maxImageMetadataStringLength"
>;

export async function inspectFile(
  registry: FileRegistry,
  fileId: string,
  config: InspectionConfig,
): Promise<FileInspection> {
  const resolved = await registry.resolve(fileId);
  let extraction: FileInspection["extraction"];
  try {
    extraction = await extractSupportedFile(resolved.path, resolved.extension, config);
  } catch (error) {
    await registry.resolve(fileId);
    throw error;
  }

  // Revalidation detects replacement or modification during inspection.
  await registry.resolve(fileId);

  const { path: _path, ...file } = resolved;
  return {
    file: file satisfies ScannedFile,
    extraction,
    ruleEvidence: evaluateRules(file),
  };
}

async function extractSupportedFile(
  filePath: string,
  extension: string,
  config: InspectionConfig,
): Promise<FileInspection["extraction"]> {
  const formats: Readonly<Record<string, TextExtraction["format"]>> = {
    ".md": "markdown",
    ".txt": "text",
  };
  const format = formats[extension];

  if (format !== undefined) {
    return inspectText(filePath, format, config.maxExtractedTextLength);
  }

  if (extension === ".csv") {
    return inspectCsv(filePath, {
      maxSampledRows: config.maxCsvSampledRows,
      maxColumns: config.maxCsvColumns,
      maxFieldLength: config.maxCsvFieldLength,
    });
  }

  if (extension === ".json") {
    return inspectJson(filePath, {
      maxSourceBytes: config.maxJsonSourceBytes,
      maxDepth: config.maxJsonDepth,
      maxObjectKeys: config.maxJsonObjectKeys,
      maxArrayItems: config.maxJsonArrayItems,
      maxStringLength: config.maxJsonStringLength,
    });
  }

  if (extension === ".zip") {
    return inspectZip(filePath, {
      maxArchiveSize: config.maxZipArchiveSize,
      maxEntries: config.maxZipEntries,
      maxFilenameLength: config.maxZipFilenameLength,
      maxMetadataRead: config.maxZipMetadataRead,
    });
  }

  if (extension === ".pdf") {
    return inspectPdf(filePath, {
      maxSourceBytes: config.maxPdfSourceBytes,
      maxObjects: config.maxPdfObjects,
      maxMetadataFields: config.maxPdfMetadataFields,
      maxMetadataStringLength: config.maxPdfMetadataStringLength,
    });
  }

  if (extension === ".xlsx") {
    return inspectXlsx(filePath, {
      maxSourceBytes: config.maxXlsxSourceBytes,
      maxPackageEntries: config.maxXlsxPackageEntries,
      maxCompressedMetadataBytes: config.maxXlsxCompressedMetadataBytes,
      maxUncompressedMetadataBytes: config.maxXlsxUncompressedMetadataBytes,
      maxWorksheets: config.maxXlsxWorksheets,
      maxRetainedSheetNames: config.maxXlsxRetainedSheetNames,
      maxSheetNameLength: config.maxXlsxSheetNameLength,
    });
  }

  if (extension === ".docx") {
    return inspectDocx(filePath, {
      maxSourceBytes: config.maxDocxSourceBytes,
      maxPackageEntries: config.maxDocxPackageEntries,
      maxCompressedMetadataBytes: config.maxDocxCompressedMetadataBytes,
      maxUncompressedMetadataBytes: config.maxDocxUncompressedMetadataBytes,
      maxMetadataFields: config.maxDocxMetadataFields,
      maxMetadataStringLength: config.maxDocxMetadataStringLength,
    });
  }

  if (extension === ".pptx") {
    return inspectPptx(filePath, {
      maxSourceBytes: config.maxPptxSourceBytes,
      maxPackageEntries: config.maxPptxPackageEntries,
      maxCompressedMetadataBytes: config.maxPptxCompressedMetadataBytes,
      maxUncompressedMetadataBytes: config.maxPptxUncompressedMetadataBytes,
      maxSlides: config.maxPptxSlides,
      maxMetadataFields: config.maxPptxMetadataFields,
      maxMetadataStringLength: config.maxPptxMetadataStringLength,
    });
  }

  if (extension === ".jpg" || extension === ".jpeg" || extension === ".png") {
    return inspectImage(filePath, extension === ".png" ? "png" : "jpeg", {
      maxSourceBytes: config.maxImageSourceBytes,
      maxDimension: config.maxImageDimension,
      maxPixels: config.maxImagePixels,
      maxStructures: config.maxImageStructures,
      maxMetadataFields: config.maxImageMetadataFields,
      maxMetadataStringLength: config.maxImageMetadataStringLength,
    });
  }

  return { status: "unsupported", reason: "UNSUPPORTED_FORMAT" };
}
