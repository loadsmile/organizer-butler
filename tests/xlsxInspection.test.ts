import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { inspectFile } from "../src/core/inspector/inspectFile.js";
import { FileRegistry } from "../src/core/scanner/scanDownloads.js";
import { OrganizerError } from "../src/domain/error.js";

const temporaryDirectories: string[] = [];
const inspectionConfig = {
  maxExtractedTextLength: 100,
  maxCsvSampledRows: 2,
  maxCsvColumns: 3,
  maxCsvFieldLength: 5,
  maxJsonSourceBytes: 1_000,
  maxJsonDepth: 3,
  maxJsonObjectKeys: 3,
  maxJsonArrayItems: 3,
  maxJsonStringLength: 10,
  maxZipArchiveSize: 10_000,
  maxZipEntries: 10,
  maxZipFilenameLength: 100,
  maxZipMetadataRead: 2_000,
  maxPdfSourceBytes: 100_000,
  maxPdfObjects: 100,
  maxPdfMetadataFields: 6,
  maxPdfMetadataStringLength: 20,
  maxXlsxSourceBytes: 100_000,
  maxXlsxPackageEntries: 20,
  maxXlsxCompressedMetadataBytes: 20_000,
  maxXlsxUncompressedMetadataBytes: 20_000,
  maxXlsxWorksheets: 10,
  maxXlsxRetainedSheetNames: 10,
  maxXlsxSheetNameLength: 20,
  maxXlsxWorksheetParts: 10,
  maxXlsxRetainedSheets: 10,
  maxXlsxRowsPerSheet: 10,
  maxXlsxCellsPerRow: 10,
  maxXlsxCharacters: 100,
  maxXlsxSharedStringStructures: 100,
  maxXlsxWorksheetStructures: 100,
  maxDocxSourceBytes: 100_000,
  maxDocxPackageEntries: 20,
  maxDocxCompressedMetadataBytes: 20_000,
  maxDocxUncompressedMetadataBytes: 20_000,
  maxDocxMetadataFields: 6,
  maxDocxMetadataStringLength: 20,
  maxDocxBodyParts: 1,
  maxDocxBodyCharacters: 100,
  maxDocxBodyParagraphs: 10,
  maxDocxBodyStructures: 100,
  maxPptxSourceBytes: 100_000,
  maxPptxPackageEntries: 20,
  maxPptxCompressedMetadataBytes: 20_000,
  maxPptxUncompressedMetadataBytes: 20_000,
  maxPptxSlides: 10,
  maxPptxMetadataFields: 6,
  maxPptxMetadataStringLength: 20,
  maxPptxSlideParts: 10,
  maxPptxRetainedSlides: 10,
  maxPptxSlideCharacters: 100,
  maxPptxTextBlocksPerSlide: 10,
  maxPptxSlideStructures: 100,
  maxImageSourceBytes: 100_000,
  maxImageDimension: 10_000,
  maxImagePixels: 10_000_000,
  maxImageStructures: 100,
  maxImageMetadataFields: 4,
  maxImageMetadataStringLength: 20,
};

type ZipEntry = { name: string; content: string; flags?: number; method?: number };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInbox(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-xlsx-"));
  temporaryDirectories.push(directory);
  return directory;
}

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: ZipEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const flags = (entry.flags ?? 0) | 0x800;
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    localRecords.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length;
  }
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function worksheetXml(rows = "", extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>${rows}</sheetData>${extra}
    </worksheet>`;
}

function sharedStringsXml(values: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      ${values.map((value) => `<si><t>${xmlEscape(value)}</t></si>`).join("")}
    </sst>`;
}

