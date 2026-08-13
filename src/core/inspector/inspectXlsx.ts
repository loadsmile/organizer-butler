import type {
  RejectedXlsxExtraction,
  XlsxCellPreview,
  XlsxExtraction,
  XlsxRowPreview,
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
  maxWorksheetParts: number;
  maxRetainedSheets: number;
  maxRowsPerSheet: number;
  maxCellsPerRow: number;
  maxCharacters: number;
  maxSharedStringStructures: number;
  maxWorksheetStructures: number;
};

type WorkbookSheet = { name: string; relationshipId: string };
type XmlName = { uri: string; local: string };
type ParsedCell = Omit<XlsxCellPreview, "truncated"> | undefined;
type CellState = {
  reference: string;
  column: number;
  type: string | undefined;
  formula: boolean;
  value: string | undefined;
  valueSeen: boolean;
  inlineText: string | undefined;
  inlineTextSeen: boolean;
};

const WORKBOOK_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const DOCUMENT_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = relationshipTypes("officeDocument");
const WORKSHEET_RELATIONSHIP_TYPES = relationshipTypes("worksheet");
const SHARED_STRINGS_RELATIONSHIP_TYPES = relationshipTypes("sharedStrings");
const WORKBOOK_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.ms-excel.sheet.main+xml",
]);
const WORKSHEET_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
]);
const SHARED_STRINGS_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
]);
const MACRO_CONTENT_TYPES = new Set([
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  "application/vnd.ms-excel.template.macroEnabled.main+xml",
  "application/vnd.ms-office.vbaProject",
]);
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/;
const INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;
const CELL_REFERENCE_PATTERN = /^([A-Z]+)([1-9]\d*)$/;

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
    const initialParts = readSelectedParts(source, [contentTypesEntry, rootRelationshipsEntry], config);
    const contentTypes = parseContentTypes(initialParts[0]!);
    const rootRelationships = parseOpcRelationships(initialParts[1]!);

    const officeRelationships = rootRelationships.filter((item) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(item.type));
    if (officeRelationships.length !== 1) throw new XlsxRejection("MALFORMED_XLSX");
    const workbookPath = resolveOpcRelationshipTarget("", officeRelationships[0]!.target);
    const workbookContentType = contentTypes.get(workbookPath);
    if (workbookContentType === undefined) throw new XlsxRejection("MALFORMED_XLSX");
    if (MACRO_CONTENT_TYPES.has(workbookContentType)) throw new XlsxRejection("MACRO_ENABLED_XLSX");
    if (!WORKBOOK_CONTENT_TYPES.has(workbookContentType)) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");

    const workbookEntry = requireOoxmlEntry(entries, workbookPath);
    const workbookRelationshipsEntry = requireOoxmlEntry(entries, opcRelationshipPartName(workbookPath));
    const workbookParts = readSelectedParts(source, [workbookEntry, workbookRelationshipsEntry], config);
    const sheets = parseWorkbook(workbookParts[0]!, config.maxWorksheets);
    const workbookRelationships = parseOpcRelationships(workbookParts[1]!);
    const { worksheetEntries, sharedStringsEntry } = validateWorkbookRelationships(
      sheets,
      workbookRelationships,
      workbookPath,
      entries,
      contentTypes,
    );
    if (worksheetEntries.length > config.maxWorksheetParts) {
      throw new XlsxRejection("XLSX_WORKSHEET_PART_LIMIT_EXCEEDED");
    }

    const selectedEntries = [
      contentTypesEntry,
      rootRelationshipsEntry,
      workbookEntry,
      workbookRelationshipsEntry,
      ...worksheetEntries,
      ...(sharedStringsEntry === undefined ? [] : [sharedStringsEntry]),
    ];
    const selectedParts = readSelectedParts(source, selectedEntries, config);
    const worksheetParts = selectedParts.slice(4, 4 + worksheetEntries.length);
    const sharedStringsPart = sharedStringsEntry === undefined ? undefined : selectedParts.at(-1);
    const sharedStrings = sharedStringsPart === undefined
      ? undefined
      : parseSharedStrings(sharedStringsPart, config.maxSharedStringStructures);

    let retainedCharacters = 0;
    let visitedWorksheetStructures = 0;
    const sheetPreviews: XlsxExtraction["sheetPreviews"] = [];
    for (const [index, part] of worksheetParts.entries()) {
      const retain = sheetPreviews.length < config.maxRetainedSheets;
      const parsed = parseWorksheet(
        part!,
        sharedStrings,
        config,
        retain,
        retainedCharacters,
        visitedWorksheetStructures,
      );
      visitedWorksheetStructures += parsed.visitedStructures;
      if (retain) {
        retainedCharacters += parsed.retainedCharacters;
        sheetPreviews.push({
          sheetNumber: index + 1,
          rows: parsed.rows,
          rowsTruncated: parsed.rowsTruncated,
          charactersTruncated: parsed.charactersTruncated,
        });
      }
    }

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
      sheetPreviews,
      sheetPreviewsTruncated: worksheetParts.length > sheetPreviews.length,
    };
  } catch (error) {
    if (error instanceof XlsxRejection) return rejected(error.reason);
    if (error instanceof OoxmlPackageError) return rejected(packageReason(error));
    if (error instanceof OpcXmlError) return rejected(opcReason(error));
    return rejected("MALFORMED_XLSX");
  }
}

