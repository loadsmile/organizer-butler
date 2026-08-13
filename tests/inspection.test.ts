import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
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
  maxPdfSourceBytes: 10_000,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInbox(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-inspection-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("inspectFile", () => {
  it("extracts bounded TXT content without exposing a path", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "invoice-notes.txt"), "0123456789");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, {
      ...inspectionConfig,
      maxExtractedTextLength: 5,
    });

    assert.equal("path" in inspection.file, false);
    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "text",
      excerpt: "01234",
      extractedTextLength: 10,
      truncated: true,
    });
    assert.deepEqual(inspection.ruleEvidence.map((item) => item.ruleId), ["filename.invoice"]);
  });

  it("handles empty Markdown files", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "notes.md"), "");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, inspectionConfig);

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "markdown",
      excerpt: "",
      extractedTextLength: 0,
      truncated: false,
    });
  });

  it("returns metadata and evidence for unsupported formats", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "travel-receipt.bin"), "not parsed");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, inspectionConfig);

    assert.deepEqual(inspection.extraction, { status: "unsupported", reason: "UNSUPPORTED_FORMAT" });
    assert.deepEqual(inspection.ruleEvidence.map((item) => item.ruleId), ["filename.receipt"]);
    assert.equal("path" in inspection.file, false);
  });

  it("rejects fabricated IDs with a structured OrganizerError", async () => {
    const inbox = await createInbox();
    const registry = new FileRegistry(inbox);

    await assert.rejects(
      inspectFile(registry, "file_fabricated", inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "INVALID_FILE_ID",
    );
  });

  it("rejects files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "notes.txt");
    await writeFile(filePath, "before");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, "after and larger");

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });

  it("handles empty CSV files", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "empty.csv"), "");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, inspectionConfig);

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "csv",
      headers: [],
      sampledRows: [],
      sampledRowCount: 0,
      totalRowCount: 0,
      rowsTruncated: false,
      columnsTruncated: false,
      fieldsTruncated: false,
    });
    assert.equal("path" in inspection.file, false);
  });

  it("handles header-only CSV files", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "contacts.csv"), "name,email");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, inspectionConfig);

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "csv");
    assert.deepEqual(inspection.extraction.headers, ["name", "email"]);
    assert.deepEqual(inspection.extraction.sampledRows, []);
    assert.equal(inspection.extraction.totalRowCount, 0);
  });

  it("parses quoted CSV fields, escaped quotes, and embedded newlines", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "quoted.csv"), 'name,note\r\n"Ada","a,b"\r\n"Bo","x""y\nz"\r\n');
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, {
      ...inspectionConfig,
      maxCsvFieldLength: 20,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "csv");
    assert.deepEqual(inspection.extraction.headers, ["name", "note"]);
    assert.deepEqual(inspection.extraction.sampledRows, [
      ["Ada", "a,b"],
      ["Bo", 'x"y\nz'],
    ]);
  });

  it("bounds CSV fields, sampled rows, and columns while counting all rows", async () => {
    const inbox = await createInbox();
    await writeFile(
      path.join(inbox, "bounded.csv"),
      "column-one,b,c,d\n123456,2,3,4\nsecond,2,3,4\nthird,2,3,4\n",
    );
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, inspectionConfig);

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "csv",
      headers: ["colum", "b", "c"],
      sampledRows: [
        ["12345", "2", "3"],
        ["secon", "2", "3"],
      ],
      sampledRowCount: 2,
      totalRowCount: 3,
      rowsTruncated: true,
      columnsTruncated: true,
      fieldsTruncated: true,
    });
  });

  it("returns a safe result for malformed CSV without partial content", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "malformed.csv"), 'name,note\nAda,"unterminated');
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const inspection = await inspectFile(registry, file!.fileId, inspectionConfig);

    assert.deepEqual(inspection.extraction, {
      status: "malformed",
      format: "csv",
      reason: "MALFORMED_CSV",
    });
    assert.equal("path" in inspection.file, false);
  });

  it("rejects CSV files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "contacts.csv");
    await writeFile(filePath, "name\nAda");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, "name\nAda\nGrace");

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
