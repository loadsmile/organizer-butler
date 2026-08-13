import type {
  DocxExtraction,
  DocxMetadataField,
  RejectedDocxExtraction,
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
  OpcXmlError,
  type OpcRelationship,
  opcRelationshipPartName,
  parseOpcContentTypes,
  parseOpcRelationships,
  parseOpcXml,
  resolveOpcRelationshipTarget,
} from "./opcXml.js";

type DocxInspectionConfig = {
  maxSourceBytes: number;
  maxPackageEntries: number;
  maxCompressedMetadataBytes: number;
  maxUncompressedMetadataBytes: number;
  maxMetadataFields: number;
  maxMetadataStringLength: number;
  maxBodyParts: number;
  maxBodyCharacters: number;
  maxBodyParagraphs: number;
  maxBodyStructures: number;
};

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
const WORDPROCESSING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
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
  const source = await readBoundedOoxmlSource(filePath, config.maxSourceBytes, "DOCX");
  if (source === undefined) return rejected("DOCX_SOURCE_TOO_LARGE");

  try {
    const entries = parseOoxmlPackage(source, config.maxPackageEntries);
    const contentTypesEntry = requireOoxmlEntry(entries, "[Content_Types].xml");
    const rootRelationshipsEntry = requireOoxmlEntry(entries, "_rels/.rels");
    const initialParts = readMetadataParts(source, [contentTypesEntry, rootRelationshipsEntry], config);
    const contentTypes = parseContentTypes(initialParts[0]!);
    const rootRelationships = parseOpcRelationships(initialParts[1]!);

    const officeRelationships = rootRelationships.filter((item) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(item.type));
    if (officeRelationships.length !== 1) throw new DocxRejection("MALFORMED_DOCX");
    const documentPath = resolveOpcRelationshipTarget("", officeRelationships[0]!.target);
    const documentContentType = contentTypes.get(documentPath);
    if (documentContentType === undefined) throw new DocxRejection("MALFORMED_DOCX");
    if (MACRO_CONTENT_TYPES.has(documentContentType)) throw new DocxRejection("MACRO_ENABLED_DOCX");
    if (!DOCUMENT_CONTENT_TYPES.has(documentContentType)) {
      throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    }
    const documentEntry = requireOoxmlEntry(entries, documentPath);
    if (config.maxBodyParts < 1) throw new DocxRejection("DOCX_BODY_PART_LIMIT_EXCEEDED");

    const documentRelationshipsEntry = entries.get(opcRelationshipPartName(documentPath));
    const coreRelationships = rootRelationships.filter((item) => CORE_PROPERTIES_RELATIONSHIP_TYPES.has(item.type));
    if (coreRelationships.length > 1) throw new DocxRejection("MALFORMED_DOCX");

    const selectedEntries = [contentTypesEntry, rootRelationshipsEntry, documentEntry];
    if (documentRelationshipsEntry !== undefined) selectedEntries.push(documentRelationshipsEntry);

    let corePropertiesEntry: OoxmlPackageEntry | undefined;
    if (coreRelationships.length === 1) {
      const corePropertiesPath = resolveOpcRelationshipTarget("", coreRelationships[0]!.target);
      if (contentTypes.get(corePropertiesPath) !== CORE_PROPERTIES_CONTENT_TYPE) {
        throw new DocxRejection("MALFORMED_DOCX");
      }
      corePropertiesEntry = requireOoxmlEntry(entries, corePropertiesPath);
      selectedEntries.push(corePropertiesEntry);
    }

    const parts = readMetadataParts(source, selectedEntries, config);
    const bodyText = parseBodyText(parts[2]!, config);
    let partIndex = 3;
    if (documentRelationshipsEntry !== undefined) {
      validateDocumentRelationships(parseOpcRelationships(parts[partIndex]!), documentPath, entries);
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
      bodyText,
    };
  } catch (error) {
    if (error instanceof DocxRejection) return rejected(error.reason);
    if (error instanceof OoxmlPackageError) return rejected(packageReason(error));
    if (error instanceof OpcXmlError) return rejected(opcReason(error));
    return rejected("MALFORMED_DOCX");
  }
}

function parseBodyText(source: Buffer, config: DocxInspectionConfig): DocxExtraction["bodyText"] {
  const paragraphs: string[] = [];
  const stack: Array<{ uri: string; local: string }> = [];
  let structures = 0;
  let bodyCount = 0;
  let paragraphCount = 0;
  let paragraph = "";
  let retainedCharacters = 0;
  let charactersTruncated = false;

  const append = (value: string): void => {
    if (paragraphs.length >= config.maxBodyParagraphs) return;
    const characters = [...value];
    const available = Math.max(0, config.maxBodyCharacters - retainedCharacters);
    if (characters.length > available) charactersTruncated = true;
    if (available === 0) return;
    const retained = characters.slice(0, available).join("");
    paragraph += retained;
    retainedCharacters += [...retained].length;
  };

  parseOpcXml(source, {
    onOpenTag(tag) {
      structures += 1;
      if (structures > config.maxBodyStructures) {
        throw new DocxRejection("DOCX_BODY_STRUCTURE_LIMIT_EXCEEDED");
      }
      stack.push({ uri: tag.uri, local: tag.local });
      if (stack.length === 1 && (!WORDPROCESSING_NAMESPACES.has(tag.uri) || tag.local !== "document")) {
        throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
      }
      if (stack.length === 2 && WORDPROCESSING_NAMESPACES.has(tag.uri) && tag.local === "body") bodyCount += 1;
      if (isDirectBodyParagraph(stack)) {
        paragraphCount += 1;
        paragraph = "";
      } else if (isDirectParagraphRunChild(stack, "tab")) {
        append("\t");
      } else if (isDirectParagraphRunChild(stack, "br") || isDirectParagraphRunChild(stack, "cr")) {
        append("\n");
      }
    },
    onText(value) {
      if (isDirectParagraphRunChild(stack, "t")) append(value);
    },
    onCloseTag() {
      if (isDirectBodyParagraph(stack) && paragraphs.length < config.maxBodyParagraphs) paragraphs.push(paragraph);
      stack.pop();
    },
  });

  if (stack.length !== 0 || bodyCount !== 1) throw new DocxRejection("MALFORMED_DOCX");
  return {
    paragraphs,
    paragraphsTruncated: paragraphCount > paragraphs.length,
    charactersTruncated,
  };
}

