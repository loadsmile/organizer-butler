import { open } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { OrganizerError } from "../../domain/error.js";
import type {
  RejectedXlsxExtraction,
  XlsxExtraction,
  XlsxSheetMetadata,
} from "../../domain/inspection.js";

type XlsxInspectionConfig = {
  maxSourceBytes: number;
  maxPackageEntries: number;
  maxCompressedMetadataBytes: number;
  maxUncompressedMetadataBytes: number;
  maxWorksheets: number;
  maxRetainedSheetNames: number;
  maxSheetNameLength: number;
};

type PackageEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

type Relationship = { id: string; type: string; target: string };
type WorkbookSheet = { name: string; relationshipId: string };

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_END_RECORD_SIZE = 22 + 65_535;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
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
  const source = await readBoundedSource(filePath, config.maxSourceBytes);
  if (source === undefined) return rejected("XLSX_SOURCE_TOO_LARGE");

  try {
    const entries = parsePackage(source, config.maxPackageEntries);
    const contentTypesEntry = requireEntry(entries, "[Content_Types].xml");
    const rootRelationshipsEntry = requireEntry(entries, "_rels/.rels");
    const initialParts = readMetadataParts(source, [contentTypesEntry, rootRelationshipsEntry], config);
    const contentTypes = parseContentTypes(initialParts[0]!);
    const rootRelationships = parseRelationships(initialParts[1]!);

    const officeRelationships = rootRelationships.filter((item) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(item.type));
    if (officeRelationships.length !== 1) throw new XlsxRejection("MALFORMED_XLSX");
    const workbookPath = resolveRelationshipTarget("", officeRelationships[0]!.target);
    const workbookContentType = contentTypes.get(workbookPath);
    if (workbookContentType === undefined) throw new XlsxRejection("MALFORMED_XLSX");
    if (MACRO_CONTENT_TYPES.has(workbookContentType)) throw new XlsxRejection("MACRO_ENABLED_XLSX");
    if (!WORKBOOK_CONTENT_TYPES.has(workbookContentType)) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }

    const workbookEntry = requireEntry(entries, workbookPath);
    const workbookRelationshipsPath = relationshipPartName(workbookPath);
    const workbookRelationshipsEntry = requireEntry(entries, workbookRelationshipsPath);
    const allMetadataEntries = [
      contentTypesEntry,
      rootRelationshipsEntry,
      workbookEntry,
      workbookRelationshipsEntry,
    ];
    const parts = readMetadataParts(source, allMetadataEntries, config);
    const workbookRelationships = parseRelationships(parts[3]!);
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
    return rejected("MALFORMED_XLSX");
  }
}

async function readBoundedSource(filePath: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    if (stats.size > maxBytes) return undefined;
    const source = Buffer.alloc(stats.size);
    let bytesRead = 0;
    while (bytesRead < source.length) {
      const result = await handle.read(source, bytesRead, source.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== stats.size) {
      throw new OrganizerError("INSPECTION_FAILED", "The XLSX file changed while it was being read.");
    }
    return source;
  } catch (error) {
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("INSPECTION_FAILED", "The XLSX file could not be read for inspection.", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

function parsePackage(source: Buffer, maxEntries: number): Map<string, PackageEntry> {
  if (source.length < 22) throw new XlsxRejection("MALFORMED_XLSX");
  const tailStart = Math.max(0, source.length - MAX_END_RECORD_SIZE);
  const tail = source.subarray(tailStart);
  const endOffset = findEndRecord(tail);
  if (endOffset === -1) throw new XlsxRejection("MALFORMED_XLSX");

  const entriesOnDisk = tail.readUInt16LE(endOffset + 8);
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const centralSize = tail.readUInt32LE(endOffset + 12);
  const centralOffset = tail.readUInt32LE(endOffset + 16);
  if (
    entriesOnDisk === ZIP64_16 ||
    entryCount === ZIP64_16 ||
    centralSize === ZIP64_32 ||
    centralOffset === ZIP64_32
  ) {
    throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
  }
  if (tail.readUInt16LE(endOffset + 4) !== 0 || tail.readUInt16LE(endOffset + 6) !== 0 || entriesOnDisk !== entryCount) {
    throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
  }
  if (entryCount > maxEntries) throw new XlsxRejection("XLSX_PACKAGE_ENTRY_LIMIT_EXCEEDED");
  if (centralOffset + centralSize !== tailStart + endOffset) throw new XlsxRejection("MALFORMED_XLSX");

  const entries = new Map<string, PackageEntry>();
  let offset = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralEnd || source.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new XlsxRejection("MALFORMED_XLSX");
    }
    const flags = source.readUInt16LE(offset + 8);
    const filenameLength = source.readUInt16LE(offset + 28);
    const extraLength = source.readUInt16LE(offset + 30);
    const commentLength = source.readUInt16LE(offset + 32);
    const recordLength = 46 + filenameLength + extraLength + commentLength;
    if (offset + recordLength > centralEnd) throw new XlsxRejection("MALFORMED_XLSX");
    if (flags & 0x41) throw new XlsxRejection("ENCRYPTED_XLSX");

    const compressedSize = source.readUInt32LE(offset + 20);
    const uncompressedSize = source.readUInt32LE(offset + 24);
    const localOffset = source.readUInt32LE(offset + 42);
    const startDisk = source.readUInt16LE(offset + 34);
    if (
      compressedSize === ZIP64_32 ||
      uncompressedSize === ZIP64_32 ||
      localOffset === ZIP64_32 ||
      startDisk === ZIP64_16
    ) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    if (startDisk !== 0 || localOffset >= centralOffset) throw new XlsxRejection("MALFORMED_XLSX");

    const name = decodeEntryName(source.subarray(offset + 46, offset + 46 + filenameLength), Boolean(flags & 0x800));
    const normalizedName = normalizePartName(name);
    if (entries.has(normalizedName)) throw new XlsxRejection("DUPLICATE_XLSX_PART");
    entries.set(normalizedName, {
      name: normalizedName,
      flags,
      compressionMethod: source.readUInt16LE(offset + 10),
      crc32: source.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += recordLength;
  }
  if (offset !== centralEnd) throw new XlsxRejection("MALFORMED_XLSX");
  if (entries.has("EncryptionInfo") || entries.has("EncryptedPackage")) {
    throw new XlsxRejection("ENCRYPTED_XLSX");
  }
  if ([...entries.keys()].some((name) => name.toLowerCase().endsWith("/vbaproject.bin"))) {
    throw new XlsxRejection("MACRO_ENABLED_XLSX");
  }
  return entries;
}

function findEndRecord(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === END_SIGNATURE && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      return offset;
    }
  }
  return -1;
}

function decodeEntryName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) throw new XlsxRejection("UNSAFE_XLSX_ENTRY_NAME");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XlsxRejection("UNSAFE_XLSX_ENTRY_NAME");
  }
}

