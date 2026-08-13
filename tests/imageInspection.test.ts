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
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-image-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function createExif(fields: { tag: number; value: string }[]): Buffer {
  const headerLength = 8 + 2 + fields.length * 12 + 4;
  const values = fields.map(({ value }) => Buffer.from(`${value}\0`, "utf8"));
  const source = Buffer.alloc(headerLength + values.reduce((total, value) => total + (value.length > 4 ? value.length : 0), 0));
  source.write("II", 0, "ascii");
  source.writeUInt16LE(42, 2);
  source.writeUInt32LE(8, 4);
  source.writeUInt16LE(fields.length, 8);
  let valueOffset = headerLength;
  fields.forEach(({ tag }, index) => {
    const entryOffset = 10 + index * 12;
    const value = values[index]!;
    source.writeUInt16LE(tag, entryOffset);
    source.writeUInt16LE(2, entryOffset + 2);
    source.writeUInt32LE(value.length, entryOffset + 4);
    if (value.length <= 4) {
      value.copy(source, entryOffset + 8);
    } else {
      source.writeUInt32LE(valueOffset, entryOffset + 8);
      value.copy(source, valueOffset);
      valueOffset += value.length;
    }
  });
  return Buffer.concat([Buffer.from("Exif\0\0", "ascii"), source]);
}

function createJpeg(options: {
  width?: number;
  height?: number;
  metadata?: boolean;
  privatePayload?: string;
  sofMarker?: number;
  extraSegments?: number;
} = {}): Buffer {
  const width = options.width ?? 3;
  const height = options.height ?? 2;
  const sof = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  const segments = options.metadata
    ? [jpegSegment(0xe1, createExif([
        { tag: 0x010e, value: "Fixture description" },
        { tag: 0x013b, value: "Fixture author" },
        { tag: 0x8298, value: "Fixture copyright" },
        { tag: 0x8825, value: "private GPS pointer" },
      ]))]
    : [];
  for (let index = 0; index < (options.extraSegments ?? 0); index += 1) {
    segments.push(jpegSegment(0xe2, Buffer.alloc(0)));
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segments,
    jpegSegment(options.sofMarker ?? 0xc0, sof),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from(options.privatePayload ?? "opaque pixels", "utf8"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function createPng(options: {
  width?: number;
  height?: number;
  text?: [string, string][];
  privatePayload?: string;
  extraChunks?: number;
  unsupportedChunk?: string;
} = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width ?? 4, 0);
  header.writeUInt32BE(options.height ?? 5, 4);
  header[8] = 8;
  header[9] = 6;
  const textChunks = (options.text ?? []).map(([keyword, value]) =>
    pngChunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]))
  );
  const extraChunks = Array.from({ length: options.extraChunks ?? 0 }, () => pngChunk("vpAg"));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...textChunks,
    ...extraChunks,
    ...(options.unsupportedChunk ? [pngChunk(options.unsupportedChunk)] : []),
    pngChunk("IDAT", Buffer.from(options.privatePayload ?? "opaque pixels", "utf8")),
    pngChunk("IEND"),
  ]);
}

async function inspectImage(filename: string, source: Buffer, config = inspectionConfig) {
  const inbox = await createInbox();
  await writeFile(path.join(inbox, filename), source);
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  return inspectFile(registry, file!.fileId, config);
}

