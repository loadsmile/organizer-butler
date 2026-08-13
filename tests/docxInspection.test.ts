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
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-docx-"));
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

function createDocx(options: {
  metadata?: Partial<Record<"title" | "subject" | "creator" | "keywords" | "description" | "lastModifiedBy", string>>;
  coreXml?: string;
  includeCore?: boolean;
  macroEnabled?: boolean;
  documentContentType?: string;
  encrypted?: boolean;
  rootTarget?: string;
  documentRelationships?: string;
  duplicateDocument?: boolean;
  extraEntries?: ZipEntry[];
} = {}): Buffer {
  const includeCore = options.includeCore ?? (options.metadata !== undefined || options.coreXml !== undefined);
  const metadata = options.metadata ?? {};
  const coreXml = options.coreXml ?? `<?xml version="1.0" encoding="UTF-8"?>
    <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
      xmlns:dc="http://purl.org/dc/elements/1.1/">
      ${metadata.title === undefined ? "" : `<dc:title>${xmlEscape(metadata.title)}</dc:title>`}
      ${metadata.subject === undefined ? "" : `<dc:subject>${xmlEscape(metadata.subject)}</dc:subject>`}
      ${metadata.creator === undefined ? "" : `<dc:creator>${xmlEscape(metadata.creator)}</dc:creator>`}
      ${metadata.keywords === undefined ? "" : `<cp:keywords>${xmlEscape(metadata.keywords)}</cp:keywords>`}
      ${metadata.description === undefined ? "" : `<dc:description>${xmlEscape(metadata.description)}</dc:description>`}
      ${metadata.lastModifiedBy === undefined ? "" : `<cp:lastModifiedBy>${xmlEscape(metadata.lastModifiedBy)}</cp:lastModifiedBy>`}
    </cp:coreProperties>`;
  const documentContentType = options.documentContentType ?? (options.macroEnabled
    ? "application/vnd.ms-word.document.macroEnabled.main+xml"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
  const document = { name: "word/document.xml", content: "body text must not be read", method: 99 };
  return createZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Override PartName="/word/document.xml" ContentType="${documentContentType}"/>
          ${includeCore ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : ""}
        </Types>`,
      flags: options.encrypted ? 1 : 0,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${xmlEscape(options.rootTarget ?? "word/document.xml")}"/>
          ${includeCore ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : ""}
        </Relationships>`,
    },
    document,
    ...(options.duplicateDocument ? [document] : []),
    ...(options.documentRelationships === undefined ? [] : [{ name: "word/_rels/document.xml.rels", content: options.documentRelationships }]),
    ...(includeCore ? [{ name: "docProps/core.xml", content: coreXml }] : []),
    ...(options.macroEnabled ? [{ name: "word/vbaProject.bin", content: "macro" }] : []),
    ...(options.extraEntries ?? []),
  ]);
}

async function inspectDocx(source: Buffer, config = inspectionConfig) {
  const inbox = await createInbox();
  await writeFile(path.join(inbox, "document.docx"), source);
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  return inspectFile(registry, file!.fileId, config);
}