function readSelectedParts(source: Buffer, entries: OoxmlPackageEntry[], config: XlsxInspectionConfig): Buffer[] {
  return readOoxmlParts(source, entries, {
    maxCompressedBytes: config.maxCompressedMetadataBytes,
    maxUncompressedBytes: config.maxUncompressedMetadataBytes,
  });
}

function parseContentTypes(source: Buffer): Map<string, string> {
  return parseOpcContentTypes(source, (contentType) => {
    if (MACRO_CONTENT_TYPES.has(contentType)) throw new XlsxRejection("MACRO_ENABLED_XLSX");
  });
}

function parseWorkbook(source: Buffer, maxWorksheets: number): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  const usedIds = new Set<string>();
  let depth = 0;
  parseOpcXml(source, {
    onOpenTag(tag) {
      if (!WORKBOOK_NAMESPACES.has(tag.uri)) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
      if (depth === 0 && tag.local !== "workbook") throw new XlsxRejection("MALFORMED_XLSX");
      depth += 1;
      if (tag.local !== "sheet") return;
      const name = opcAttribute(tag, "name");
      const relationshipId = opcNamespacedAttribute(tag, DOCUMENT_RELATIONSHIP_NAMESPACES, "id");
      if (name === undefined || relationshipId === undefined || name.length === 0 || usedIds.has(relationshipId)) {
        throw new XlsxRejection("MALFORMED_XLSX");
      }
      usedIds.add(relationshipId);
      sheets.push({ name, relationshipId });
      if (sheets.length > maxWorksheets) throw new XlsxRejection("XLSX_WORKSHEET_LIMIT_EXCEEDED");
    },
    onCloseTag() {
      depth -= 1;
    },
  });
  return sheets;
}

function parseSharedStrings(source: Buffer, maxStructures: number): string[] {
  const values: string[] = [];
  const stack: XmlName[] = [];
  let structures = 0;
  let itemText: string | undefined;
  let itemHasText = false;
  parseOpcXml(source, {
    onOpenTag(tag) {
      structures += 1;
      if (structures > maxStructures) throw new XlsxRejection("XLSX_SHARED_STRING_STRUCTURE_LIMIT_EXCEEDED");
      stack.push({ uri: tag.uri, local: tag.local });
      if (!WORKBOOK_NAMESPACES.has(tag.uri)) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
      if (stack.length === 1 && tag.local !== "sst") throw new XlsxRejection("MALFORMED_XLSX");
      if (isDirectSharedStringItem(stack)) {
        itemText = "";
        itemHasText = false;
      } else if (isDirectSharedStringText(stack)) {
        if (itemText === undefined || itemHasText) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
        itemHasText = true;
      } else if (insideSharedStringItem(stack)) {
        throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
      }
    },
    onText(value) {
      if (isDirectSharedStringText(stack)) itemText! += value;
    },
    onCloseTag() {
      if (isDirectSharedStringItem(stack)) {
        if (!itemHasText) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
        values.push(itemText!);
        itemText = undefined;
      }
      stack.pop();
    },
  });
  if (stack.length !== 0) throw new XlsxRejection("MALFORMED_XLSX");
  return values;
}

