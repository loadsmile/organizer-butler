import { open } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { OrganizerError } from "../../domain/error.js";
import type {
  DocxExtraction,
  DocxMetadataField,
  RejectedDocxExtraction,
} from "../../domain/inspection.js";

type DocxInspectionConfig = {
  maxSourceBytes: number;
  maxPackageEntries: number;
  maxCompressedMetadataBytes: number;
  maxUncompressedMetadataBytes: number;
  maxMetadataFields: number;
  maxMetadataStringLength: number;
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

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_END_RECORD_SIZE = 22 + 65_535;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const CORE_PROPERTIES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DUBLIN_CORE_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const DOCUMENT_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set(
  [...DOCUMENT_RELATIONSHIP_NAMESPACES].map((namespace) => `${namespace}/officeDocument`),
);
const CORE_PROPERTIES_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
]);
const DOCUMENT_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
]);
const MACRO_CONTENT_TYPES = new Set([
  "application/vnd.ms-word.document.macroEnabled.main+xml",
  "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
  "application/vnd.ms-office.vbaProject",
]);
const CORE_PROPERTIES_CONTENT_TYPE = "application/vnd.openxmlformats-package.core-properties+xml";
const ALLOWED_DOCUMENT_RELATIONSHIP_SUFFIXES = new Set([
  "comments",
  "customXml",
  "endnotes",
  "fontTable",
  "footer",
  "footnotes",
  "glossaryDocument",
  "header",
  "hyperlink",
  "image",
  "numbering",
  "officeDocument",
  "oleObject",
  "package",
  "settings",
  "styles",
  "theme",
  "webSettings",
]);
const METADATA_FIELDS: ReadonlyArray<{
  key: DocxMetadataField["key"];
  namespace: string;
  local: string;
}> = [
  { key: "title", namespace: DUBLIN_CORE_NAMESPACE, local: "title" },
  { key: "subject", namespace: DUBLIN_CORE_NAMESPACE, local: "subject" },
  { key: "creator", namespace: DUBLIN_CORE_NAMESPACE, local: "creator" },
  { key: "keywords", namespace: CORE_PROPERTIES_NAMESPACE, local: "keywords" },
  { key: "description", namespace: DUBLIN_CORE_NAMESPACE, local: "description" },
  { key: "lastModifiedBy", namespace: CORE_PROPERTIES_NAMESPACE, local: "lastModifiedBy" },
];

class DocxRejection extends Error {
  constructor(readonly reason: RejectedDocxExtraction["reason"]) {
    super(reason);
  }
}

