import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInbox(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-pdf-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createPdf(options: { pageCount?: number; metadata?: boolean } = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  for (let page = 0; page < (options.pageCount ?? 1); page += 1) document.addPage([100, 100]);
  if (options.metadata) {
    document.setTitle("A😀 very long title");
    document.setAuthor("Fixture Author");
    document.setSubject("Fixture Subject");
    document.setKeywords(["safe", "fixture"]);
    document.setCreator("Fixture Creator");
    document.setProducer("Fixture Producer");
    const info = document.context.lookup(document.context.trailerInfo.Info, PDFDict);
    if (info) {
      info.set(PDFName.of("SecretCustomField"), PDFString.of("must not be exposed"));
    }
  }
  return document.save({ addDefaultPage: false, useObjectStreams: false });
}

function createEncryptedPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    "<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
  ];
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(parts.join("")));
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(parts.join(""));
  parts.push(`xref\n0 ${objects.length + 1}\n`);
  parts.push("0000000000 65535 f \n");
  for (const offset of offsets.slice(1)) {
    parts.push(`${offset.toString().padStart(10, "0")} 00000 n \n`);
  }
  parts.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00000000000000000000000000000000> <00000000000000000000000000000000>] >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return Buffer.from(parts.join(""), "ascii");
}

async function inspectPdf(source: Uint8Array, config = inspectionConfig) {
  const inbox = await createInbox();
  await writeFile(path.join(inbox, "document.pdf"), source);
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  return inspectFile(registry, file!.fileId, config);
}

describe("PDF inspection", () => {
  it("returns bounded metadata for a minimal valid PDF without exposing a path", async () => {
    const inspection = await inspectPdf(await createPdf());

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "pdf",
      version: "1.7",
      pageCount: 1,
      encrypted: false,
      metadata: [],
      metadataFieldsTruncated: false,
      metadataStringsTruncated: false,
    });
    assert.equal("path" in inspection.file, false);
  });

  it("accepts zero-page PDFs and counts multiple pages", async () => {
    const empty = await inspectPdf(await createPdf({ pageCount: 0 }));
    const multiple = await inspectPdf(await createPdf({ pageCount: 3 }));

    assert.equal(empty.extraction.status, "extracted");
    assert.equal(empty.extraction.format, "pdf");
    assert.equal(empty.extraction.pageCount, 0);
    assert.equal(multiple.extraction.status, "extracted");
    assert.equal(multiple.extraction.format, "pdf");
    assert.equal(multiple.extraction.pageCount, 3);
  });

  it("retains only allowlisted metadata with bounded fields and Unicode strings", async () => {
    const inspection = await inspectPdf(await createPdf({ metadata: true }), {
      ...inspectionConfig,
      maxPdfMetadataFields: 2,
      maxPdfMetadataStringLength: 4,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "pdf");
    assert.deepEqual(inspection.extraction.metadata, [
      { key: "title", value: "A😀 v", truncated: true },
      { key: "author", value: "Fixt", truncated: true },
    ]);
    assert.equal(inspection.extraction.metadataFieldsTruncated, true);
    assert.equal(inspection.extraction.metadataStringsTruncated, true);
    assert.equal(JSON.stringify(inspection.extraction).includes("SecretCustomField"), false);
    assert.equal(JSON.stringify(inspection.extraction).includes("must not be exposed"), false);
  });

  it("rejects a PDF exceeding the source-byte limit before parsing", async () => {
    const source = await createPdf();
    const inspection = await inspectPdf(source, { ...inspectionConfig, maxPdfSourceBytes: source.length - 1 });

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "pdf",
      reason: "PDF_SOURCE_TOO_LARGE",
    });
  });

  it("rejects a PDF exceeding the indirect-object limit without partial metadata", async () => {
    const inspection = await inspectPdf(await createPdf({ pageCount: 2, metadata: true }), {
      ...inspectionConfig,
      maxPdfObjects: 1,
    });

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "pdf",
      reason: "PDF_OBJECT_LIMIT_EXCEEDED",
    });
    assert.equal("metadata" in inspection.extraction, false);
  });

  it("allows zero retained metadata fields without exposing values", async () => {
    const inspection = await inspectPdf(await createPdf({ metadata: true }), {
      ...inspectionConfig,
      maxPdfMetadataFields: 0,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "pdf");
    assert.deepEqual(inspection.extraction.metadata, []);
    assert.equal(inspection.extraction.metadataFieldsTruncated, true);
  });

  it("rejects malformed PDFs without parser details or partial metadata", async () => {
    const inspection = await inspectPdf(Buffer.from("%PDF-1.7\nnot a valid document"));

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "pdf",
      reason: "MALFORMED_PDF",
    });
  });

  it("rejects encrypted PDFs without attempting decryption", async () => {
    const inspection = await inspectPdf(createEncryptedPdf());

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "pdf",
      reason: "ENCRYPTED_PDF",
    });
  });

  it("rejects unsupported PDF versions without parsing metadata", async () => {
    const source = Buffer.from(await createPdf({ metadata: true }));
    source.write("%PDF-2.0", 0, "ascii");
    const inspection = await inspectPdf(source);

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "pdf",
      reason: "UNSUPPORTED_PDF_FEATURE",
    });
  });

  it("rejects PDF files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "document.pdf");
    await writeFile(filePath, await createPdf());
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, await createPdf({ pageCount: 2 }));

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