describe("DOCX inspection", () => {
  it("returns a minimal document and ordered allowlisted metadata", async () => {
    const minimal = await inspectDocx(createDocx());
    const populated = await inspectDocx(createDocx({
      metadata: {
        title: "Plan",
        subject: "Subject",
        creator: "Zoë",
        keywords: "one, two",
        description: "Summary",
        lastModifiedBy: "Editor",
      },
    }));

    assert.deepEqual(minimal.extraction, {
      status: "extracted",
      format: "docx",
      documentFormat: "docx",
      metadata: [],
      metadataFieldsTruncated: false,
      metadataStringsTruncated: false,
    });
    assert.equal(populated.extraction.status, "extracted");
    assert.equal(populated.extraction.format, "docx");
    assert.deepEqual(populated.extraction.metadata.map(({ key, value }) => ({ key, value })), [
      { key: "title", value: "Plan" },
      { key: "subject", value: "Subject" },
      { key: "creator", value: "Zoë" },
      { key: "keywords", value: "one, two" },
      { key: "description", value: "Summary" },
      { key: "lastModifiedBy", value: "Editor" },
    ]);
    assert.equal("path" in populated.file, false);
  });

  it("bounds retained fields and Unicode values with explicit flags", async () => {
    const inspection = await inspectDocx(createDocx({ metadata: { title: "A😀long", subject: "Second" } }), {
      ...inspectionConfig,
      maxDocxMetadataFields: 1,
      maxDocxMetadataStringLength: 2,
    });

    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(inspection.extraction.format, "docx");
    assert.deepEqual(inspection.extraction.metadata, [{ key: "title", value: "A😀", truncated: true }]);
    assert.equal(inspection.extraction.metadataFieldsTruncated, true);
    assert.equal(inspection.extraction.metadataStringsTruncated, true);
  });

  it("rejects source, package-entry, compressed, and uncompressed limits", async () => {
    const source = createDocx({ metadata: { title: "Title" } });
    const cases = [
      [{ ...inspectionConfig, maxDocxSourceBytes: source.length - 1 }, "DOCX_SOURCE_TOO_LARGE"],
      [{ ...inspectionConfig, maxDocxPackageEntries: 3 }, "DOCX_PACKAGE_ENTRY_LIMIT_EXCEEDED"],
      [{ ...inspectionConfig, maxDocxCompressedMetadataBytes: 1 }, "DOCX_COMPRESSED_METADATA_LIMIT_EXCEEDED"],
      [{ ...inspectionConfig, maxDocxUncompressedMetadataBytes: 1 }, "DOCX_UNCOMPRESSED_METADATA_LIMIT_EXCEEDED"],
    ] as const;
    for (const [config, reason] of cases) {
      const inspection = await inspectDocx(source, config);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "docx", reason });
    }
  });

  it("rejects malformed ZIP and metadata XML without partial metadata", async () => {
    for (const source of [
      Buffer.from("not a zip"),
      createDocx({ coreXml: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">' }),
    ]) {
      const inspection = await inspectDocx(source);
      assert.deepEqual(inspection.extraction, { status: "rejected", format: "docx", reason: "MALFORMED_DOCX" });
      assert.equal("metadata" in inspection.extraction, false);
    }
  });

  it("rejects encrypted, macro-enabled, and unsupported documents", async () => {
    const encrypted = await inspectDocx(createDocx({ encrypted: true }));
    const macro = await inspectDocx(createDocx({ macroEnabled: true }));
    const unsupported = await inspectDocx(createDocx({ documentContentType: "application/unsupported" }));
    assert.deepEqual(encrypted.extraction, { status: "rejected", format: "docx", reason: "ENCRYPTED_DOCX" });
    assert.deepEqual(macro.extraction, { status: "rejected", format: "docx", reason: "MACRO_ENABLED_DOCX" });
    assert.deepEqual(unsupported.extraction, { status: "rejected", format: "docx", reason: "UNSUPPORTED_DOCX_FEATURE" });
  });

  it("rejects unsafe entry names, relationship traversal, and external relationships", async () => {
    const relationships = `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
      </Relationships>`;
    const unsafeEntry = await inspectDocx(createDocx({ extraEntries: [{ name: "../secret", content: "x" }] }));
    const traversal = await inspectDocx(createDocx({ rootTarget: "../document.xml" }));
    const external = await inspectDocx(createDocx({ documentRelationships: relationships }));
    assert.deepEqual(unsafeEntry.extraction, { status: "rejected", format: "docx", reason: "UNSAFE_DOCX_ENTRY_NAME" });
    assert.deepEqual(traversal.extraction, { status: "rejected", format: "docx", reason: "UNSAFE_DOCX_RELATIONSHIP" });
    assert.deepEqual(external.extraction, { status: "rejected", format: "docx", reason: "UNSAFE_DOCX_RELATIONSHIP" });
  });

  it("rejects duplicate package parts", async () => {
    const inspection = await inspectDocx(createDocx({ duplicateDocument: true }));
    assert.deepEqual(inspection.extraction, { status: "rejected", format: "docx", reason: "DUPLICATE_DOCX_PART" });
  });

  it("does not read body content or expose custom properties", async () => {
    const inspection = await inspectDocx(createDocx({
      metadata: { title: "Safe" },
      extraEntries: [{ name: "docProps/custom.xml", content: "private custom metadata", method: 99 }],
    }));
    assert.equal(inspection.extraction.status, "extracted");
    assert.equal(JSON.stringify(inspection.extraction).includes("body text"), false);
    assert.equal(JSON.stringify(inspection.extraction).includes("private custom metadata"), false);
  });

  it("rejects DOCX files changed after scanning", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "document.docx");
    await writeFile(filePath, createDocx({ metadata: { title: "Before" } }));
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await writeFile(filePath, createDocx({ metadata: { title: "After and larger" } }));

    await assert.rejects(
      inspectFile(registry, file!.fileId, inspectionConfig),
      (error: unknown) => error instanceof OrganizerError && error.code === "FILE_CHANGED",
    );
  });
});
