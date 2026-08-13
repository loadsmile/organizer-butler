import os from "node:os";
import path from "node:path";
import { z } from "zod";

export type OrganizerConfig = {
  downloadsDirectory: string;
  organizationRoot: string;
  databasePath: string;
  maxExtractedTextLength: number;
  maxCsvSampledRows: number;
  maxCsvColumns: number;
  maxCsvFieldLength: number;
  maxJsonSourceBytes: number;
  maxJsonDepth: number;
  maxJsonObjectKeys: number;
  maxJsonArrayItems: number;
  maxJsonStringLength: number;
  maxZipArchiveSize: number;
  maxZipEntries: number;
  maxZipFilenameLength: number;
  maxZipMetadataRead: number;
  maxPdfSourceBytes: number;
  maxPdfObjects: number;
  maxPdfMetadataFields: number;
  maxPdfMetadataStringLength: number;
  maxXlsxSourceBytes: number;
  maxXlsxPackageEntries: number;
  maxXlsxCompressedMetadataBytes: number;
  maxXlsxUncompressedMetadataBytes: number;
  maxXlsxWorksheets: number;
  maxXlsxRetainedSheetNames: number;
  maxXlsxSheetNameLength: number;
  maxXlsxWorksheetParts: number;
  maxXlsxRetainedSheets: number;
  maxXlsxRowsPerSheet: number;
  maxXlsxCellsPerRow: number;
  maxXlsxCharacters: number;
  maxXlsxSharedStringStructures: number;
  maxXlsxWorksheetStructures: number;
  maxDocxSourceBytes: number;
  maxDocxPackageEntries: number;
  maxDocxCompressedMetadataBytes: number;
  maxDocxUncompressedMetadataBytes: number;
  maxDocxMetadataFields: number;
  maxDocxMetadataStringLength: number;
  maxDocxBodyParts: number;
  maxDocxBodyCharacters: number;
  maxDocxBodyParagraphs: number;
  maxDocxBodyStructures: number;
  maxPptxSourceBytes: number;
  maxPptxPackageEntries: number;
  maxPptxCompressedMetadataBytes: number;
  maxPptxUncompressedMetadataBytes: number;
  maxPptxSlides: number;
  maxPptxMetadataFields: number;
  maxPptxMetadataStringLength: number;
  maxPptxSlideParts: number;
  maxPptxRetainedSlides: number;
  maxPptxSlideCharacters: number;
  maxPptxTextBlocksPerSlide: number;
  maxPptxSlideStructures: number;
  maxImageSourceBytes: number;
  maxImageDimension: number;
  maxImagePixels: number;
  maxImageStructures: number;
  maxImageMetadataFields: number;
  maxImageMetadataStringLength: number;
  maxPlanPathBytes: number;
  planExpiryMs: number;
  confirmationExpiryMs: number;
  directoryPlanExpiryMs: number;
  directoryConfirmationExpiryMs: number;
  invalidatedExecutionRetentionMs: number;
  expiredExecutionRetentionMs: number;
  completedExecutionReplayRetentionMs: number;
  executionRecoveryLeaseMs: number;
};