function normalizePartName(name: string): string {
  if (name.length === 0 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new XlsxRejection("UNSAFE_XLSX_ENTRY_NAME");
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new XlsxRejection("UNSAFE_XLSX_ENTRY_NAME");
  }
  return name;
}

function requireEntry(entries: Map<string, PackageEntry>, name: string): PackageEntry {
  const entry = entries.get(name);
  if (entry === undefined) throw new XlsxRejection("MALFORMED_XLSX");
  return entry;
}

function readMetadataParts(source: Buffer, entries: PackageEntry[], config: XlsxInspectionConfig): Buffer[] {
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.name, entry])).values()];
  const compressedBytes = uniqueEntries.reduce((total, entry) => total + entry.compressedSize, 0);
  const uncompressedBytes = uniqueEntries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (compressedBytes > config.maxCompressedMetadataBytes) {
    throw new XlsxRejection("XLSX_COMPRESSED_METADATA_LIMIT_EXCEEDED");
  }
  if (uncompressedBytes > config.maxUncompressedMetadataBytes) {
    throw new XlsxRejection("XLSX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED");
  }
  return entries.map((entry) => readEntry(source, entry, config.maxUncompressedMetadataBytes));
}

function readEntry(source: Buffer, entry: PackageEntry, maxOutputBytes: number): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > source.length || source.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new XlsxRejection("MALFORMED_XLSX");
  }
  if (source.readUInt16LE(offset + 6) !== entry.flags || source.readUInt16LE(offset + 8) !== entry.compressionMethod) {
    throw new XlsxRejection("MALFORMED_XLSX");
  }
  const nameLength = source.readUInt16LE(offset + 26);
  const extraLength = source.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > source.length) throw new XlsxRejection("MALFORMED_XLSX");
  const localName = decodeEntryName(source.subarray(offset + 30, offset + 30 + nameLength), Boolean(entry.flags & 0x800));
  if (normalizePartName(localName) !== entry.name) throw new XlsxRejection("MALFORMED_XLSX");

  const compressed = source.subarray(dataOffset, dataEnd);
  let uncompressed: Buffer;
  try {
    if (entry.compressionMethod === 0) uncompressed = Buffer.from(compressed);
    else if (entry.compressionMethod === 8) uncompressed = inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
    else throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
  } catch (error) {
    if (error instanceof XlsxRejection) throw error;
    throw new XlsxRejection("MALFORMED_XLSX");
  }
  if (uncompressed.length !== entry.uncompressedSize || crc32(uncompressed) !== entry.crc32) {
    throw new XlsxRejection("MALFORMED_XLSX");
  }
  return uncompressed;
}