export async function inspectDocx(
  filePath: string,
  config: DocxInspectionConfig,
): Promise<DocxExtraction | RejectedDocxExtraction> {
  const source = await readBoundedSource(filePath, config.maxSourceBytes);
  if (source === undefined) return rejected("DOCX_SOURCE_TOO_LARGE");

  try {
    const entries = parsePackage(source, config.maxPackageEntries);
    const contentTypesEntry = requireEntry(entries, "[Content_Types].xml");
    const rootRelationshipsEntry = requireEntry(entries, "_rels/.rels");
    const initialParts = readMetadataParts(source, [contentTypesEntry, rootRelationshipsEntry], config);
    const contentTypes = parseContentTypes(initialParts[0]!);
    const rootRelationships = parseRelationships(initialParts[1]!);

    const officeRelationships = rootRelationships.filter((item) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(item.type));
    if (officeRelationships.length !== 1) throw new DocxRejection("MALFORMED_DOCX");
    const documentPath = resolveRelationshipTarget("", officeRelationships[0]!.target);
    const documentContentType = contentTypes.get(documentPath);
    if (documentContentType === undefined) throw new DocxRejection("MALFORMED_DOCX");
    if (MACRO_CONTENT_TYPES.has(documentContentType)) throw new DocxRejection("MACRO_ENABLED_DOCX");
    if (!DOCUMENT_CONTENT_TYPES.has(documentContentType)) {
      throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    }
    requireEntry(entries, documentPath);

    const documentRelationshipsEntry = entries.get(relationshipPartName(documentPath));
    const coreRelationships = rootRelationships.filter((item) => CORE_PROPERTIES_RELATIONSHIP_TYPES.has(item.type));
    if (coreRelationships.length > 1) throw new DocxRejection("MALFORMED_DOCX");

    const selectedEntries = [contentTypesEntry, rootRelationshipsEntry];
    if (documentRelationshipsEntry !== undefined) selectedEntries.push(documentRelationshipsEntry);

    let corePropertiesEntry: PackageEntry | undefined;
    if (coreRelationships.length === 1) {
      const corePropertiesPath = resolveRelationshipTarget("", coreRelationships[0]!.target);
      if (contentTypes.get(corePropertiesPath) !== CORE_PROPERTIES_CONTENT_TYPE) {
        throw new DocxRejection("MALFORMED_DOCX");
      }
      corePropertiesEntry = requireEntry(entries, corePropertiesPath);
      selectedEntries.push(corePropertiesEntry);
    }

    const parts = readMetadataParts(source, selectedEntries, config);
    let partIndex = 2;
    if (documentRelationshipsEntry !== undefined) {
      validateDocumentRelationships(parseRelationships(parts[partIndex]!), documentPath, entries);
      partIndex += 1;
    }

    const allMetadata = corePropertiesEntry === undefined ? [] : parseCoreProperties(parts[partIndex]!);
    const retainedMetadata = allMetadata.slice(0, config.maxMetadataFields);
    let metadataStringsTruncated = false;
    const metadata = retainedMetadata.map(({ key, value }): DocxMetadataField => {
      const characters = [...value];
      const truncated = characters.length > config.maxMetadataStringLength;
      metadataStringsTruncated ||= truncated;
      return { key, value: characters.slice(0, config.maxMetadataStringLength).join(""), truncated };
    });

    return {
      status: "extracted",
      format: "docx",
      documentFormat: "docx",
      metadata,
      metadataFieldsTruncated: allMetadata.length > metadata.length,
      metadataStringsTruncated,
    };
  } catch (error) {
    if (error instanceof DocxRejection) return rejected(error.reason);
    return rejected("MALFORMED_DOCX");
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
      throw new OrganizerError("INSPECTION_FAILED", "The DOCX file changed while it was being read.");
    }
    return source;
  } catch (error) {
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("INSPECTION_FAILED", "The DOCX file could not be read for inspection.", { cause: error });
  } finally {
    await handle?.close();
  }
}

function parsePackage(source: Buffer, maxEntries: number): Map<string, PackageEntry> {
  if (source.length < 22) throw new DocxRejection("MALFORMED_DOCX");
  const tailStart = Math.max(0, source.length - MAX_END_RECORD_SIZE);
  const tail = source.subarray(tailStart);
  const endOffset = findEndRecord(tail);
  if (endOffset === -1) throw new DocxRejection("MALFORMED_DOCX");

  const entriesOnDisk = tail.readUInt16LE(endOffset + 8);
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const centralSize = tail.readUInt32LE(endOffset + 12);
  const centralOffset = tail.readUInt32LE(endOffset + 16);
  if (entriesOnDisk === ZIP64_16 || entryCount === ZIP64_16 || centralSize === ZIP64_32 || centralOffset === ZIP64_32) {
    throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
  }
  if (tail.readUInt16LE(endOffset + 4) !== 0 || tail.readUInt16LE(endOffset + 6) !== 0 || entriesOnDisk !== entryCount) {
    throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
  }
  if (entryCount > maxEntries) throw new DocxRejection("DOCX_PACKAGE_ENTRY_LIMIT_EXCEEDED");
  if (centralOffset + centralSize !== tailStart + endOffset) throw new DocxRejection("MALFORMED_DOCX");

  const entries = new Map<string, PackageEntry>();
  let offset = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralEnd || source.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new DocxRejection("MALFORMED_DOCX");
    }
    const flags = source.readUInt16LE(offset + 8);
    const filenameLength = source.readUInt16LE(offset + 28);
    const extraLength = source.readUInt16LE(offset + 30);
    const commentLength = source.readUInt16LE(offset + 32);
    const recordLength = 46 + filenameLength + extraLength + commentLength;
    if (offset + recordLength > centralEnd) throw new DocxRejection("MALFORMED_DOCX");
    if (flags & 0x41) throw new DocxRejection("ENCRYPTED_DOCX");

    const compressedSize = source.readUInt32LE(offset + 20);
    const uncompressedSize = source.readUInt32LE(offset + 24);
    const localOffset = source.readUInt32LE(offset + 42);
    const startDisk = source.readUInt16LE(offset + 34);
    if (compressedSize === ZIP64_32 || uncompressedSize === ZIP64_32 || localOffset === ZIP64_32 || startDisk === ZIP64_16) {
      throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    }
    if (startDisk !== 0 || localOffset >= centralOffset) throw new DocxRejection("MALFORMED_DOCX");

    const name = decodeEntryName(source.subarray(offset + 46, offset + 46 + filenameLength), Boolean(flags & 0x800));
    const normalizedName = normalizePartName(name);
    if (entries.has(normalizedName)) throw new DocxRejection("DUPLICATE_DOCX_PART");
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
  if (offset !== centralEnd) throw new DocxRejection("MALFORMED_DOCX");
  if (entries.has("EncryptionInfo") || entries.has("EncryptedPackage")) throw new DocxRejection("ENCRYPTED_DOCX");
  if ([...entries.keys()].some((name) => name.toLowerCase().endsWith("/vbaproject.bin"))) {
    throw new DocxRejection("MACRO_ENABLED_DOCX");
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
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) throw new DocxRejection("UNSAFE_DOCX_ENTRY_NAME");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocxRejection("UNSAFE_DOCX_ENTRY_NAME");
  }
}

