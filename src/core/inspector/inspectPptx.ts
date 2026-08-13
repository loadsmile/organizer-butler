import type {
  PptxExtraction,
  PptxMetadataField,
  RejectedPptxExtraction,
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
  opcNamespacedAttribute,
  OpcXmlError,
  type OpcRelationship,
  opcRelationshipPartName,
  parseOpcContentTypes,
  parseOpcRelationships,
  parseOpcXml,
  resolveOpcRelationshipTarget,
} from "./opcXml.js";

type PptxInspectionConfig = {
  maxSourceBytes: number;
  maxPackageEntries: number;
  maxCompressedMetadataBytes: number;
  maxUncompressedMetadataBytes: number;
  maxSlides: number;
  maxMetadataFields: number;
  maxMetadataStringLength: number;
  maxSlideParts: number;
  maxRetainedSlides: number;
  maxSlideCharacters: number;
  maxTextBlocksPerSlide: number;
  maxSlideStructures: number;
};

const CORE_PROPERTIES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DUBLIN_CORE_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const PRESENTATION_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const DOCUMENT_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const DRAWINGML_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set(
  [...DOCUMENT_RELATIONSHIP_NAMESPACES].map((namespace) => `${namespace}/officeDocument`),
);
const SLIDE_RELATIONSHIP_TYPES = new Set(
  [...DOCUMENT_RELATIONSHIP_NAMESPACES].map((namespace) => `${namespace}/slide`),
);
const CORE_PROPERTIES_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const PRESENTATION_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
]);
const SLIDE_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
]);
const MACRO_CONTENT_TYPES = new Set([
  "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
  "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
  "application/vnd.ms-office.vbaProject",
]);
const CORE_PROPERTIES_CONTENT_TYPE = "application/vnd.openxmlformats-package.core-properties+xml";
const ALLOWED_PRESENTATION_RELATIONSHIP_SUFFIXES = new Set([
  "commentAuthors",
  "comments",
  "handoutMaster",
  "image",
  "notesMaster",
  "notesSlide",
  "presProps",
  "slide",
  "slideMaster",
  "tableStyles",
  "theme",
  "viewProps",
]);
const METADATA_FIELDS: ReadonlyArray<{
  key: PptxMetadataField["key"];
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

class PptxRejection extends Error {
  constructor(readonly reason: RejectedPptxExtraction["reason"]) {
    super(reason);
  }
}

export async function inspectPptx(
  filePath: string,
  config: PptxInspectionConfig,
): Promise<PptxExtraction | RejectedPptxExtraction> {
  const source = await readBoundedOoxmlSource(filePath, config.maxSourceBytes, "PPTX");
  if (source === undefined) return rejected("PPTX_SOURCE_TOO_LARGE");

  try {
    const entries = parseOoxmlPackage(source, config.maxPackageEntries);
    const contentTypesEntry = requireOoxmlEntry(entries, "[Content_Types].xml");
    const rootRelationshipsEntry = requireOoxmlEntry(entries, "_rels/.rels");
    const initialParts = readMetadataParts(source, [contentTypesEntry, rootRelationshipsEntry], config);
    const contentTypes = parseContentTypes(initialParts[0]!);
    const rootRelationships = parseOpcRelationships(initialParts[1]!);

    const officeRelationships = rootRelationships.filter((item) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(item.type));
    if (officeRelationships.length !== 1) throw new PptxRejection("MALFORMED_PPTX");
    const presentationPath = resolveOpcRelationshipTarget("", officeRelationships[0]!.target);
    const presentationContentType = contentTypes.get(presentationPath);
    if (presentationContentType === undefined) throw new PptxRejection("MALFORMED_PPTX");
    if (MACRO_CONTENT_TYPES.has(presentationContentType)) throw new PptxRejection("MACRO_ENABLED_PPTX");
    if (!PRESENTATION_CONTENT_TYPES.has(presentationContentType)) {
      throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
    }

    const presentationEntry = requireOoxmlEntry(entries, presentationPath);
    const presentationRelationshipsEntry = requireOoxmlEntry(entries, opcRelationshipPartName(presentationPath));
    const coreRelationships = rootRelationships.filter((item) => item.type === CORE_PROPERTIES_RELATIONSHIP_TYPE);
    if (coreRelationships.length > 1) throw new PptxRejection("MALFORMED_PPTX");

    const selectedEntries = [
      contentTypesEntry,
      rootRelationshipsEntry,
      presentationEntry,
      presentationRelationshipsEntry,
    ];
    let corePropertiesEntry: OoxmlPackageEntry | undefined;
    if (coreRelationships.length === 1) {
      const corePropertiesPath = resolveOpcRelationshipTarget("", coreRelationships[0]!.target);
      if (contentTypes.get(corePropertiesPath) !== CORE_PROPERTIES_CONTENT_TYPE) {
        throw new PptxRejection("MALFORMED_PPTX");
      }
      corePropertiesEntry = requireOoxmlEntry(entries, corePropertiesPath);
      selectedEntries.push(corePropertiesEntry);
    }

    const parts = readMetadataParts(source, selectedEntries, config);
    const slideRelationshipIds = parsePresentation(parts[2]!, config.maxSlides);
    const presentationRelationships = parseOpcRelationships(parts[3]!);
    const slideEntries = validatePresentationRelationships(
      slideRelationshipIds,
      presentationRelationships,
      presentationPath,
      entries,
      contentTypes,
    );
    if (slideEntries.length > config.maxSlideParts) {
      throw new PptxRejection("PPTX_SLIDE_PART_LIMIT_EXCEEDED");
    }
    const slideParts = readMetadataParts(source, slideEntries, config);
    let retainedCharacters = 0;
    let visitedStructures = 0;
    const slides: PptxExtraction["slides"] = [];
    for (const [index, part] of slideParts.entries()) {
      const preview = parseSlideText(part, config, retainedCharacters, visitedStructures);
      visitedStructures += preview.visitedStructures;
      if (slides.length < config.maxRetainedSlides) {
        retainedCharacters += preview.retainedCharacters;
        slides.push({
          slideNumber: index + 1,
          textBlocks: preview.textBlocks,
          textBlocksTruncated: preview.textBlocksTruncated,
          charactersTruncated: preview.charactersTruncated,
        });
      }
    }

    const allMetadata = corePropertiesEntry === undefined ? [] : parseCoreProperties(parts[4]!);
    const retainedMetadata = allMetadata.slice(0, config.maxMetadataFields);
    let metadataStringsTruncated = false;
    const metadata = retainedMetadata.map(({ key, value }): PptxMetadataField => {
      const characters = [...value];
      const truncated = characters.length > config.maxMetadataStringLength;
      metadataStringsTruncated ||= truncated;
      return { key, value: characters.slice(0, config.maxMetadataStringLength).join(""), truncated };
    });

    return {
      status: "extracted",
      format: "pptx",
      presentationFormat: "pptx",
      slideCount: slideRelationshipIds.length,
      metadata,
      metadataFieldsTruncated: allMetadata.length > metadata.length,
      metadataStringsTruncated,
      slides,
      slidesTruncated: slideParts.length > slides.length,
    };
  } catch (error) {
    if (error instanceof PptxRejection) return rejected(error.reason);
    if (error instanceof OoxmlPackageError) return rejected(packageReason(error));
    if (error instanceof OpcXmlError) return rejected(opcReason(error));
    return rejected("MALFORMED_PPTX");
  }
}

function readMetadataParts(source: Buffer, entries: OoxmlPackageEntry[], config: PptxInspectionConfig): Buffer[] {
  return readOoxmlParts(source, entries, {
    maxCompressedBytes: config.maxCompressedMetadataBytes,
    maxUncompressedBytes: config.maxUncompressedMetadataBytes,
  });
}

function parseContentTypes(source: Buffer): Map<string, string> {
  return parseOpcContentTypes(source, (contentType) => {
    if (MACRO_CONTENT_TYPES.has(contentType)) {
      throw new PptxRejection("MACRO_ENABLED_PPTX");
    }
  });
}

function parsePresentation(source: Buffer, maxSlides: number): string[] {
  const slideRelationshipIds: string[] = [];
  const usedIds = new Set<string>();
  let depth = 0;
  parseOpcXml(source, {
    onOpenTag(tag) {
      if (!PRESENTATION_NAMESPACES.has(tag.uri)) throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
      if (depth === 0 && tag.local !== "presentation") throw new PptxRejection("MALFORMED_PPTX");
      depth += 1;
      if (tag.local !== "sldId") return;
      const relationshipId = opcNamespacedAttribute(tag, DOCUMENT_RELATIONSHIP_NAMESPACES, "id");
      if (relationshipId === undefined || usedIds.has(relationshipId)) throw new PptxRejection("MALFORMED_PPTX");
      usedIds.add(relationshipId);
      slideRelationshipIds.push(relationshipId);
      if (slideRelationshipIds.length > maxSlides) throw new PptxRejection("PPTX_SLIDE_LIMIT_EXCEEDED");
    },
    onCloseTag() {
      depth -= 1;
    },
  });
  return slideRelationshipIds;
}

function parseCoreProperties(source: Buffer): PptxMetadataField[] {
  const values = new Map<PptxMetadataField["key"], string>();
  let active: (typeof METADATA_FIELDS)[number] | undefined;
  let depth = 0;
  let text = "";
  parseOpcXml(source, {
    onOpenTag(tag) {
      if (depth === 0 && (tag.uri !== CORE_PROPERTIES_NAMESPACE || tag.local !== "coreProperties")) {
        throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
      }
      depth += 1;
      if (depth !== 2) return;
      const field = METADATA_FIELDS.find((item) => item.namespace === tag.uri && item.local === tag.local);
      if (field === undefined) return;
      if (values.has(field.key)) throw new PptxRejection("MALFORMED_PPTX");
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

function parseSlideText(
  source: Buffer,
  config: PptxInspectionConfig,
  previouslyRetainedCharacters: number,
  previouslyVisitedStructures: number,
): PptxExtraction["slides"][number] & { retainedCharacters: number; visitedStructures: number } {
  const textBlocks: string[] = [];
  const stack: Array<{ uri: string; local: string }> = [];
  let structures = 0;
  let blockCount = 0;
  let block = "";
  let retainedCharacters = 0;
  let charactersTruncated = false;

  const append = (value: string): void => {
    if (blockCount > config.maxTextBlocksPerSlide) return;
    const characters = [...value];
    const available = Math.max(0, config.maxSlideCharacters - previouslyRetainedCharacters - retainedCharacters);
    if (characters.length > available) charactersTruncated = true;
    if (available === 0) return;
    const retained = characters.slice(0, available);
    block += retained.join("");
    retainedCharacters += retained.length;
  };

  parseOpcXml(source, {
    onOpenTag(tag) {
      structures += 1;
      if (previouslyVisitedStructures + structures > config.maxSlideStructures) {
        throw new PptxRejection("PPTX_SLIDE_STRUCTURE_LIMIT_EXCEEDED");
      }
      stack.push({ uri: tag.uri, local: tag.local });
      if (stack.length === 1 && (!PRESENTATION_NAMESPACES.has(tag.uri) || tag.local !== "sld")) {
        throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
      }
      if (isShapeTextParagraph(stack)) {
        blockCount += 1;
        block = "";
      }
    },
    onText(value) {
      if (isSupportedDrawingText(stack)) append(value);
    },
    onCloseTag() {
      if (isShapeTextParagraph(stack) && textBlocks.length < config.maxTextBlocksPerSlide) {
        textBlocks.push(block);
      }
      stack.pop();
    },
  });

  if (stack.length !== 0) throw new PptxRejection("MALFORMED_PPTX");
  return {
    slideNumber: 0,
    textBlocks,
    textBlocksTruncated: blockCount > textBlocks.length,
    charactersTruncated,
    retainedCharacters,
    visitedStructures: structures,
  };
}

function isShapeTextParagraph(stack: Array<{ uri: string; local: string }>): boolean {
  const paragraph = stack.at(-1);
  const textBody = stack.at(-2);
  const shape = stack.at(-3);
  return paragraph !== undefined && DRAWINGML_NAMESPACES.has(paragraph.uri) && paragraph.local === "p" &&
    textBody !== undefined && PRESENTATION_NAMESPACES.has(textBody.uri) && textBody.local === "txBody" &&
    shape !== undefined && PRESENTATION_NAMESPACES.has(shape.uri) && shape.local === "sp";
}

function isSupportedDrawingText(stack: Array<{ uri: string; local: string }>): boolean {
  const text = stack.at(-1);
  const parent = stack.at(-2)!;
  return text !== undefined && DRAWINGML_NAMESPACES.has(text.uri) && text.local === "t" &&
    DRAWINGML_NAMESPACES.has(parent.uri) && (parent.local === "r" || parent.local === "fld") &&
    isShapeTextParagraph(stack.slice(0, -2));
}

function validatePresentationRelationships(
  slideRelationshipIds: string[],
  relationships: OpcRelationship[],
  presentationPath: string,
  entries: Map<string, OoxmlPackageEntry>,
  contentTypes: Map<string, string>,
): OoxmlPackageEntry[] {
  const byId = new Map(relationships.map((item) => [item.id, item]));
  for (const relationship of relationships) {
    const namespace = [...DOCUMENT_RELATIONSHIP_NAMESPACES].find((item) => relationship.type.startsWith(`${item}/`));
    if (namespace === undefined) throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
    const suffix = relationship.type.slice(namespace.length + 1);
    if (!ALLOWED_PRESENTATION_RELATIONSHIP_SUFFIXES.has(suffix)) {
      throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
    }
    const target = resolveOpcRelationshipTarget(presentationPath, relationship.target);
    if (!entries.has(target)) throw new PptxRejection("MALFORMED_PPTX");
  }
  for (const relationshipId of slideRelationshipIds) {
    const relationship = byId.get(relationshipId);
    if (relationship === undefined) throw new PptxRejection("MALFORMED_PPTX");
    if (!SLIDE_RELATIONSHIP_TYPES.has(relationship.type)) {
      throw new PptxRejection("UNSUPPORTED_PPTX_FEATURE");
    }
  }
  return slideRelationshipIds.map((relationshipId) => {
    const relationship = byId.get(relationshipId)!;
    const target = resolveOpcRelationshipTarget(presentationPath, relationship.target);
    if (!SLIDE_CONTENT_TYPES.has(contentTypes.get(target) ?? "")) {
      throw new PptxRejection("MALFORMED_PPTX");
    }
    return requireOoxmlEntry(entries, target);
  });
}

function opcReason(error: OpcXmlError): RejectedPptxExtraction["reason"] {
  const reasons: Record<typeof error.failure, RejectedPptxExtraction["reason"]> = {
    malformed: "MALFORMED_PPTX",
    unsupported: "UNSUPPORTED_PPTX_FEATURE",
    "unsafe-relationship": "UNSAFE_PPTX_RELATIONSHIP",
    "duplicate-part": "DUPLICATE_PPTX_PART",
  };
  return reasons[error.failure];
}

function packageReason(error: OoxmlPackageError): RejectedPptxExtraction["reason"] {
  const reasons: Record<typeof error.failure, RejectedPptxExtraction["reason"]> = {
    malformed: "MALFORMED_PPTX",
    unsupported: "UNSUPPORTED_PPTX_FEATURE",
    encrypted: "ENCRYPTED_PPTX",
    "unsafe-entry-name": "UNSAFE_PPTX_ENTRY_NAME",
    "duplicate-part": "DUPLICATE_PPTX_PART",
    "macro-enabled": "MACRO_ENABLED_PPTX",
    "entry-limit": "PPTX_PACKAGE_ENTRY_LIMIT_EXCEEDED",
    "compressed-metadata-limit": "PPTX_COMPRESSED_METADATA_LIMIT_EXCEEDED",
    "uncompressed-metadata-limit": "PPTX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED",
  };
  return reasons[error.failure];
}

function rejected(reason: RejectedPptxExtraction["reason"]): RejectedPptxExtraction {
  return { status: "rejected", format: "pptx", reason };
}
