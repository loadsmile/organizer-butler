import { open } from "node:fs/promises";
import { OrganizerError } from "../../domain/error.js";
import type {
  RejectedZipExtraction,
  ZipEntryMetadata,
  ZipExtraction,
} from "../../domain/inspection.js";

type ZipInspectionConfig = {
  maxArchiveSize: number;
  maxEntries: number;
  maxFilenameLength: number;
  maxMetadataRead: number;
};

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_END_RECORD_SIZE = 22 + 65_535;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;

export async function inspectZip(
  filePath: string,
  config: ZipInspectionConfig,
): Promise<ZipExtraction | RejectedZipExtraction> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    if (stats.size > config.maxArchiveSize) {
      return rejected("ARCHIVE_TOO_LARGE");
    }
    if (stats.size < 22) {
      return rejected("MALFORMED_ZIP");
    }

    const tailLength = Math.min(stats.size, MAX_END_RECORD_SIZE);
    const tail = Buffer.alloc(tailLength);
    await handle.read({ buffer: tail, position: stats.size - tailLength });
    const endOffset = findEndRecord(tail);
    if (endOffset === -1) {
      return rejected("MALFORMED_ZIP");
    }

    const diskNumber = tail.readUInt16LE(endOffset + 4);
    const centralDisk = tail.readUInt16LE(endOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(endOffset + 8);
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);

    if (
      entriesOnDisk === ZIP64_16 ||
      entryCount === ZIP64_16 ||
      centralSize === ZIP64_32 ||
      centralOffset === ZIP64_32
    ) {
      return rejected("ZIP64_UNSUPPORTED");
    }
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      return rejected("MULTI_DISK_ZIP");
    }
    if (entryCount > config.maxEntries) {
      return rejected("TOO_MANY_ENTRIES");
    }
    if (centralSize > config.maxMetadataRead) {
      return rejected("METADATA_TOO_LARGE");
    }

    const absoluteEndOffset = stats.size - tailLength + endOffset;
    if (centralOffset + centralSize > absoluteEndOffset) {
      return rejected("MALFORMED_ZIP");
    }

    const central = Buffer.alloc(centralSize);
    await handle.read({ buffer: central, position: centralOffset });
    return parseCentralDirectory(central, entryCount, centralOffset, config.maxFilenameLength);
  } catch (error) {
    throw new OrganizerError("INSPECTION_FAILED", "The ZIP file could not be read for inspection.", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

function findEndRecord(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === END_SIGNATURE &&
      offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
    ) {
      return offset;
    }
  }
  return -1;
}

function parseCentralDirectory(
  central: Buffer,
  entryCount: number,
  centralOffset: number,
  maxFilenameLength: number,
): ZipExtraction | RejectedZipExtraction {
  const entries: ZipEntryMetadata[] = [];
  const normalizedNames = new Set<string>();
  let offset = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return rejected("MALFORMED_ZIP");
    }

    const flags = central.readUInt16LE(offset + 8);
    const compressionMethod = central.readUInt16LE(offset + 10);
    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const filenameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const startDisk = central.readUInt16LE(offset + 34);
    const externalAttributes = central.readUInt32LE(offset + 38);
    const localOffset = central.readUInt32LE(offset + 42);
    const recordLength = 46 + filenameLength + extraLength + commentLength;

    if (offset + recordLength > central.length) {
      return rejected("MALFORMED_ZIP");
    }
    if (flags & 0x1) {
      return rejected("ENCRYPTED_ZIP");
    }
    if (
      compressedSize === ZIP64_32 ||
      uncompressedSize === ZIP64_32 ||
      localOffset === ZIP64_32 ||
      startDisk === ZIP64_16
    ) {
      return rejected("ZIP64_UNSUPPORTED");
    }
    if (startDisk !== 0) {
      return rejected("MULTI_DISK_ZIP");
    }
    if (localOffset >= centralOffset) {
      return rejected("MALFORMED_ZIP");
    }
    if (filenameLength > maxFilenameLength) {
      return rejected("ENTRY_NAME_TOO_LONG");
    }

    const filenameBytes = central.subarray(offset + 46, offset + 46 + filenameLength);
    const filename = decodeFilename(filenameBytes, Boolean(flags & 0x800));
    if (filename === undefined) {
      return rejected("AMBIGUOUS_ENTRY_NAME");
    }
    const normalized = filename.replaceAll("\\", "/");
    if (isUnsafeName(normalized)) {
      return rejected("UNSAFE_ENTRY_NAME");
    }
    if (isAmbiguousName(normalized) || normalizedNames.has(normalized)) {
      return rejected("AMBIGUOUS_ENTRY_NAME");
    }
    normalizedNames.add(normalized);

    entries.push({
      filename,
      isDirectory: normalized.endsWith("/") || Boolean(externalAttributes & 0x10),
      compressedSize,
      uncompressedSize,
      compressionMethod,
    });
    offset += recordLength;
  }

  if (offset !== central.length) {
    return rejected("MALFORMED_ZIP");
  }
  return { status: "extracted", format: "zip", entries, entryCount: entries.length };
}

function decodeFilename(bytes: Buffer, utf8: boolean): string | undefined {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isUnsafeName(name: string): boolean {
  const segments = name.split("/");
  return (
    name.startsWith("/") ||
    /^[a-zA-Z]:\//.test(name) ||
    segments.includes("..")
  );
}

function isAmbiguousName(name: string): boolean {
  const segments = name.split("/");
  return (
    name.length === 0 ||
    name.includes("\0") ||
    segments.some((segment, index) => segment === "." || (segment === "" && index < segments.length - 1))
  );
}

function rejected(reason: RejectedZipExtraction["reason"]): RejectedZipExtraction {
  return { status: "rejected", format: "zip", reason };
}