describe("image inspection", () => {
  it("returns JPEG dimensions and evidence without exposing paths or pixel payloads", async () => {
    const inspection = await inspectImage("family-photo.jpg", createJpeg({ privatePayload: "secret pixel bytes" }));

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "jpeg",
      width: 3,
      height: 2,
      metadata: [],
      metadataFieldsTruncated: false,
      metadataStringsTruncated: false,
    });
    assert.deepEqual(inspection.ruleEvidence.map((item) => item.ruleId), ["extension.image"]);
    assert.equal("path" in inspection.file, false);
    assert.equal(JSON.stringify(inspection).includes("secret pixel bytes"), false);
  });

  it("returns PNG dimensions without decoding IDAT", async () => {
    const inspection = await inspectImage("fixture.png", createPng({ privatePayload: "not compressed pixels" }));

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "png",
      width: 4,
      height: 5,
      metadata: [],
      metadataFieldsTruncated: false,
      metadataStringsTruncated: false,
    });
    assert.equal(JSON.stringify(inspection).includes("not compressed pixels"), false);
  });

  it("retains only allowlisted JPEG EXIF metadata", async () => {
    const inspection = await inspectImage("fixture.jpeg", createJpeg({ metadata: true }));

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "jpeg");
    assert.deepEqual(inspection.extraction.metadata, [
      { key: "author", value: "Fixture author", truncated: false },
      { key: "description", value: "Fixture description", truncated: false },
      { key: "copyright", value: "Fixture copyright", truncated: false },
    ]);
    assert.equal(JSON.stringify(inspection.extraction).includes("GPS"), false);
  });

  it("bounds allowlisted PNG metadata fields and Unicode strings", async () => {
    const inspection = await inspectImage("fixture.png", createPng({ text: [
      ["Title", "Café title"],
      ["Author", "Fixture author"],
      ["Description", "private description"],
      ["Comment", "must be omitted"],
    ] }), {
      ...inspectionConfig,
      maxImageMetadataFields: 2,
      maxImageMetadataStringLength: 4,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "png");
    assert.deepEqual(inspection.extraction.metadata, [
      { key: "title", value: "Café", truncated: true },
      { key: "author", value: "Fixt", truncated: true },
    ]);
    assert.equal(inspection.extraction.metadataFieldsTruncated, true);
    assert.equal(inspection.extraction.metadataStringsTruncated, true);
    assert.equal(JSON.stringify(inspection.extraction).includes("must be omitted"), false);
  });

  it("rejects both formats above the source-byte limit before parsing", async () => {
    const jpeg = createJpeg();
    const png = createPng();
    const jpegInspection = await inspectImage("fixture.jpg", jpeg, { ...inspectionConfig, maxImageSourceBytes: jpeg.length - 1 });
    const pngInspection = await inspectImage("fixture.png", png, { ...inspectionConfig, maxImageSourceBytes: png.length - 1 });

    assert.deepEqual(jpegInspection.extraction, { status: "rejected", format: "jpeg", reason: "IMAGE_SOURCE_TOO_LARGE" });
    assert.deepEqual(pngInspection.extraction, { status: "rejected", format: "png", reason: "IMAGE_SOURCE_TOO_LARGE" });
  });

  it("rejects invalid, over-dimension, and excessive-pixel declarations without partial metadata", async () => {
    const invalid = await inspectImage("invalid.png", createPng({ width: 0, text: [["Title", "hidden"]] }));
    const dimension = await inspectImage("wide.jpg", createJpeg({ width: 101, metadata: true }), {
      ...inspectionConfig,
      maxImageDimension: 100,
    });
    const pixels = await inspectImage("large.png", createPng({ width: 20, height: 20, text: [["Title", "hidden"]] }), {
      ...inspectionConfig,
      maxImagePixels: 399,
    });

    assert.deepEqual(invalid.extraction, { status: "rejected", format: "png", reason: "INVALID_IMAGE_DIMENSIONS" });
    assert.deepEqual(dimension.extraction, { status: "rejected", format: "jpeg", reason: "IMAGE_DIMENSION_LIMIT_EXCEEDED" });
    assert.deepEqual(pixels.extraction, { status: "rejected", format: "png", reason: "IMAGE_PIXEL_LIMIT_EXCEEDED" });
    assert.equal("metadata" in pixels.extraction, false);
  });

  it("rejects JPEG marker and PNG chunk count limits", async () => {
    const jpeg = await inspectImage("fixture.jpg", createJpeg({ extraSegments: 2 }), {
      ...inspectionConfig,
      maxImageStructures: 2,
    });
    const png = await inspectImage("fixture.png", createPng({ text: [["Title", "one"], ["Author", "two"]] }), {
      ...inspectionConfig,
      maxImageStructures: 3,
    });

    assert.deepEqual(jpeg.extraction, { status: "rejected", format: "jpeg", reason: "IMAGE_STRUCTURE_LIMIT_EXCEEDED" });
    assert.deepEqual(png.extraction, { status: "rejected", format: "png", reason: "IMAGE_STRUCTURE_LIMIT_EXCEEDED" });
  });

  it("allows zero retained image metadata fields", async () => {
    const inspection = await inspectImage("fixture.png", createPng({ text: [["Title", "hidden"]] }), {
      ...inspectionConfig,
      maxImageMetadataFields: 0,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "png");
    assert.deepEqual(inspection.extraction.metadata, []);
    assert.equal(inspection.extraction.metadataFieldsTruncated, true);
  });

  it("rejects malformed JPEG segment lengths and missing end markers", async () => {
    const invalidLength = createJpeg();
    invalidLength.writeUInt16BE(0xffff, 4);
    const lengthInspection = await inspectImage("length.jpg", invalidLength);
    const endInspection = await inspectImage("end.jpg", createJpeg().subarray(0, -2));

    assert.deepEqual(lengthInspection.extraction, { status: "rejected", format: "jpeg", reason: "MALFORMED_JPEG" });
    assert.deepEqual(endInspection.extraction, { status: "rejected", format: "jpeg", reason: "MALFORMED_JPEG" });
  });

  it("rejects invalid JPEG frame and scan component declarations", async () => {
    const duplicateFrameComponents = createJpeg();
    const sofOffset = duplicateFrameComponents.indexOf(Buffer.from([0xff, 0xc0]));
    const duplicateSof = Buffer.from([8, 0, 2, 0, 3, 2, 1, 0x11, 0, 1, 0x11, 0]);
    const duplicateFrame = Buffer.concat([
      duplicateFrameComponents.subarray(0, sofOffset),
      jpegSegment(0xc0, duplicateSof),
      duplicateFrameComponents.subarray(sofOffset + 13),
    ]);
    const invalidScan = createJpeg();
    const scanOffset = invalidScan.indexOf(Buffer.from([0xff, 0xda]));
    invalidScan[scanOffset + 5] = 2;

    const frameInspection = await inspectImage("frame.jpg", duplicateFrame);
    const scanInspection = await inspectImage("scan.jpg", invalidScan);
    assert.deepEqual(frameInspection.extraction, { status: "rejected", format: "jpeg", reason: "MALFORMED_JPEG" });
    assert.deepEqual(scanInspection.extraction, { status: "rejected", format: "jpeg", reason: "MALFORMED_JPEG" });
  });

  it("rejects malformed PNG lengths, CRCs, and ordering", async () => {
    const invalidLength = createPng();
    invalidLength.writeUInt32BE(0xffffffff, 8);
    const invalidCrc = createPng();
    invalidCrc[29] = invalidCrc[29]! ^ 0xff;
    const wrongOrder = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IDAT", Buffer.alloc(0)),
      pngChunk("IEND"),
    ]);

    for (const source of [invalidLength, invalidCrc, wrongOrder]) {
      const inspection = await inspectImage("malformed.png", source);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "png", reason: "MALFORMED_PNG" });
    }
  });

  it("rejects progressive and arithmetic-coded JPEG structures", async () => {
    const progressive = await inspectImage("progressive.jpg", createJpeg({ sofMarker: 0xc2 }));
    const arithmetic = await inspectImage("arithmetic.jpg", Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xcc, Buffer.alloc(0)),
      Buffer.from([0xff, 0xd9]),
    ]));

    assert.deepEqual(progressive.extraction, { status: "rejected", format: "jpeg", reason: "UNSUPPORTED_JPEG_FEATURE" });
    assert.deepEqual(arithmetic.extraction, { status: "rejected", format: "jpeg", reason: "UNSUPPORTED_JPEG_FEATURE" });
  });

  it("rejects animated and unknown critical PNG structures", async () => {
    const animated = await inspectImage("animated.png", createPng({ unsupportedChunk: "acTL" }));
    const critical = await inspectImage("critical.png", createPng({ unsupportedChunk: "ABCD" }));

    assert.deepEqual(animated.extraction, { status: "rejected", format: "png", reason: "UNSUPPORTED_PNG_FEATURE" });
    assert.deepEqual(critical.extraction, { status: "rejected", format: "png", reason: "UNSUPPORTED_PNG_FEATURE" });
  });

  it("rejects unvalidated ancillary PNG structures and malformed text keywords", async () => {
    const profile = await inspectImage("profile.png", createPng({ unsupportedChunk: "iCCP" }));
    const malformedKeyword = await inspectImage("keyword.png", createPng({ text: [["Bad  Keyword", "hidden"]] }));

    assert.deepEqual(profile.extraction, { status: "rejected", format: "png", reason: "UNSUPPORTED_PNG_FEATURE" });
    assert.deepEqual(malformedKeyword.extraction, { status: "rejected", format: "png", reason: "MALFORMED_PNG" });
  });

  it("rejects image files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "fixture.png");
    await writeFile(filePath, createPng());
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, createPng({ width: 9 }));

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