function parseWorksheet(
  source: Buffer,
  sharedStrings: string[] | undefined,
  config: XlsxInspectionConfig,
  retain: boolean,
  previouslyRetainedCharacters: number,
  previouslyVisitedStructures: number,
): {
  rows: XlsxRowPreview[];
  rowsTruncated: boolean;
  charactersTruncated: boolean;
  retainedCharacters: number;
  visitedStructures: number;
} {
  const stack: XmlName[] = [];
  const rows: XlsxRowPreview[] = [];
  let structures = 0;
  let rowCount = 0;
  let lastRowNumber = 0;
  let currentRowNumber: number | undefined;
  let currentCells: ParsedCell[] = [];
  let lastColumn = 0;
  let currentCell: CellState | undefined;
  let textTarget: "value" | "inline" | undefined;
  let retainedCharacters = 0;
  let charactersTruncated = false;

  parseOpcXml(source, {
    onOpenTag(tag) {
      structures += 1;
      if (previouslyVisitedStructures + structures > config.maxWorksheetStructures) {
        throw new XlsxRejection("XLSX_WORKSHEET_STRUCTURE_LIMIT_EXCEEDED");
      }
      stack.push({ uri: tag.uri, local: tag.local });
      if (stack.length === 1 && (!WORKBOOK_NAMESPACES.has(tag.uri) || tag.local !== "worksheet")) {
        throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
      }
      if (isDirectWorksheetRow(stack)) {
        const row = parsePositiveInteger(opcAttribute(tag, "r"));
        if (row === undefined || row <= lastRowNumber) throw new XlsxRejection("MALFORMED_XLSX");
        currentRowNumber = row;
        currentCells = [];
        lastColumn = 0;
      } else if (isDirectWorksheetCell(stack)) {
        if (currentRowNumber === undefined) throw new XlsxRejection("MALFORMED_XLSX");
        const reference = opcAttribute(tag, "r");
        const parsedReference = parseCellReference(reference);
        if (parsedReference === undefined || parsedReference.row !== currentRowNumber || parsedReference.column <= lastColumn) {
          throw new XlsxRejection("MALFORMED_XLSX");
        }
        currentCell = {
          reference: reference!,
          column: parsedReference.column,
          type: opcAttribute(tag, "t"),
          formula: false,
          value: undefined,
          valueSeen: false,
          inlineText: undefined,
          inlineTextSeen: false,
        };
      } else if (currentCell !== undefined && isDirectCellChild(stack, "f")) {
        currentCell.formula = true;
      } else if (currentCell !== undefined && isDirectCellChild(stack, "v")) {
        if (currentCell.valueSeen) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
        currentCell.valueSeen = true;
        currentCell.value = "";
        textTarget = "value";
      } else if (currentCell !== undefined && isDirectCellChild(stack, "is")) {
        if (currentCell.inlineText !== undefined) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
        currentCell.inlineText = "";
      } else if (currentCell !== undefined && isDirectInlineText(stack)) {
        if (currentCell.inlineText === undefined || currentCell.inlineTextSeen) {
          throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
        }
        currentCell.inlineTextSeen = true;
        textTarget = "inline";
      } else if (currentCell !== undefined && isInsideCell(stack) && !isInsideFormula(stack)) {
        throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
      }
    },
    onText(value) {
      if (textTarget === "value") currentCell!.value! += value;
      else if (textTarget === "inline") currentCell!.inlineText! += value;
    },
    onCloseTag() {
      if (isDirectCellChild(stack, "v") || isDirectInlineText(stack)) textTarget = undefined;
      if (isDirectWorksheetCell(stack)) {
        const parsed = finishCell(currentCell!, sharedStrings);
        currentCells.push(parsed);
        lastColumn = currentCell!.column;
        currentCell = undefined;
      } else if (isDirectWorksheetRow(stack)) {
        rowCount += 1;
        const scalarCells = currentCells.filter((cell): cell is NonNullable<ParsedCell> => cell !== undefined);
        if (retain && rows.length < config.maxRowsPerSheet) {
          const retained = scalarCells.slice(0, config.maxCellsPerRow).map((cell): XlsxCellPreview => {
            if (typeof cell.value === "boolean") return { ...cell, truncated: false };
            const characters = [...cell.value];
            const available = Math.max(0, config.maxCharacters - previouslyRetainedCharacters - retainedCharacters);
            const truncated = characters.length > available;
            charactersTruncated ||= truncated;
            const value = characters.slice(0, available).join("");
            retainedCharacters += Math.min(characters.length, available);
            return { ...cell, value, truncated };
          });
          rows.push({
            rowNumber: currentRowNumber!,
            cells: retained,
            cellsTruncated: scalarCells.length > retained.length,
          });
        }
        lastRowNumber = currentRowNumber!;
        currentRowNumber = undefined;
      }
      stack.pop();
    },
  });
  if (stack.length !== 0 || currentRowNumber !== undefined || currentCell !== undefined) {
    throw new XlsxRejection("MALFORMED_XLSX");
  }
  return {
    rows,
    rowsTruncated: retain && rowCount > rows.length,
    charactersTruncated,
    retainedCharacters,
    visitedStructures: structures,
  };
}