function createXlsx(
  sheetNames: string[],
  options: {
    workbookXml?: string;
    rootTarget?: string;
    externalSheet?: boolean;
    macroEnabled?: boolean;
    duplicateWorkbook?: boolean;
    encrypted?: boolean;
    worksheetXmls?: string[];
    worksheetTargets?: string[];
    sharedStringsXml?: string;
    sharedStringsTarget?: string;
    sharedStringsContentType?: string;
    sharedStringsRelationshipType?: string;
    workbookRelationshipsXml?: string;
    extraEntries?: ZipEntry[];
  } = {},
): Buffer {
  const contentType = options.macroEnabled
    ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const workbook = options.workbookXml ?? `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>${sheetNames.map((name, index) => `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
    </workbook>`;
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Override PartName="/xl/workbook.xml" ContentType="${contentType}"/>
          ${sheetNames.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
          ${options.sharedStringsXml === undefined ? "" : `<Override PartName="/xl/sharedStrings.xml" ContentType="${options.sharedStringsContentType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"}"/>`}
        </Types>`,
      flags: options.encrypted ? 1 : 0,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${xmlEscape(options.rootTarget ?? "xl/workbook.xml")}"/>
        </Relationships>`,
    },
    { name: "xl/workbook.xml", content: workbook },
    ...(options.duplicateWorkbook ? [{ name: "xl/workbook.xml", content: workbook }] : []),
    {
      name: "xl/_rels/workbook.xml.rels",
      content: options.workbookRelationshipsXml ?? `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          ${sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${xmlEscape(options.worksheetTargets?.[index] ?? `worksheets/sheet${index + 1}.xml`)}"${options.externalSheet && index === 0 ? ' TargetMode="External"' : ""}/>`).join("")}
          ${options.sharedStringsXml === undefined ? "" : `<Relationship Id="shared" Type="${options.sharedStringsRelationshipType ?? "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"}" Target="${xmlEscape(options.sharedStringsTarget ?? "sharedStrings.xml")}"/>`}
        </Relationships>`,
    },
    ...sheetNames.map((_, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: options.worksheetXmls?.[index] ?? worksheetXml(),
    })),
    ...(options.sharedStringsXml === undefined ? [] : [{ name: "xl/sharedStrings.xml", content: options.sharedStringsXml }]),
    ...(options.macroEnabled ? [{ name: "xl/vbaProject.bin", content: "macro" }] : []),
    ...(options.extraEntries ?? []),
  ];
  return createZip(entries);
}

async function inspectXlsx(source: Buffer, config = inspectionConfig) {
  const inbox = await createInbox();
  await writeFile(path.join(inbox, "workbook.xlsx"), source);
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  return inspectFile(registry, file!.fileId, config);
}

describe("XLSX inspection", () => {
  it("returns ordered bounded sheet metadata for empty, single, and non-ASCII workbooks", async () => {
    const empty = await inspectXlsx(createXlsx([]));
    const populated = await inspectXlsx(createXlsx(["Summary", "日本語😀"]));

    assert.deepEqual(empty.extraction, {
      status: "extracted",
      format: "xlsx",
      workbookFormat: "xlsx",
      sheets: [],
      sheetCount: 0,
      sheetNamesTruncated: false,
      sheetNameStringsTruncated: false,
      sheetPreviews: [],
      sheetPreviewsTruncated: false,
    });
    assert.equal(populated.extraction.status, "extracted");
    assert.equal(populated.extraction.format, "xlsx");
    assert.deepEqual(populated.extraction.sheets, [
      { name: "Summary", truncated: false },
      { name: "日本語😀", truncated: false },
    ]);
    assert.deepEqual(populated.extraction.sheetPreviews, [
      { sheetNumber: 1, rows: [], rowsTruncated: false, charactersTruncated: false },
      { sheetNumber: 2, rows: [], rowsTruncated: false, charactersTruncated: false },
    ]);
    assert.deepEqual(populated.ruleEvidence.map((item) => item.ruleId), ["extension.spreadsheet"]);
    assert.equal("path" in populated.file, false);
  });

  it("bounds retained sheet names and Unicode string lengths with explicit flags", async () => {
    const inspection = await inspectXlsx(createXlsx(["A😀long", "Second"]), {
      ...inspectionConfig,
      maxXlsxRetainedSheetNames: 1,
      maxXlsxSheetNameLength: 2,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "xlsx");
    assert.deepEqual(inspection.extraction.sheets, [{ name: "A😀", truncated: true }]);
    assert.equal(inspection.extraction.sheetCount, 2);
    assert.equal(inspection.extraction.sheetNamesTruncated, true);
    assert.equal(inspection.extraction.sheetNameStringsTruncated, true);
  });

  it("extracts sparse ordered scalar cells and preserves number lexemes", async () => {
    const inspection = await inspectXlsx(createXlsx(["Later", "First"], {
      worksheetTargets: ["worksheets/sheet2.xml", "worksheets/sheet1.xml"],
      worksheetXmls: [
        worksheetXml('<row r="2"><c r="B2" t="inlineStr"><is><t>First sheet</t></is></c></row>'),
        worksheetXml(`<row r="3">
          <c r="A3"><v>001.2300</v></c>
          <c r="C3" t="n"><v>1e+09</v></c>
          <c r="F3" t="b"><v>1</v></c>
          <c r="G3" t="inlineStr"><is><t>Later sheet</t></is></c>
        </row><row r="10"><c r="Z10"><v>-0</v></c></row>`),
      ],
    }));

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "xlsx");
    assert.deepEqual(inspection.extraction.sheetPreviews, [
      {
        sheetNumber: 1,
        rows: [{
          rowNumber: 3,
          cells: [
            { reference: "A3", type: "number", value: "001.2300", truncated: false },
            { reference: "C3", type: "number", value: "1e+09", truncated: false },
            { reference: "F3", type: "boolean", value: true, truncated: false },
            { reference: "G3", type: "string", value: "Later sheet", truncated: false },
          ],
          cellsTruncated: false,
        }, {
          rowNumber: 10,
          cells: [{ reference: "Z10", type: "number", value: "-0", truncated: false }],
          cellsTruncated: false,
        }],
        rowsTruncated: false,
        charactersTruncated: false,
      },
      {
        sheetNumber: 2,
        rows: [{
          rowNumber: 2,
          cells: [{ reference: "B2", type: "string", value: "First sheet", truncated: false }],
          cellsTruncated: false,
        }],
        rowsTruncated: false,
        charactersTruncated: false,
      },
    ]);
  });

  it("resolves plain shared strings and omits formulas and cached formula values", async () => {
    const inspection = await inspectXlsx(createXlsx(["Data"], {
      sharedStringsXml: sharedStringsXml(["Alpha😀", "Beta"]),
      worksheetXmls: [worksheetXml(`<row r="1">
        <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>
        <c r="C1"><f>PRIVATE+FORMULA</f><v>999</v></c>
      </row>`)],
    }));

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "xlsx");
    assert.deepEqual(inspection.extraction.sheetPreviews[0]?.rows[0], {
      rowNumber: 1,
      cells: [
        { reference: "A1", type: "string", value: "Alpha😀", truncated: false },
        { reference: "B1", type: "string", value: "Beta", truncated: false },
      ],
      cellsTruncated: false,
    });
    assert.equal(JSON.stringify(inspection.extraction).includes("PRIVATE"), false);
    assert.equal(JSON.stringify(inspection.extraction).includes("999"), false);
  });

  it("bounds retained sheets, rows, cells, and aggregate Unicode characters", async () => {
    const inspection = await inspectXlsx(createXlsx(["One", "Two"], {
      worksheetXmls: [
        worksheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>A😀B</t></is></c><c r="B1"><v>22</v></c></row><row r="2"><c r="A2"><v>3</v></c></row>'),
        worksheetXml('<row r="1"><c r="A1"><v>4</v></c></row>'),
      ],
    }), {
      ...inspectionConfig,
      maxXlsxRetainedSheets: 1,
      maxXlsxRowsPerSheet: 1,
      maxXlsxCellsPerRow: 1,
      maxXlsxCharacters: 2,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "xlsx");
    assert.deepEqual(inspection.extraction.sheetPreviews, [{
      sheetNumber: 1,
      rows: [{
        rowNumber: 1,
        cells: [{ reference: "A1", type: "string", value: "A😀", truncated: true }],
        cellsTruncated: true,
      }],
      rowsTruncated: true,
      charactersTruncated: true,
    }]);
    assert.equal(inspection.extraction.sheetPreviewsTruncated, true);
  });

  it("rejects source, package-entry, compressed, uncompressed, and worksheet limits", async () => {
    const source = createXlsx(["One", "Two"]);
    const cases = [
      [{ ...inspectionConfig, maxXlsxSourceBytes: source.length - 1 }, "XLSX_SOURCE_TOO_LARGE"],
      [{ ...inspectionConfig, maxXlsxPackageEntries: 5 }, "XLSX_PACKAGE_ENTRY_LIMIT_EXCEEDED"],
      [{ ...inspectionConfig, maxXlsxCompressedMetadataBytes: 1 }, "XLSX_COMPRESSED_METADATA_LIMIT_EXCEEDED"],
      [{ ...inspectionConfig, maxXlsxUncompressedMetadataBytes: 1 }, "XLSX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED"],
      [{ ...inspectionConfig, maxXlsxWorksheets: 1 }, "XLSX_WORKSHEET_LIMIT_EXCEEDED"],
    ] as const;
    for (const [config, reason] of cases) {
      const inspection = await inspectXlsx(source, config);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "xlsx", reason });
    }
  });

  it("rejects malformed ZIP and XML without partial metadata", async () => {
    for (const source of [
      Buffer.from("not a zip"),
      createXlsx([], {
        workbookXml: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      }),
    ]) {
      const inspection = await inspectXlsx(source);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "xlsx", reason: "MALFORMED_XLSX" });
      assert.equal("sheets" in inspection.extraction, false);
    }
  });

  it("rejects worksheet part and XML structure limits without partial output", async () => {
    const source = createXlsx(["One", "Two"], {
      worksheetXmls: [worksheetXml('<row r="1"/>'), worksheetXml('<row r="1"/>')],
    });
    const cases = [
      [{ ...inspectionConfig, maxXlsxWorksheetParts: 1 }, "XLSX_WORKSHEET_PART_LIMIT_EXCEEDED"],
      [{ ...inspectionConfig, maxXlsxWorksheetStructures: 2 }, "XLSX_WORKSHEET_STRUCTURE_LIMIT_EXCEEDED"],
    ] as const;
    for (const [config, reason] of cases) {
      const inspection = await inspectXlsx(source, config);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "xlsx", reason });
      assert.equal("sheets" in inspection.extraction, false);
    }

    const shared = await inspectXlsx(createXlsx(["One"], {
      sharedStringsXml: sharedStringsXml(["value"]),
    }), { ...inspectionConfig, maxXlsxSharedStringStructures: 2 });
    assert.deepEqual(shared.extraction, {
      status: "rejected",
      format: "xlsx",
      reason: "XLSX_SHARED_STRING_STRUCTURE_LIMIT_EXCEEDED",
    });
  });

  it("validates malformed worksheet and shared-string XML after retention cutoffs", async () => {
    const malformedSheet = await inspectXlsx(createXlsx(["One", "Two"], {
      worksheetXmls: [worksheetXml(), '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'],
    }), { ...inspectionConfig, maxXlsxRetainedSheets: 1 });
    const malformedShared = await inspectXlsx(createXlsx(["One"], {
      sharedStringsXml: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si>',
    }), { ...inspectionConfig, maxXlsxRetainedSheets: 0 });

    assert.deepEqual(malformedSheet.extraction, { status: "rejected", format: "xlsx", reason: "MALFORMED_XLSX" });
    assert.deepEqual(malformedShared.extraction, { status: "rejected", format: "xlsx", reason: "MALFORMED_XLSX" });
  });

  it("rejects unsupported cell structures and invalid shared-string indexes", async () => {
    const unsupportedCases = [
      createXlsx(["One"], { worksheetXmls: [worksheetXml('<row r="1"><c r="A1" t="str"><v>text</v></c></row>')] }),
      createXlsx(["One"], {
        sharedStringsXml: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>rich</t></r></si></sst>',
      }),
    ];
    for (const source of unsupportedCases) {
      const inspection = await inspectXlsx(source);
      assert.deepEqual(inspection.extraction, {
        status: "rejected",
        format: "xlsx",
        reason: "UNSUPPORTED_XLSX_FEATURE",
      });
    }

    const invalidIndex = await inspectXlsx(createXlsx(["One"], {
      sharedStringsXml: sharedStringsXml(["only"]),
      worksheetXmls: [worksheetXml('<row r="1"><c r="A1" t="s"><v>2</v></c></row>')],
    }));
    assert.deepEqual(invalidIndex.extraction, { status: "rejected", format: "xlsx", reason: "MALFORMED_XLSX" });
  });

  it("rejects encrypted and macro-enabled packages", async () => {
    const encrypted = await inspectXlsx(createXlsx([], { encrypted: true }));
    const macro = await inspectXlsx(createXlsx([], { macroEnabled: true }));
    assert.deepEqual(encrypted.extraction, { status: "rejected", format: "xlsx", reason: "ENCRYPTED_XLSX" });
    assert.deepEqual(macro.extraction, { status: "rejected", format: "xlsx", reason: "MACRO_ENABLED_XLSX" });
  });

  it("rejects unsupported workbook XML namespaces", async () => {
    const inspection = await inspectXlsx(createXlsx([], {
      workbookXml: '<workbook xmlns="urn:unsupported"><sheets/></workbook>',
    }));
    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "xlsx",
      reason: "UNSUPPORTED_XLSX_FEATURE",
    });
  });

  it("rejects unsafe entry names, relationship traversal, and external relationships", async () => {
    const unsafeEntry = await inspectXlsx(createXlsx([], { extraEntries: [{ name: "../secret", content: "x" }] }));
    const traversal = await inspectXlsx(createXlsx([], { rootTarget: "../workbook.xml" }));
    const external = await inspectXlsx(createXlsx(["One"], { externalSheet: true }));
    assert.deepEqual(unsafeEntry.extraction, { status: "rejected", format: "xlsx", reason: "UNSAFE_XLSX_ENTRY_NAME" });
    assert.deepEqual(traversal.extraction, { status: "rejected", format: "xlsx", reason: "UNSAFE_XLSX_RELATIONSHIP" });
    assert.deepEqual(external.extraction, { status: "rejected", format: "xlsx", reason: "UNSAFE_XLSX_RELATIONSHIP" });
  });

  it("rejects duplicate package parts", async () => {
    const inspection = await inspectXlsx(createXlsx([], { duplicateWorkbook: true }));
    assert.deepEqual(inspection.extraction, { status: "rejected", format: "xlsx", reason: "DUPLICATE_XLSX_PART" });
  });

  it("reads only validated preview parts and omits arbitrary package content", async () => {
    const inspection = await inspectXlsx(createXlsx(["Safe"], {
      worksheetXmls: [worksheetXml('<row r="1"><c r="A1"><v>42</v></c></row>', '<extLst><ext uri="private"><private:text xmlns:private="urn:private">Hidden</private:text></ext></extLst>')],
      extraEntries: [{ name: "docProps/custom.xml", content: "private custom metadata", method: 99 }],
    }));
    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(JSON.stringify(inspection.extraction).includes("42"), true);
    assert.equal(JSON.stringify(inspection.extraction).includes("Hidden"), false);
    assert.equal(JSON.stringify(inspection.extraction).includes("private custom metadata"), false);
    assert.equal(JSON.stringify(inspection.extraction).includes("xl/worksheets"), false);
  });

  it("rejects XLSX files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "workbook.xlsx");
    await writeFile(filePath, createXlsx(["Before"]));
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, createXlsx(["After", "Larger"]));

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
