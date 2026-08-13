import type {
  RejectedXlsxExtraction,
  XlsxExtraction,
  XlsxSheetMetadata,
} from "../../domain/inspection.js";
import {
  OoxmlPackageError,
  type OoxmlPackageEntry,
  parseOoxmlPackage,
  readBoundedOoxmlSource,
  readOoxmlParts,
  requireOoxmlEntry,
} from "./ooxmlPackage.js";
import {
  opcAttribute,
  opcNamespacedAttribute,
  OpcXmlError,
  type OpcRelationship,
  opcRelationshipPartName,
  parseOpcContentTypes,
  parseOpcRelationships,
  parseOpcXml,
  resolveOpcRelationshipTarget,
} from "./opcXml.js";

type XlsxInspectionConfig = {
  maxSourceBytes: number;
  maxPackageEntries: number;
  maxCompressedMetadataBytes: number;
  maxUncompressedMetadataBytes: number;
  maxWorksheets: number;
  maxRetainedSheetNames: number;
  maxSheetNameLength: number;
};

type WorkbookSheet = { name: string; relationshipId: string };

const WORKBOOK_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const DOCUMENT_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set(
  [...DOCUMENT_RELATIONSHIP_NAMESPACES].map((namespace) => `${namespace}/officeDocument`),
);
const WORKSHEET_RELATIONSHIP_TYPES = new Set(
  [...DOCUMENT_RELATIONSHIP_NAMESPACES].map((namespace) => `${namespace}/worksheet`),
);
const WORKBOOK_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.ms-excel.sheet.main+xml",
]);
const MACRO_CONTENT_TYPES = new Set([
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  "application/vnd.ms-excel.template.macroEnabled.main+xml",
  "application/vnd.ms-office.vbaProject",
]);

class XlsxRejection extends Error {
  constructor(readonly reason: RejectedXlsxExtraction["reason"]) {
    super(reason);
  }
}

export async function inspectXlsx(
  filePath: string,
  config: XlsxInspectionConfig,
): Promise<XlsxExtraction | RejectedXlsxExtraction> {
  const source = await readBoundedOoxmlSource(filePath, config.maxSourceBytes, "XLSX");
  if (source === undefined) return rejected("XLSX_SOURCE_TOO_LARGE");

  try {
    const entries = parseOoxmlPackage(source, config.maxPackageEntries);
    const contentTypesEntry = requireOoxmlEntry(entries, "[Content_Types].xml");
    const rootRelationshipsEntry = requireOoxmlEntry(entries, "_rels/.rels");
    const initialParts = readMetadataParts(source, [contentTypesEntry, rootRelationshipsEntry], config);
    const contentTypes = parseContentTypes(initialParts[0]!);
    const rootRelationships = parseOpcRelationships(initialParts[1]!);

    const officeRelationships = rootRelationships.filter((item) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(item.type));
    if (officeRelationships.length !== 1) throw new XlsxRejection("MALFORMED_XLSX");
    const workbookPath = resolveOpcRelationshipTarget("", officeRelationships[0]!.target);
    const workbookContentType = contentTypes.get(workbookPath);
    if (workbookContentType === undefined) throw new XlsxRejection("MALFORMED_XLSX");
    if (MACRO_CONTENT_TYPES.has(workbookContentType)) throw new XlsxRejection("MACRO_ENABLED_XLSX");
    if (!WORKBOOK_CONTENT_TYPES.has(workbookContentType)) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }

    const workbookEntry = requireOoxmlEntry(entries, workbookPath);
    const workbookRelationshipsPath = opcRelationshipPartName(workbookPath);
    const workbookRelationshipsEntry = requireOoxmlEntry(entries, workbookRelationshipsPath);
    const allMetadataEntries = [
      contentTypesEntry,
      rootRelationshipsEntry,
      workbookEntry,
      workbookRelationshipsEntry,
    ];
    const parts = readMetadataParts(source, allMetadataEntries, config);
    const workbookRelationships = parseOpcRelationships(parts[3]!);
    const sheets = parseWorkbook(parts[2]!, config.maxWorksheets);
    validateSheetRelationships(sheets, workbookRelationships, workbookPath, entries);

    const retainedSheets = sheets.slice(0, config.maxRetainedSheetNames);
    let sheetNameStringsTruncated = false;
    const sheetMetadata = retainedSheets.map(({ name }): XlsxSheetMetadata => {
      const characters = [...name];
      const truncated = characters.length > config.maxSheetNameLength;
      sheetNameStringsTruncated ||= truncated;
      return { name: characters.slice(0, config.maxSheetNameLength).join(""), truncated };
    });

    return {
      status: "extracted",
      format: "xlsx",
      workbookFormat: "xlsx",
      sheets: sheetMetadata,
      sheetCount: sheets.length,
      sheetNamesTruncated: sheets.length > sheetMetadata.length,
      sheetNameStringsTruncated,
    };
  } catch (error) {
    if (error instanceof XlsxRejection) return rejected(error.reason);
    if (error instanceof OoxmlPackageError) return rejected(packageReason(error));
    if (error instanceof OpcXmlError) return rejected(opcReason(error));
    return rejected("MALFORMED_XLSX");
  }
}

