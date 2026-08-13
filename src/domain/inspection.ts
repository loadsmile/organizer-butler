import type { Area } from "../core/taxonomy/areas.js";
import type { DocumentType } from "../core/taxonomy/documentTypes.js";
import type { ScannedFile } from "./file.js";

export type RuleEvidence = {
  ruleId: string;
  source: "filename" | "extension";
  matchedValue: string;
  areaSignal?: Area;
  documentTypeSignal: DocumentType;
};

export type TextExtraction = {
  status: "extracted";
  format: "text" | "markdown";
  excerpt: string;
  extractedTextLength: number;
  truncated: boolean;
};

export type CsvExtraction = {
  status: "extracted";
  format: "csv";
  headers: string[];
  sampledRows: string[][];
  sampledRowCount: number;
  totalRowCount: number;
  rowsTruncated: boolean;
  columnsTruncated: boolean;
  fieldsTruncated: boolean;
};

export type MalformedCsvExtraction = {
  status: "malformed";
  format: "csv";
  reason: "MALFORMED_CSV";
};

export type JsonPreview =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: string }
  | { type: "string"; value: string; truncated: boolean }
  | { type: "array"; items: JsonPreview[]; totalItemCount: number; itemsTruncated: boolean }
  | {
      type: "object";
      entries: { key: string; keyTruncated: boolean; value: JsonPreview }[];
      totalKeyCount: number;
      keysTruncated: boolean;
    }
  | { type: "truncated"; reason: "MAX_DEPTH" };

export type JsonExtraction = {
  status: "extracted";
  format: "json";
  preview: JsonPreview;
  depthTruncated: boolean;
  objectKeysTruncated: boolean;
  arrayItemsTruncated: boolean;
  stringsTruncated: boolean;
};

export type RejectedJsonExtraction = {
  status: "rejected" | "malformed";
  format: "json";
  reason: "JSON_SOURCE_TOO_LARGE" | "JSON_NESTING_TOO_DEEP" | "MALFORMED_JSON" | "DUPLICATE_OBJECT_KEY";
};

export type ZipEntryMetadata = {
  filename: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
};

export type ZipExtraction = {
  status: "extracted";
  format: "zip";
  entries: ZipEntryMetadata[];
  entryCount: number;
};

export type RejectedZipExtraction = {
  status: "rejected";
  format: "zip";
  reason:
    | "ARCHIVE_TOO_LARGE"
    | "TOO_MANY_ENTRIES"
    | "ENTRY_NAME_TOO_LONG"
    | "METADATA_TOO_LARGE"
    | "ENCRYPTED_ZIP"
    | "MALFORMED_ZIP"
    | "MULTI_DISK_ZIP"
    | "ZIP64_UNSUPPORTED"
    | "UNSAFE_ENTRY_NAME"
    | "AMBIGUOUS_ENTRY_NAME";
};

export type PdfMetadataField = {
  key: "title" | "author" | "subject" | "keywords" | "creator" | "producer";
  value: string;
  truncated: boolean;
};

export type PdfExtraction = {
  status: "extracted";
  format: "pdf";
  version: string;
  pageCount: number;
  encrypted: false;
  metadata: PdfMetadataField[];
  metadataFieldsTruncated: boolean;
  metadataStringsTruncated: boolean;
};

export type RejectedPdfExtraction = {
  status: "rejected";
  format: "pdf";
  reason:
    | "PDF_SOURCE_TOO_LARGE"
    | "PDF_OBJECT_LIMIT_EXCEEDED"
    | "MALFORMED_PDF"
    | "ENCRYPTED_PDF"
    | "UNSUPPORTED_PDF_FEATURE";
};

export type XlsxSheetMetadata = {
  name: string;
  truncated: boolean;
};

export type XlsxCellPreview = {
  reference: string;
  type: "number" | "boolean" | "string";
  value: string | boolean;
  truncated: boolean;
};

export type XlsxRowPreview = {
  rowNumber: number;
  cells: XlsxCellPreview[];
  cellsTruncated: boolean;
};

export type XlsxSheetPreview = {
  sheetNumber: number;
  rows: XlsxRowPreview[];
  rowsTruncated: boolean;
  charactersTruncated: boolean;
};

export type XlsxExtraction = {
  status: "extracted";
  format: "xlsx";
  workbookFormat: "xlsx";
  sheets: XlsxSheetMetadata[];
  sheetCount: number;
  sheetNamesTruncated: boolean;
  sheetNameStringsTruncated: boolean;
  sheetPreviews: XlsxSheetPreview[];
  sheetPreviewsTruncated: boolean;
};

export type RejectedXlsxExtraction = {
  status: "rejected";
  format: "xlsx";
  reason:
    | "XLSX_SOURCE_TOO_LARGE"
    | "XLSX_PACKAGE_ENTRY_LIMIT_EXCEEDED"
    | "XLSX_COMPRESSED_METADATA_LIMIT_EXCEEDED"
    | "XLSX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED"
    | "XLSX_WORKSHEET_LIMIT_EXCEEDED"
    | "XLSX_WORKSHEET_PART_LIMIT_EXCEEDED"
    | "XLSX_WORKSHEET_STRUCTURE_LIMIT_EXCEEDED"
    | "XLSX_SHARED_STRING_STRUCTURE_LIMIT_EXCEEDED"
    | "ENCRYPTED_XLSX"
    | "MACRO_ENABLED_XLSX"
    | "MALFORMED_XLSX"
    | "UNSUPPORTED_XLSX_FEATURE"
    | "UNSAFE_XLSX_ENTRY_NAME"
    | "UNSAFE_XLSX_RELATIONSHIP"
    | "DUPLICATE_XLSX_PART";
};