function normalizePartName(name: string): string {
  if (name.length === 0 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new DocxRejection("UNSAFE_DOCX_ENTRY_NAME");
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DocxRejection("UNSAFE_DOCX_ENTRY_NAME");
  }
  return name;
}

function requireEntry(entries: Map<string, PackageEntry>, name: string): PackageEntry {
  const entry = entries.get(name);
  if (entry === undefined) throw new DocxRejection("MALFORMED_DOCX");
  return entry;
}

function readMetadataParts(source: Buffer, entries: PackageEntry[], config: DocxInspectionConfig): Buffer[] {
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.name, entry])).values()];
  const compressedBytes = uniqueEntries.reduce((total, entry) => total + entry.compressedSize, 0);
  const uncompressedBytes = uniqueEntries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (compressedBytes > config.maxCompressedMetadataBytes) {
    throw new DocxRejection("DOCX_COMPRESSED_METADATA_LIMIT_EXCEEDED");
  }
  if (uncompressedBytes > config.maxUncompressedMetadataBytes) {
    throw new DocxRejection("DOCX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED");
  }
  return entries.map((entry) => readEntry(source, entry, config.maxUncompressedMetadataBytes));
}

function readEntry(source: Buffer, entry: PackageEntry, maxOutputBytes: number): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > source.length || source.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new DocxRejection("MALFORMED_DOCX");
  }
  if (source.readUInt16LE(offset + 6) !== entry.flags || source.readUInt16LE(offset + 8) !== entry.compressionMethod) {
    throw new DocxRejection("MALFORMED_DOCX");
  }
  const nameLength = source.readUInt16LE(offset + 26);
  const extraLength = source.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > source.length) throw new DocxRejection("MALFORMED_DOCX");
  const localName = decodeEntryName(source.subarray(offset + 30, offset + 30 + nameLength), Boolean(entry.flags & 0x800));
  if (normalizePartName(localName) !== entry.name) throw new DocxRejection("MALFORMED_DOCX");

  const compressed = source.subarray(dataOffset, dataEnd);
  let uncompressed: Buffer;
  try {
    if (entry.compressionMethod === 0) uncompressed = Buffer.from(compressed);
    else if (entry.compressionMethod === 8) uncompressed = inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
    else throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
  } catch (error) {
    if (error instanceof DocxRejection) throw error;
    throw new DocxRejection("MALFORMED_DOCX");
  }
  if (uncompressed.length !== entry.uncompressedSize || crc32(uncompressed) !== entry.crc32) {
    throw new DocxRejection("MALFORMED_DOCX");
  }
  return uncompressed;
}

function parseContentTypes(source: Buffer): Map<string, string> {
  const overrides = new Map<string, string>();
  parseXml(source, (tag) => {
    if (tag.uri !== CONTENT_TYPES_NAMESPACE) throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    const declaredContentType = attribute(tag, "ContentType");
    if (declaredContentType !== undefined && MACRO_CONTENT_TYPES.has(declaredContentType)) {
      throw new DocxRejection("MACRO_ENABLED_DOCX");
    }
    if (tag.local !== "Override") return;
    const partName = attribute(tag, "PartName");
    if (partName === undefined || declaredContentType === undefined || !partName.startsWith("/")) {
      throw new DocxRejection("MALFORMED_DOCX");
    }
    const normalized = normalizePartName(partName.slice(1));
    if (overrides.has(normalized)) throw new DocxRejection("DUPLICATE_DOCX_PART");
    overrides.set(normalized, declaredContentType);
  });
  return overrides;
}

