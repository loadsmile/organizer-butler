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
  maxDocxSourceBytes: 100_000,
  maxDocxPackageEntries: 20,
  maxDocxCompressedMetadataBytes: 20_000,
  maxDocxUncompressedMetadataBytes: 20_000,
  maxDocxMetadataFields: 6,
  maxDocxMetadataStringLength: 20,
  maxPptxSourceBytes: 100_000,
  maxPptxPackageEntries: 20,
  maxPptxCompressedMetadataBytes: 20_000,
  maxPptxUncompressedMetadataBytes: 20_000,
  maxPptxSlides: 10,
  maxPptxMetadataFields: 6,
  maxPptxMetadataStringLength: 20,
};

type ZipEntryInput = {
  name: string;
  content?: string;
  flags?: number;
  externalAttributes?: number;
  startDisk?: number;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInbox(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-zip-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createZip(entries: ZipEntryInput[], endOverrides: { disk?: number; entryCount?: number } = {}): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content ?? "");
    const flags = (entry.flags ?? 0) | 0x800;
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    localRecords.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(entry.startDisk ?? 0, 34);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  const entryCount = endOverrides.entryCount ?? entries.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(endOverrides.disk ?? 0, 4);
  end.writeUInt16LE(endOverrides.disk ?? 0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

async function inspectZipBuffer(buffer: Buffer, config = inspectionConfig) {
  const inbox = await createInbox();
  await writeFile(path.join(inbox, "archive.zip"), buffer);
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  return inspectFile(registry, file!.fileId, config);
}

describe("ZIP inspection", () => {
  it("lists an empty archive", async () => {
    const inspection = await inspectZipBuffer(createZip([]));

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "zip",
      entries: [],
      entryCount: 0,
    });
    assert.equal("path" in inspection.file, false);
  });

  it("lists file and directory metadata without extracting content", async () => {
    const inspection = await inspectZipBuffer(
      createZip([
        { name: "documents/", externalAttributes: 0x10 },
        { name: "documents/note.txt", content: "hello" },
      ]),
    );

    assert.deepEqual(inspection.extraction, {
      status: "extracted",
      format: "zip",
      entries: [
        {
          filename: "documents/",
          isDirectory: true,
          compressedSize: 0,
          uncompressedSize: 0,
          compressionMethod: 0,
        },
        {
          filename: "documents/note.txt",
          isDirectory: false,
          compressedSize: 5,
          uncompressedSize: 5,
          compressionMethod: 0,
        },
      ],
      entryCount: 2,
    });
  });

  it("rejects archives exceeding size, entry, filename, or metadata limits", async () => {
    const archive = createZip([{ name: "one.txt" }, { name: "two.txt" }]);
    const limits = [
      { config: { ...inspectionConfig, maxZipArchiveSize: archive.length - 1 }, reason: "ARCHIVE_TOO_LARGE" },
      { config: { ...inspectionConfig, maxZipEntries: 1 }, reason: "TOO_MANY_ENTRIES" },
      { config: { ...inspectionConfig, maxZipFilenameLength: 3 }, reason: "ENTRY_NAME_TOO_LONG" },
      { config: { ...inspectionConfig, maxZipMetadataRead: 1 }, reason: "METADATA_TOO_LARGE" },
    ] as const;

    for (const limit of limits) {
      const inspection = await inspectZipBuffer(archive, limit.config);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "zip", reason: limit.reason });
    }
  });

  it("rejects traversal names using slash or backslash separators", async () => {
    for (const name of ["../secret.txt", "folder/../../secret.txt", "..\\secret.txt"]) {
      const inspection = await inspectZipBuffer(createZip([{ name }]));
      assert.deepEqual(inspection.extraction, {
        status: "rejected",
        format: "zip",
        reason: "UNSAFE_ENTRY_NAME",
      });
    }
  });

  it("rejects Unix and Windows absolute entry names", async () => {
    for (const name of ["/etc/passwd", "C:\\Windows\\system.ini"]) {
      const inspection = await inspectZipBuffer(createZip([{ name }]));
      assert.equal(inspection.extraction.status, "rejected");
      assert.equal(inspection.extraction.format, "zip");
      assert.equal(inspection.extraction.reason, "UNSAFE_ENTRY_NAME");
    }
  });

  it("rejects ambiguous and separator-equivalent duplicate names", async () => {
    for (const archive of [
      createZip([{ name: "folder//note.txt" }]),
      createZip([{ name: "folder/note.txt" }, { name: "folder\\note.txt" }]),
    ]) {
      const inspection = await inspectZipBuffer(archive);
      assert.equal(inspection.extraction.status, "rejected");
      assert.equal(inspection.extraction.format, "zip");
      assert.equal(inspection.extraction.reason, "AMBIGUOUS_ENTRY_NAME");
    }
  });

  it("rejects malformed archives without partial metadata", async () => {
    const inspection = await inspectZipBuffer(Buffer.from("not a zip"));

    assert.deepEqual(inspection.extraction, {
      status: "rejected",
      format: "zip",
      reason: "MALFORMED_ZIP",
    });
    assert.equal("entries" in inspection.extraction, false);
  });

  it("rejects encrypted, multi-disk, and ZIP64 archives", async () => {
    const encrypted = await inspectZipBuffer(createZip([{ name: "secret.txt", flags: 0x1 }]));
    const multiDisk = await inspectZipBuffer(createZip([{ name: "note.txt" }], { disk: 1 }));
    const zip64 = await inspectZipBuffer(createZip([], { entryCount: 0xffff }));

    assert.equal(encrypted.extraction.status, "rejected");
    assert.equal(encrypted.extraction.format, "zip");
    assert.equal(encrypted.extraction.reason, "ENCRYPTED_ZIP");
    assert.equal(multiDisk.extraction.status, "rejected");
    assert.equal(multiDisk.extraction.format, "zip");
    assert.equal(multiDisk.extraction.reason, "MULTI_DISK_ZIP");
    assert.equal(zip64.extraction.status, "rejected");
    assert.equal(zip64.extraction.format, "zip");
    assert.equal(zip64.extraction.reason, "ZIP64_UNSUPPORTED");
  });

  it("rejects ZIP files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "archive.zip");
    await writeFile(filePath, createZip([{ name: "before.txt" }]));
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, createZip([{ name: "after-longer.txt" }]));

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