function isDirectBodyParagraph(stack: Array<{ uri: string; local: string }>): boolean {
  return stack.length === 3 &&
    stack.every((item) => WORDPROCESSING_NAMESPACES.has(item.uri)) &&
    stack[0]!.local === "document" && stack[1]!.local === "body" && stack[2]!.local === "p";
}

function isDirectParagraphRunChild(stack: Array<{ uri: string; local: string }>, local: string): boolean {
  return stack.length === 5 && isDirectBodyParagraph(stack.slice(0, 3)) &&
    stack[3]!.uri === stack[2]!.uri && stack[3]!.local === "r" &&
    stack[4]!.uri === stack[2]!.uri && stack[4]!.local === local;
}

function readMetadataParts(source: Buffer, entries: OoxmlPackageEntry[], config: DocxInspectionConfig): Buffer[] {
  return readOoxmlParts(source, entries, {
    maxCompressedBytes: config.maxCompressedMetadataBytes,
    maxUncompressedBytes: config.maxUncompressedMetadataBytes,
  });
}

function parseContentTypes(source: Buffer): Map<string, string> {
  return parseOpcContentTypes(source, (contentType) => {
    if (MACRO_CONTENT_TYPES.has(contentType)) {
      throw new DocxRejection("MACRO_ENABLED_DOCX");
    }
  });
}

function parseCoreProperties(source: Buffer): DocxMetadataField[] {
  const values = new Map<DocxMetadataField["key"], string>();
  let active: (typeof METADATA_FIELDS)[number] | undefined;
  let depth = 0;
  let text = "";
  parseOpcXml(source, {
    onOpenTag(tag) {
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
    onText(value) {
      if (active !== undefined) text += value;
    },
    onCloseTag() {
      if (active !== undefined && depth === 2) {
        values.set(active.key, text);
        active = undefined;
      }
      depth -= 1;
    },
  });
  return METADATA_FIELDS.flatMap(({ key }) => {
    const value = values.get(key);
    return value === undefined ? [] : [{ key, value, truncated: false }];
  });
}

function validateDocumentRelationships(
  relationships: OpcRelationship[],
  documentPath: string,
  entries: Map<string, OoxmlPackageEntry>,
): void {
  for (const relationship of relationships) {
    const namespace = [...DOCUMENT_RELATIONSHIP_NAMESPACES].find((item) => relationship.type.startsWith(`${item}/`));
    if (namespace === undefined) throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    const suffix = relationship.type.slice(namespace.length + 1);
    if (!ALLOWED_DOCUMENT_RELATIONSHIP_SUFFIXES.has(suffix)) throw new DocxRejection("UNSUPPORTED_DOCX_FEATURE");
    const target = resolveOpcRelationshipTarget(documentPath, relationship.target);
    if (!entries.has(target)) throw new DocxRejection("MALFORMED_DOCX");
  }
}

function opcReason(error: OpcXmlError): RejectedDocxExtraction["reason"] {
  const reasons: Record<typeof error.failure, RejectedDocxExtraction["reason"]> = {
    malformed: "MALFORMED_DOCX",
    unsupported: "UNSUPPORTED_DOCX_FEATURE",
    "unsafe-relationship": "UNSAFE_DOCX_RELATIONSHIP",
    "duplicate-part": "DUPLICATE_DOCX_PART",
  };
  return reasons[error.failure];
}

function packageReason(error: OoxmlPackageError): RejectedDocxExtraction["reason"] {
  const reasons: Record<typeof error.failure, RejectedDocxExtraction["reason"]> = {
    malformed: "MALFORMED_DOCX",
    unsupported: "UNSUPPORTED_DOCX_FEATURE",
    encrypted: "ENCRYPTED_DOCX",
    "unsafe-entry-name": "UNSAFE_DOCX_ENTRY_NAME",
    "duplicate-part": "DUPLICATE_DOCX_PART",
    "macro-enabled": "MACRO_ENABLED_DOCX",
    "entry-limit": "DOCX_PACKAGE_ENTRY_LIMIT_EXCEEDED",
    "compressed-metadata-limit": "DOCX_COMPRESSED_METADATA_LIMIT_EXCEEDED",
    "uncompressed-metadata-limit": "DOCX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED",
  };
  return reasons[error.failure];
}

function rejected(reason: RejectedDocxExtraction["reason"]): RejectedDocxExtraction {
  return { status: "rejected", format: "docx", reason };
}