function finishCell(
  cell: CellState,
  sharedStrings: string[] | undefined,
): ParsedCell {
  if (cell.formula) return undefined;
  if (cell.type === undefined || cell.type === "n") {
    if (!cell.valueSeen && cell.inlineText === undefined) return undefined;
    if (!cell.valueSeen || cell.inlineText !== undefined || !NUMBER_PATTERN.test(cell.value!)) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    return { reference: cell.reference, type: "number", value: cell.value! };
  }
  if (cell.type === "b") {
    if (!cell.valueSeen || cell.inlineText !== undefined || (cell.value !== "0" && cell.value !== "1")) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    return { reference: cell.reference, type: "boolean", value: cell.value === "1" };
  }
  if (cell.type === "s") {
    if (!cell.valueSeen || cell.inlineText !== undefined || !INDEX_PATTERN.test(cell.value!)) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    const index = Number(cell.value);
    if (!Number.isSafeInteger(index) || sharedStrings?.[index] === undefined) {
      throw new XlsxRejection("MALFORMED_XLSX");
    }
    return { reference: cell.reference, type: "string", value: sharedStrings[index]! };
  }
  if (cell.type === "inlineStr") {
    if (cell.valueSeen || cell.inlineText === undefined || !cell.inlineTextSeen) {
      throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    }
    return { reference: cell.reference, type: "string", value: cell.inlineText };
  }
  throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
}