function parseRelationships(source: Buffer): Relationship[] {
  const relationships: Relationship[] = [];
  const ids = new Set<string>();
  parseXml(source, (tag) => {
    if (tag.uri !== RELATIONSHIPS_NAMESPACE) throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    if (tag.local !== "Relationship") return;
    const id = attribute(tag, "Id");
    const type = attribute(tag, "Type");
    const target = attribute(tag, "Target");
    if (id === undefined || type === undefined || target === undefined || ids.has(id)) {
      throw new DocxRejection("MALFORMED_DOCX");
    }
    if (attribute(tag, "TargetMode") !== undefined) throw new DocxRejection("UNSAFE_DOCX_RELATIONSHIP");
    ids.add(id);
    relationships.push({ id, type, target });
  });
  return relationships;
}

function parseCoreProperties(source: Buffer): DocxMetadataField[] {
  const values = new Map<DocxMetadataField["key"], string>();
  let active: (typeof METADATA_FIELDS)[number] | undefined;
  let depth = 0;
  let text = "";
  parseXml(
    source,
    (tag) => {
      if (depth === 0 && (tag.uri !== CORE_PROPERTIES_NAMESPACE || tag.local !== "coreProperties")) {
        throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
      }
      depth += 1;
      if (depth !== 2) return;
      const field = METADATA_FIELDS.find((item) => item.namespace === tag.uri && item.local === tag.local);
      if (field === undefined) return;
      if (values.has(field.key)) throw new DocxRejection("MALFORMED_DOCX");
      active = field;
      text = "";
    },
    (value) => {
      if (active !== undefined) text += value;
    },
    () => {
      if (active !== undefined && depth === 2) {
        values.set(active.key, text);
        active = undefined;
      }
      depth -= 1;
    },
  );
  return METADATA_FIELDS.flatMap(({ key }) => {
    const value = values.get(key);
    return value === undefined ? [] : [{ key, value, truncated: false }];
  });
}

function parseXml(
  source: Buffer,
  onOpenTag: (tag: SaxesTagNS) => void,
  onText?: (text: string) => void,
  onCloseTag?: () => void,
): void {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new DocxRejection("MALFORMED_DOCX");
  }
  if (/^\s*<\?xml[^>]*encoding\s*=\s*["'](?!utf-?8["'])/i.test(xml)) {
    throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
  }
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("doctype", () => {
    throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
  });
  parser.on("opentag", onOpenTag);
  if (onText !== undefined) parser.on("text", onText);
  if (onCloseTag !== undefined) parser.on("closetag", onCloseTag);
  parser.write(xml).close();
}

function attribute(tag: SaxesTagNS, local: string): string | undefined {
  return Object.values(tag.attributes).find((item: SaxesAttributeNS) => item.uri === "" && item.local === local)?.value;
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
    throw new DocxRejection("UNSAFE_DOCX_RELATIONSHIP");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new DocxRejection("UNSAFE_DOCX_RELATIONSHIP");
  }
  if (decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0") || decoded.split("/").includes("..")) {
    throw new DocxRejection("UNSAFE_DOCX_RELATIONSHIP");
  }
  const base = sourcePart === "" ? "" : path.posix.dirname(sourcePart);
  const normalized = `${base}/${decoded}`.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (normalized.length === 0) throw new DocxRejection("UNSAFE_DOCX_RELATIONSHIP");
  return normalizePartName(normalized.join("/"));
}

function validateDocumentRelationships(
  relationships: Relationship[],
  documentPath: string,
  entries: Map<string, PackageEntry>,
): void {
  for (const relationship of relationships) {
    const namespace = [...DOCUMENT_RELATIONSHIP_NAMESPACES].find((item) => relationship.type.startsWith(`${item}/`));
    if (namespace === undefined) throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    const suffix = relationship.type.slice(namespace.length + 1);
    if (!ALLOWED_DOCUMENT_RELATIONSHIP_SUFFIXES.has(suffix)) throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    const target = resolveRelationshipTarget(documentPath, relationship.target);
    if (!entries.has(target)) throw new DocxRejection("MALFORMED_DOCX");
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

function rejected(reason: RejectedDocxExtraction["reason"]): RejectedDocxExtraction {
  return { status: "rejected", format: "docx", reason };
}