export type DocxMetadataField = {
  key: "title" | "subject" | "creator" | "keywords" | "description" | "lastModifiedBy";
  value: string;
  truncated: boolean;
};

export type DocxExtraction = {
  status: "extracted";
  format: "docx";
  documentFormat: "docx";
  metadata: DocxMetadataField[];
  metadataFieldsTruncated: boolean;
  metadataStringsTruncated: boolean;
  bodyText: {
    paragraphs: string[];
    paragraphsTruncated: boolean;
    charactersTruncated: boolean;
  };
};

export type RejectedDocxExtraction = {
  status: "rejected";
  format: "docx";
  reason:
    | "DOCX_SOURCE_TOO_LARGE"
    | "DOCX_PACKAGE_ENTRY_LIMIT_EXCEEDED"
    | "DOCX_COMPRESSED_METADATA_LIMIT_EXCEEDED"
    | "DOCX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED"
    | "DOCX_BODY_PART_LIMIT_EXCEEDED"
    | "DOCX_BODY_STRUCTURE_LIMIT_EXCEEDED"
    | "ENCRYPTED_DOCX"
    | "MACRO_ENABLED_DOCX"
    | "MALFORMED_DOCX"
    | "UNSUPPORTED_DOCX_FEATURE"
    | "UNSAFE_DOCX_ENTRY_NAME"
    | "UNSAFE_DOCX_RELATIONSHIP"
    | "DUPLICATE_DOCX_PART";
};

export type PptxMetadataField = {
  key: "title" | "subject" | "creator" | "keywords" | "description" | "lastModifiedBy";
  value: string;
  truncated: boolean;
};

export type PptxSlidePreview = {
  slideNumber: number;
  textBlocks: string[];
  textBlocksTruncated: boolean;
  charactersTruncated: boolean;
};

export type PptxExtraction = {
  status: "extracted";
  format: "pptx";
  presentationFormat: "pptx";
  slideCount: number;
  metadata: PptxMetadataField[];
  metadataFieldsTruncated: boolean;
  metadataStringsTruncated: boolean;
  slides: PptxSlidePreview[];
  slidesTruncated: boolean;
};

export type RejectedPptxExtraction = {
  status: "rejected";
  format: "pptx";
  reason:
    | "PPTX_SOURCE_TOO_LARGE"
    | "PPTX_PACKAGE_ENTRY_LIMIT_EXCEEDED"
    | "PPTX_COMPRESSED_METADATA_LIMIT_EXCEEDED"
    | "PPTX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED"
    | "PPTX_SLIDE_LIMIT_EXCEEDED"
    | "PPTX_SLIDE_PART_LIMIT_EXCEEDED"
    | "PPTX_SLIDE_STRUCTURE_LIMIT_EXCEEDED"
    | "ENCRYPTED_PPTX"
    | "MACRO_ENABLED_PPTX"
    | "MALFORMED_PPTX"
    | "UNSUPPORTED_PPTX_FEATURE"
    | "UNSAFE_PPTX_ENTRY_NAME"
    | "UNSAFE_PPTX_RELATIONSHIP"
    | "DUPLICATE_PPTX_PART";
};

export type ImageMetadataField = {
  key: "title" | "author" | "description" | "copyright";
  value: string;
  truncated: boolean;
};

export type ImageExtraction = {
  status: "extracted";
  format: "jpeg" | "png";
  width: number;
  height: number;
  metadata: ImageMetadataField[];
  metadataFieldsTruncated: boolean;
  metadataStringsTruncated: boolean;
};

export type RejectedImageExtraction = {
  status: "rejected";
  format: "jpeg" | "png";
  reason:
    | "IMAGE_SOURCE_TOO_LARGE"
    | "IMAGE_DIMENSION_LIMIT_EXCEEDED"
    | "IMAGE_PIXEL_LIMIT_EXCEEDED"
    | "IMAGE_STRUCTURE_LIMIT_EXCEEDED"
    | "INVALID_IMAGE_DIMENSIONS"
    | "MALFORMED_JPEG"
    | "MALFORMED_PNG"
    | "UNSUPPORTED_JPEG_FEATURE"
    | "UNSUPPORTED_PNG_FEATURE";
};

export type UnsupportedExtraction = {
  status: "unsupported";
  reason: "UNSUPPORTED_FORMAT";
};

export type FileInspection = {
  file: ScannedFile;
  extraction:
    | TextExtraction
    | CsvExtraction
    | MalformedCsvExtraction
    | JsonExtraction
    | RejectedJsonExtraction
    | ZipExtraction
    | RejectedZipExtraction
    | PdfExtraction
    | RejectedPdfExtraction
    | XlsxExtraction
    | RejectedXlsxExtraction
    | DocxExtraction
    | RejectedDocxExtraction
    | PptxExtraction
    | RejectedPptxExtraction
    | ImageExtraction
    | RejectedImageExtraction
    | UnsupportedExtraction;
  ruleEvidence: RuleEvidence[];
};