function validateWorkbookRelationships(
  sheets: WorkbookSheet[],
  relationships: OpcRelationship[],
  workbookPath: string,
  entries: Map<string, OoxmlPackageEntry>,
  contentTypes: Map<string, string>,
): { worksheetEntries: OoxmlPackageEntry[]; sharedStringsEntry?: OoxmlPackageEntry } {
  const byId = new Map(relationships.map((item) => [item.id, item]));
  const usedIds = new Set<string>();
  const worksheetEntries = sheets.map((sheet) => {
    const relationship = byId.get(sheet.relationshipId);
    if (relationship === undefined || usedIds.has(sheet.relationshipId)) throw new XlsxRejection("MALFORMED_XLSX");
    if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type)) throw new XlsxRejection("UNSUPPORTED_XLSX_FEATURE");
    const target = resolveOpcRelationshipTarget(workbookPath, relationship.target);
    if (!WORKSHEET_CONTENT_TYPES.has(contentTypes.get(target) ?? "")) throw new XlsxRejection("MALFORMED_XLSX");
    usedIds.add(sheet.relationshipId);
    return requireOoxmlEntry(entries, target);
  });
  const sharedRelationships = relationships.filter((item) => SHARED_STRINGS_RELATIONSHIP_TYPES.has(item.type));
  if (sharedRelationships.length > 1) throw new XlsxRejection("MALFORMED_XLSX");
  if (sharedRelationships.length === 0) return { worksheetEntries };
  const target = resolveOpcRelationshipTarget(workbookPath, sharedRelationships[0]!.target);
  if (!SHARED_STRINGS_CONTENT_TYPES.has(contentTypes.get(target) ?? "")) throw new XlsxRejection("MALFORMED_XLSX");
  return { worksheetEntries, sharedStringsEntry: requireOoxmlEntry(entries, target) };
}

function relationshipTypes(suffix: string): Set<string> {
  return new Set([...DOCUMENT_RELATIONSHIP_NAMESPACES].map((namespace) => `${namespace}/${suffix}`));
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseCellReference(reference: string | undefined): { column: number; row: number } | undefined {
  const match = reference?.match(CELL_REFERENCE_PATTERN);
  if (match === undefined || match === null) return undefined;
  let column = 0;
  for (const character of match[1]!) {
    column = column * 26 + character.charCodeAt(0) - 64;
    if (!Number.isSafeInteger(column)) return undefined;
  }
  const row = parsePositiveInteger(match[2]);
  return row === undefined ? undefined : { column, row };
}

function isDirectSharedStringItem(stack: XmlName[]): boolean {
  return stack.length === 2 && stack[0]!.local === "sst" && stack[1]!.local === "si";
}

function isDirectSharedStringText(stack: XmlName[]): boolean {
  return stack.length === 3 && isDirectSharedStringItem(stack.slice(0, 2)) && stack[2]!.local === "t";
}

function insideSharedStringItem(stack: XmlName[]): boolean {
  return stack.length > 2 && isDirectSharedStringItem(stack.slice(0, 2));
}

function isDirectWorksheetRow(stack: XmlName[]): boolean {
  return stack.length === 3 && WORKBOOK_NAMESPACES.has(stack[0]!.uri) && stack[0]!.local === "worksheet" &&
    WORKBOOK_NAMESPACES.has(stack[1]!.uri) && stack[1]!.local === "sheetData" &&
    WORKBOOK_NAMESPACES.has(stack[2]!.uri) && stack[2]!.local === "row";
}

function isDirectWorksheetCell(stack: XmlName[]): boolean {
  return stack.length === 4 && isDirectWorksheetRow(stack.slice(0, 3)) &&
    WORKBOOK_NAMESPACES.has(stack[3]!.uri) && stack[3]!.local === "c";
}

function isDirectCellChild(stack: XmlName[], local: string): boolean {
  return stack.length === 5 && isDirectWorksheetCell(stack.slice(0, 4)) &&
    WORKBOOK_NAMESPACES.has(stack[4]!.uri) && stack[4]!.local === local;
}

function isDirectInlineText(stack: XmlName[]): boolean {
  return stack.length === 6 && isDirectCellChild(stack.slice(0, 5), "is") &&
    WORKBOOK_NAMESPACES.has(stack[5]!.uri) && stack[5]!.local === "t";
}

function isInsideCell(stack: XmlName[]): boolean {
  return stack.length > 4 && isDirectWorksheetCell(stack.slice(0, 4));
}

function isInsideFormula(stack: XmlName[]): boolean {
  return stack.length >= 5 && isDirectCellChild(stack.slice(0, 5), "f");
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