const environmentSchema = z.object({
  ORGANIZER_DOWNLOADS_DIRECTORY: z.string().min(1).optional(),
  ORGANIZER_ROOT: z.string().min(1).optional(),
  ORGANIZER_DATABASE_PATH: z.string().min(1).optional(),
  ORGANIZER_MAX_EXTRACTED_TEXT_LENGTH: z.coerce.number().int().positive().max(100_000).optional(),
  ORGANIZER_MAX_CSV_SAMPLED_ROWS: z.coerce.number().int().nonnegative().max(1_000).optional(),
  ORGANIZER_MAX_CSV_COLUMNS: z.coerce.number().int().positive().max(1_000).optional(),
  ORGANIZER_MAX_CSV_FIELD_LENGTH: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_JSON_SOURCE_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_JSON_DEPTH: z.coerce.number().int().nonnegative().max(100).optional(),
  ORGANIZER_MAX_JSON_OBJECT_KEYS: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_JSON_ARRAY_ITEMS: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_JSON_STRING_LENGTH: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_ZIP_ARCHIVE_SIZE: z.coerce.number().int().positive().max(10_000_000_000).optional(),
  ORGANIZER_MAX_ZIP_ENTRIES: z.coerce.number().int().nonnegative().max(65_535).optional(),
  ORGANIZER_MAX_ZIP_FILENAME_LENGTH: z.coerce.number().int().positive().max(65_535).optional(),
  ORGANIZER_MAX_ZIP_METADATA_READ: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_PDF_SOURCE_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_PDF_OBJECTS: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_MAX_PDF_METADATA_FIELDS: z.coerce.number().int().nonnegative().max(6).optional(),
  ORGANIZER_MAX_PDF_METADATA_STRING_LENGTH: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_XLSX_SOURCE_BYTES: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  ORGANIZER_MAX_XLSX_PACKAGE_ENTRIES: z.coerce.number().int().positive().max(65_535).optional(),
  ORGANIZER_MAX_XLSX_COMPRESSED_METADATA_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_XLSX_UNCOMPRESSED_METADATA_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_XLSX_WORKSHEETS: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_XLSX_RETAINED_SHEET_NAMES: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_XLSX_SHEET_NAME_LENGTH: z.coerce.number().int().nonnegative().max(32_767).optional(),
  ORGANIZER_MAX_XLSX_WORKSHEET_PARTS: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_XLSX_RETAINED_SHEETS: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_XLSX_ROWS_PER_SHEET: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_XLSX_CELLS_PER_ROW: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_XLSX_CHARACTERS: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
  ORGANIZER_MAX_XLSX_SHARED_STRING_STRUCTURES: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_MAX_XLSX_WORKSHEET_STRUCTURES: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_MAX_DOCX_SOURCE_BYTES: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  ORGANIZER_MAX_DOCX_PACKAGE_ENTRIES: z.coerce.number().int().positive().max(65_535).optional(),
  ORGANIZER_MAX_DOCX_COMPRESSED_METADATA_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_DOCX_UNCOMPRESSED_METADATA_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_DOCX_METADATA_FIELDS: z.coerce.number().int().nonnegative().max(6).optional(),
  ORGANIZER_MAX_DOCX_METADATA_STRING_LENGTH: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_DOCX_BODY_PARTS: z.coerce.number().int().nonnegative().max(1).optional(),
  ORGANIZER_MAX_DOCX_BODY_CHARACTERS: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
  ORGANIZER_MAX_DOCX_BODY_PARAGRAPHS: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_DOCX_BODY_STRUCTURES: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_MAX_PPTX_SOURCE_BYTES: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  ORGANIZER_MAX_PPTX_PACKAGE_ENTRIES: z.coerce.number().int().positive().max(65_535).optional(),
  ORGANIZER_MAX_PPTX_COMPRESSED_METADATA_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_PPTX_UNCOMPRESSED_METADATA_BYTES: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORGANIZER_MAX_PPTX_SLIDES: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_PPTX_METADATA_FIELDS: z.coerce.number().int().nonnegative().max(6).optional(),
  ORGANIZER_MAX_PPTX_METADATA_STRING_LENGTH: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_PPTX_SLIDE_PARTS: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_PPTX_RETAINED_SLIDES: z.coerce.number().int().nonnegative().max(10_000).optional(),
  ORGANIZER_MAX_PPTX_SLIDE_CHARACTERS: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
  ORGANIZER_MAX_PPTX_TEXT_BLOCKS_PER_SLIDE: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_PPTX_SLIDE_STRUCTURES: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_MAX_IMAGE_SOURCE_BYTES: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  ORGANIZER_MAX_IMAGE_DIMENSION: z.coerce.number().int().positive().max(0xffffffff).optional(),
  ORGANIZER_MAX_IMAGE_PIXELS: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  ORGANIZER_MAX_IMAGE_STRUCTURES: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_MAX_IMAGE_METADATA_FIELDS: z.coerce.number().int().nonnegative().max(4).optional(),
  ORGANIZER_MAX_IMAGE_METADATA_STRING_LENGTH: z.coerce.number().int().nonnegative().max(100_000).optional(),
  ORGANIZER_MAX_PLAN_PATH_BYTES: z.coerce.number().int().positive().max(1_000_000).optional(),
  ORGANIZER_PLAN_EXPIRY_MS: z.coerce.number().int().positive().max(86_400_000).optional(),
  ORGANIZER_CONFIRMATION_EXPIRY_MS: z.coerce.number().int().positive().max(3_600_000).optional(),
  ORGANIZER_DIRECTORY_PLAN_EXPIRY_MS: z.coerce.number().int().positive().max(86_400_000).optional(),
  ORGANIZER_DIRECTORY_CONFIRMATION_EXPIRY_MS: z.coerce.number().int().positive().max(3_600_000).optional(),
  ORGANIZER_INVALIDATED_EXECUTION_RETENTION_MS: z.coerce.number().int().positive().max(315_360_000_000).optional(),
  ORGANIZER_EXPIRED_EXECUTION_RETENTION_MS: z.coerce.number().int().positive().max(315_360_000_000).optional(),
  ORGANIZER_COMPLETED_EXECUTION_REPLAY_RETENTION_MS: z.coerce.number().int().positive().max(315_360_000_000).optional(),
  ORGANIZER_EXECUTION_RECOVERY_LEASE_MS: z.coerce.number().int().positive().max(60_000).optional(),
});

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): OrganizerConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    downloadsDirectory: path.resolve(expandHome(parsed.ORGANIZER_DOWNLOADS_DIRECTORY ?? "~/Downloads")),
    organizationRoot: path.resolve(expandHome(parsed.ORGANIZER_ROOT ?? "~/Downloads")),
    databasePath: path.resolve(
      expandHome(parsed.ORGANIZER_DATABASE_PATH ?? "~/.local/share/organizer-butler/actions.db"),
    ),
    maxExtractedTextLength: parsed.ORGANIZER_MAX_EXTRACTED_TEXT_LENGTH ?? 6_000,
    maxCsvSampledRows: parsed.ORGANIZER_MAX_CSV_SAMPLED_ROWS ?? 20,
    maxCsvColumns: parsed.ORGANIZER_MAX_CSV_COLUMNS ?? 50,
    maxCsvFieldLength: parsed.ORGANIZER_MAX_CSV_FIELD_LENGTH ?? 1_000,
    maxJsonSourceBytes: parsed.ORGANIZER_MAX_JSON_SOURCE_BYTES ?? 1_000_000,
    maxJsonDepth: parsed.ORGANIZER_MAX_JSON_DEPTH ?? 8,
    maxJsonObjectKeys: parsed.ORGANIZER_MAX_JSON_OBJECT_KEYS ?? 50,
    maxJsonArrayItems: parsed.ORGANIZER_MAX_JSON_ARRAY_ITEMS ?? 50,
    maxJsonStringLength: parsed.ORGANIZER_MAX_JSON_STRING_LENGTH ?? 1_000,
    maxZipArchiveSize: parsed.ORGANIZER_MAX_ZIP_ARCHIVE_SIZE ?? 100_000_000,
    maxZipEntries: parsed.ORGANIZER_MAX_ZIP_ENTRIES ?? 1_000,
    maxZipFilenameLength: parsed.ORGANIZER_MAX_ZIP_FILENAME_LENGTH ?? 512,
    maxZipMetadataRead: parsed.ORGANIZER_MAX_ZIP_METADATA_READ ?? 1_000_000,
    maxPdfSourceBytes: parsed.ORGANIZER_MAX_PDF_SOURCE_BYTES ?? 10_000_000,
    maxPdfObjects: parsed.ORGANIZER_MAX_PDF_OBJECTS ?? 100_000,
    maxPdfMetadataFields: parsed.ORGANIZER_MAX_PDF_METADATA_FIELDS ?? 6,
    maxPdfMetadataStringLength: parsed.ORGANIZER_MAX_PDF_METADATA_STRING_LENGTH ?? 1_000,
    maxXlsxSourceBytes: parsed.ORGANIZER_MAX_XLSX_SOURCE_BYTES ?? 50_000_000,
    maxXlsxPackageEntries: parsed.ORGANIZER_MAX_XLSX_PACKAGE_ENTRIES ?? 2_000,
    maxXlsxCompressedMetadataBytes: parsed.ORGANIZER_MAX_XLSX_COMPRESSED_METADATA_BYTES ?? 1_000_000,
    maxXlsxUncompressedMetadataBytes: parsed.ORGANIZER_MAX_XLSX_UNCOMPRESSED_METADATA_BYTES ?? 5_000_000,
    maxXlsxWorksheets: parsed.ORGANIZER_MAX_XLSX_WORKSHEETS ?? 1_000,
    maxXlsxRetainedSheetNames: parsed.ORGANIZER_MAX_XLSX_RETAINED_SHEET_NAMES ?? 100,
    maxXlsxSheetNameLength: parsed.ORGANIZER_MAX_XLSX_SHEET_NAME_LENGTH ?? 128,
    maxXlsxWorksheetParts: parsed.ORGANIZER_MAX_XLSX_WORKSHEET_PARTS ?? 1_000,
    maxXlsxRetainedSheets: parsed.ORGANIZER_MAX_XLSX_RETAINED_SHEETS ?? 100,
    maxXlsxRowsPerSheet: parsed.ORGANIZER_MAX_XLSX_ROWS_PER_SHEET ?? 100,
    maxXlsxCellsPerRow: parsed.ORGANIZER_MAX_XLSX_CELLS_PER_ROW ?? 100,
    maxXlsxCharacters: parsed.ORGANIZER_MAX_XLSX_CHARACTERS ?? 6_000,
    maxXlsxSharedStringStructures: parsed.ORGANIZER_MAX_XLSX_SHARED_STRING_STRUCTURES ?? 100_000,
    maxXlsxWorksheetStructures: parsed.ORGANIZER_MAX_XLSX_WORKSHEET_STRUCTURES ?? 100_000,
    maxDocxSourceBytes: parsed.ORGANIZER_MAX_DOCX_SOURCE_BYTES ?? 50_000_000,
    maxDocxPackageEntries: parsed.ORGANIZER_MAX_DOCX_PACKAGE_ENTRIES ?? 2_000,
    maxDocxCompressedMetadataBytes: parsed.ORGANIZER_MAX_DOCX_COMPRESSED_METADATA_BYTES ?? 1_000_000,
    maxDocxUncompressedMetadataBytes: parsed.ORGANIZER_MAX_DOCX_UNCOMPRESSED_METADATA_BYTES ?? 5_000_000,
    maxDocxMetadataFields: parsed.ORGANIZER_MAX_DOCX_METADATA_FIELDS ?? 6,
    maxDocxMetadataStringLength: parsed.ORGANIZER_MAX_DOCX_METADATA_STRING_LENGTH ?? 1_000,
    maxDocxBodyParts: parsed.ORGANIZER_MAX_DOCX_BODY_PARTS ?? 1,
    maxDocxBodyCharacters: parsed.ORGANIZER_MAX_DOCX_BODY_CHARACTERS ?? 6_000,
    maxDocxBodyParagraphs: parsed.ORGANIZER_MAX_DOCX_BODY_PARAGRAPHS ?? 100,
    maxDocxBodyStructures: parsed.ORGANIZER_MAX_DOCX_BODY_STRUCTURES ?? 100_000,
    maxPptxSourceBytes: parsed.ORGANIZER_MAX_PPTX_SOURCE_BYTES ?? 50_000_000,
    maxPptxPackageEntries: parsed.ORGANIZER_MAX_PPTX_PACKAGE_ENTRIES ?? 2_000,
    maxPptxCompressedMetadataBytes: parsed.ORGANIZER_MAX_PPTX_COMPRESSED_METADATA_BYTES ?? 1_000_000,
    maxPptxUncompressedMetadataBytes: parsed.ORGANIZER_MAX_PPTX_UNCOMPRESSED_METADATA_BYTES ?? 5_000_000,
    maxPptxSlides: parsed.ORGANIZER_MAX_PPTX_SLIDES ?? 1_000,
    maxPptxMetadataFields: parsed.ORGANIZER_MAX_PPTX_METADATA_FIELDS ?? 6,
    maxPptxMetadataStringLength: parsed.ORGANIZER_MAX_PPTX_METADATA_STRING_LENGTH ?? 1_000,
    maxPptxSlideParts: parsed.ORGANIZER_MAX_PPTX_SLIDE_PARTS ?? 1_000,
    maxPptxRetainedSlides: parsed.ORGANIZER_MAX_PPTX_RETAINED_SLIDES ?? 100,
    maxPptxSlideCharacters: parsed.ORGANIZER_MAX_PPTX_SLIDE_CHARACTERS ?? 6_000,
    maxPptxTextBlocksPerSlide: parsed.ORGANIZER_MAX_PPTX_TEXT_BLOCKS_PER_SLIDE ?? 100,
    maxPptxSlideStructures: parsed.ORGANIZER_MAX_PPTX_SLIDE_STRUCTURES ?? 100_000,
    maxImageSourceBytes: parsed.ORGANIZER_MAX_IMAGE_SOURCE_BYTES ?? 50_000_000,
    maxImageDimension: parsed.ORGANIZER_MAX_IMAGE_DIMENSION ?? 32_768,
    maxImagePixels: parsed.ORGANIZER_MAX_IMAGE_PIXELS ?? 100_000_000,
    maxImageStructures: parsed.ORGANIZER_MAX_IMAGE_STRUCTURES ?? 10_000,
    maxImageMetadataFields: parsed.ORGANIZER_MAX_IMAGE_METADATA_FIELDS ?? 4,
    maxImageMetadataStringLength: parsed.ORGANIZER_MAX_IMAGE_METADATA_STRING_LENGTH ?? 1_000,
    maxPlanPathBytes: parsed.ORGANIZER_MAX_PLAN_PATH_BYTES ?? 4_096,
    planExpiryMs: parsed.ORGANIZER_PLAN_EXPIRY_MS ?? 600_000,
    confirmationExpiryMs: parsed.ORGANIZER_CONFIRMATION_EXPIRY_MS ?? 300_000,
    directoryPlanExpiryMs: parsed.ORGANIZER_DIRECTORY_PLAN_EXPIRY_MS ?? 600_000,
    directoryConfirmationExpiryMs: parsed.ORGANIZER_DIRECTORY_CONFIRMATION_EXPIRY_MS ?? 300_000,
    invalidatedExecutionRetentionMs: parsed.ORGANIZER_INVALIDATED_EXECUTION_RETENTION_MS ?? 2_592_000_000,
    expiredExecutionRetentionMs: parsed.ORGANIZER_EXPIRED_EXECUTION_RETENTION_MS ?? 2_592_000_000,
    completedExecutionReplayRetentionMs: parsed.ORGANIZER_COMPLETED_EXECUTION_REPLAY_RETENTION_MS ?? 31_536_000_000,
    executionRecoveryLeaseMs: parsed.ORGANIZER_EXECUTION_RECOVERY_LEASE_MS ?? 30_000,
  };
}
