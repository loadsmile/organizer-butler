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
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-json-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function inspectJson(source: string, config = inspectionConfig) {
  const inbox = await createInbox();
  await writeFile(path.join(inbox, "data.json"), source);
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  return inspectFile(registry, file!.fileId, config);
}

describe("JSON inspection", () => {
  it("accepts scalar roots and preserves number lexemes", async () => {
    const values = [
      { source: "null", preview: { type: "null" } },
      { source: "true", preview: { type: "boolean", value: true } },
      { source: "9007199254740993", preview: { type: "number", value: "9007199254740993" } },
      { source: '"hello"', preview: { type: "string", value: "hello", truncated: false } },
    ];

    for (const value of values) {
      const inspection = await inspectJson(value.source);
      assert.equal(inspection.extraction.status, "extracted");
      assert.equal(inspection.extraction.format, "json");
      assert.deepEqual(inspection.extraction.preview, value.preview);
    }
  });

  it("accepts empty objects and arrays", async () => {
    const objectInspection = await inspectJson("{}");
    const arrayInspection = await inspectJson("[]");

    assert.equal(objectInspection.extraction.status, "extracted");
    assert.equal(objectInspection.extraction.format, "json");
    assert.deepEqual(objectInspection.extraction.preview, {
      type: "object",
      entries: [],
      totalKeyCount: 0,
      keysTruncated: false,
    });
    assert.equal(arrayInspection.extraction.status, "extracted");
    assert.equal(arrayInspection.extraction.format, "json");
    assert.deepEqual(arrayInspection.extraction.preview, {
      type: "array",
      items: [],
      totalItemCount: 0,
      itemsTruncated: false,
    });
  });

  it("returns a nested structural preview without exposing a path", async () => {
    const inspection = await inspectJson('{"person":{"name":"Ada","active":true},"scores":[1,null]}');

    assert.equal("path" in inspection.file, false);
    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "json");
    assert.equal(inspection.extraction.depthTruncated, false);
    assert.deepEqual(inspection.extraction.preview, {
      type: "object",
      entries: [
        {
          key: "person",
          keyTruncated: false,
          value: {
            type: "object",
            entries: [
              { key: "name", keyTruncated: false, value: { type: "string", value: "Ada", truncated: false } },
              { key: "active", keyTruncated: false, value: { type: "boolean", value: true } },
            ],
            totalKeyCount: 2,
            keysTruncated: false,
          },
        },
        {
          key: "scores",
          keyTruncated: false,
          value: {
            type: "array",
            items: [{ type: "number", value: "1" }, { type: "null" }],
            totalItemCount: 2,
            itemsTruncated: false,
          },
        },
      ],
      totalKeyCount: 2,
      keysTruncated: false,
    });
  });

  it("bounds retained depth", async () => {
    const inspection = await inspectJson('{"outer":{"inner":{"value":1}}}', {
      ...inspectionConfig,
      maxJsonDepth: 1,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "json");
    assert.equal(inspection.extraction.depthTruncated, true);
    assert.deepEqual(inspection.extraction.preview, {
      type: "object",
      entries: [
        {
          key: "outer",
          keyTruncated: false,
          value: {
            type: "object",
            entries: [
              { key: "inner", keyTruncated: false, value: { type: "truncated", reason: "MAX_DEPTH" } },
            ],
            totalKeyCount: 1,
            keysTruncated: false,
          },
        },
      ],
      totalKeyCount: 1,
      keysTruncated: false,
    });
  });

  it("bounds retained object keys", async () => {
    const inspection = await inspectJson('{"a":1,"b":2,"c":3}', {
      ...inspectionConfig,
      maxJsonObjectKeys: 2,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "json");
    assert.equal(inspection.extraction.objectKeysTruncated, true);
    const preview = inspection.extraction.preview;
    if (preview.type !== "object") assert.fail("Expected an object preview");
    assert.deepEqual(preview.entries.map((entry) => entry.key), ["a", "b"]);
    assert.equal(preview.totalKeyCount, 3);
    assert.equal(preview.keysTruncated, true);
  });

  it("bounds retained array items", async () => {
    const inspection = await inspectJson("[1,2,3]", { ...inspectionConfig, maxJsonArrayItems: 2 });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "json");
    assert.equal(inspection.extraction.arrayItemsTruncated, true);
    const preview = inspection.extraction.preview;
    if (preview.type !== "array") assert.fail("Expected an array preview");
    assert.deepEqual(preview.items, [
      { type: "number", value: "1" },
      { type: "number", value: "2" },
    ]);
    assert.equal(preview.totalItemCount, 3);
    assert.equal(preview.itemsTruncated, true);
  });

  it("bounds retained string length by Unicode characters", async () => {
    const inspection = await inspectJson('"A😀BC"', { ...inspectionConfig, maxJsonStringLength: 3 });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "json");
    assert.equal(inspection.extraction.stringsTruncated, true);
    assert.deepEqual(inspection.extraction.preview, { type: "string", value: "A😀B", truncated: true });
  });

  it("bounds retained object key length", async () => {
    const inspection = await inspectJson('{"alphabet":1}', { ...inspectionConfig, maxJsonStringLength: 3 });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "json");
    assert.equal(inspection.extraction.stringsTruncated, true);
    const preview = inspection.extraction.preview;
    if (preview.type !== "object") assert.fail("Expected an object preview");
    assert.deepEqual(preview.entries[0], {
      key: "alp",
      keyTruncated: true,
      value: { type: "number", value: "1" },
    });
  });

  it("rejects malformed JSON without partial content or parse details", async () => {
    const inspection = await inspectJson('{"secret":"retained","broken":}');

    assert.deepEqual(inspection.extraction, {
      status: "malformed",
      format: "json",
      reason: "MALFORMED_JSON",
    });
    assert.equal("preview" in inspection.extraction, false);
  });

  it("rejects duplicate decoded object keys", async () => {
    const inspection = await inspectJson('{"name":1,"n\\u0061me":2}');

    assert.deepEqual(inspection.extraction, {
      status: "malformed",
      format: "json",
      reason: "DUPLICATE_OBJECT_KEY",
    });
  });

  it("rejects source exceeding the byte limit before parsing", async () => {
    const inspection = await inspectJson('{"value":"😀"}', { ...inspectionConfig, maxJsonSourceBytes: 14 });

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "json",
      reason: "JSON_SOURCE_TOO_LARGE",
    });
  });

  it("rejects excessive nesting without returning partial content", async () => {
    const source = "[".repeat(258) + "null" + "]".repeat(258);
    const inspection = await inspectJson(source);

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "json",
      reason: "JSON_NESTING_TOO_DEEP",
    });
  });

  it("rejects JSON files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "data.json");
    await writeFile(filePath, '{"before":true}');
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, '{"after":"changed"}');

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