function parseContentTypes(source: Buffer): Map<string, string> {
  const overrides = new Map<string, string>();
  parseXml(source, (tag) => {
    if (tag.uri !== CONTENT_TYPES_NAMESPACE) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    const declaredContentType = attribute(tag, "ContentType");
    if (declaredContentType !== undefined && MACRO_CONTENT_TYPES.has(declaredContentType)) {
      throw new XlsxRejection("MACRO_ENABLED_XLSX");
    }
    if (tag.local !== "Override") return;
    const partName = attribute(tag, "PartName");
    const contentType = declaredContentType;
    if (partName === undefined || contentType === undefined || !partName.startsWith("/")) {
      throw new XlsxRejection("MALFORMED_XLSX");
    }
    const normalized = normalizePartName(partName.slice(1));
    if (overrides.has(normalized)) throw new XlsxRejection("DUPLICATE_XLSX_PART");
    overrides.set(normalized, contentType);
  });
  return overrides;
}

function parseRelationships(source: Buffer): Relationship[] {
  const relationships: Relationship[] = [];
  const ids = new Set<string>();
  parseXml(source, (tag) => {
    if (tag.uri !== RELATIONSHIPS_NAMESPACE) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    if (tag.local !== "Relationship") return;
    const id = attribute(tag, "Id");
    const type = attribute(tag, "Type");
    const target = attribute(tag, "Target");
    if (id === undefined || type === undefined || target === undefined || ids.has(id)) {
      throw new XlsxRejection("MALFORMED_XLSX");
    }
    if (attribute(tag, "TargetMode") !== undefined) {
      throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
    }
    ids.add(id);
    relationships.push({ id, type, target });
  });
  return relationships;
}

function parseWorkbook(source: Buffer, maxWorksheets: number): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  parseXml(source, (tag) => {
    if (!WORKBOOK_NAMESPACES.has(tag.uri)) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    if (tag.local !== "sheet") return;
    const name = attribute(tag, "name");
    const relationshipId = namespacedAttribute(tag, DOCUMENT_RELATIONSHIP_NAMESPACES, "id");
    if (name === undefined || relationshipId === undefined || name.length === 0) {
      throw new XlsxRejection("MALFORMED_XLSX");
    }
    sheets.push({ name, relationshipId });
    if (sheets.length > maxWorksheets) throw new XlsxRejection("XLSX_WORKSHEET_LIMIT_EXCEEDED");
  });
  return sheets;
}

function parseXml(source: Buffer, onOpenTag: (tag: SaxesTagNS) => void): void {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new XlsxRejection("MALFORMED_XLSX");
  }
  if (/^\s*<\?xml[^>]*encoding\s*=\s*["'](?!utf-?8["'])/i.test(xml)) {
    throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
  }
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("doctype", () => {
    throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
  });
  parser.on("opentag", onOpenTag);
  parser.write(xml).close();
}

function attribute(tag: SaxesTagNS, local: string): string | undefined {
  return Object.values(tag.attributes).find((item: SaxesAttributeNS) => item.uri === "" && item.local === local)?.value;
}

function namespacedAttribute(tag: SaxesTagNS, namespaces: Set<string>, local: string): string | undefined {
  return Object.values(tag.attributes).find(
    (item: SaxesAttributeNS) => namespaces.has(item.uri) && item.local === local,
  )?.value;
}

function relationshipPartName(partName: string): string {
  const directory = path.posix.dirname(partName);
  return `${directory === "." ? "" : `${directory}/`}_rels/${path.posix.basename(partName)}.rels`;
}

function resolveRelationshipTarget(sourcePart: string, target: string): string {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target.includes("?") ||
    target.includes("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target)
  ) {
    throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
  }
  if (decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0")) {
    throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
  }
  if (decoded.split("/").includes("..")) throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
  const base = sourcePart === "" ? "" : path.posix.dirname(sourcePart);
  const segments = `${base}/${decoded}`.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }
  if (normalized.length === 0) throw new XlsxRejection("UNSAFE_XLSX_RELATIONSHIP");
  return normalizePartName(normalized.join("/"));
}

function validateSheetRelationships(
  sheets: WorkbookSheet[],
  relationships: Relationship[],
  workbookPath: string,
  entries: Map<string, PackageEntry>,
): void {
  const byId = new Map(relationships.map((item) => [item.id, item]));
  const usedIds = new Set<string>();
  for (const sheet of sheets) {
    const relationship = byId.get(sheet.relationshipId);
    if (relationship === undefined || usedIds.has(sheet.relationshipId)) throw new XlsxRejection("MALFORMED_XLSX");
    if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type)) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    const target = resolveRelationshipTarget(workbookPath, relationship.target);
    if (!entries.has(target)) throw new XlsxRejection("MALFORMED_XLSX");
    usedIds.add(sheet.relationshipId);
  }
}

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rejected(reason: RejectedXlsxExtraction["reason"]): RejectedXlsxExtraction {
  return { status: "rejected", format: "xlsx", reason };
}