function readMetadataParts(source: Buffer, entries: OoxmlPackageEntry[], config: XlsxInspectionConfig): Buffer[] {
  return readOoxmlParts(source, entries, {
    maxCompressedBytes: config.maxCompressedMetadataBytes,
    maxUncompressedBytes: config.maxUncompressedMetadataBytes,
  });
}

function parseContentTypes(source: Buffer): Map<string, string> {
  return parseOpcContentTypes(source, (contentType) => {
    if (MACRO_CONTENT_TYPES.has(contentType)) {
      throw new XlsxRejection("MACRO_ENABLED_XLSX");
    }
  });
}

function parseWorkbook(source: Buffer, maxWorksheets: number): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  parseOpcXml(source, {
    onOpenTag(tag) {
      if (!WORKBOOK_NAMESPACES.has(tag.uri)) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
      if (tag.local !== "sheet") return;
      const name = opcAttribute(tag, "name");
      const relationshipId = opcNamespacedAttribute(tag, DOCUMENT_RELATIONSHIP_NAMESPACES, "id");
      if (name === undefined || relationshipId === undefined || name.length === 0) {
        throw new XlsxRejection("MALFORMED_XLSX");
      }
      sheets.push({ name, relationshipId });
      if (sheets.length > maxWorksheets) throw new XlsxRejection("XLSX_WORKSHEET_LIMIT_EXCEEDED");
    },
  });
  return sheets;
}

function validateSheetRelationships(
  sheets: WorkbookSheet[],
  relationships: OpcRelationship[],
  workbookPath: string,
  entries: Map<string, OoxmlPackageEntry>,
): void {
  const byId = new Map(relationships.map((item) => [item.id, item]));
  const usedIds = new Set<string>();
  for (const sheet of sheets) {
    const relationship = byId.get(sheet.relationshipId);
    if (relationship === undefined || usedIds.has(sheet.relationshipId)) throw new XlsxRejection("MALFORMED_XLSX");
    if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type)) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    const target = resolveOpcRelationshipTarget(workbookPath, relationship.target);
    if (!entries.has(target)) throw new XlsxRejection("MALFORMED_XLSX");
    usedIds.add(sheet.relationshipId);
  }
}

function opcReason(error: OpcXmlError): RejectedXlsxExtraction["reason"] {
  const reasons: Record<typeof error.failure, RejectedXlsxExtraction["reason"]> = {
    malformed: "MALFORMED_XLSX",
    unsupported: "UNSUPPORTED_XLSX_FEATURE",
    "unsafe-relationship": "UNSAFE_XLSX_RELATIONSHIP",
    "duplicate-part": "DUPLICATE_XLSX_PART",
  };
  return reasons[error.failure];
}

function packageReason(error: OoxmlPackageError): RejectedXlsxExtraction["reason"] {
  const reasons: Record<typeof error.failure, RejectedXlsxExtraction["reason"]> = {
    malformed: "MALFORMED_XLSX",
    unsupported: "UNSUPPORTED_XLSX_FEATURE",
    encrypted: "ENCRYPTED_XLSX",
    "unsafe-entry-name": "UNSAFE_XLSX_ENTRY_NAME",
    "duplicate-part": "DUPLICATE_XLSX_PART",
    "macro-enabled": "MACRO_ENABLED_XLSX",
    "entry-limit": "XLSX_PACKAGE_ENTRY_LIMIT_EXCEEDED",
    "compressed-metadata-limit": "XLSX_COMPRESSED_METADATA_LIMIT_EXCEEDED",
    "uncompressed-metadata-limit": "XLSX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED",
  };
  return reasons[error.failure];
}

function rejected(reason: RejectedXlsxExtraction["reason"]): RejectedXlsxExtraction {
  return { status: "rejected", format: "xlsx", reason };
}
