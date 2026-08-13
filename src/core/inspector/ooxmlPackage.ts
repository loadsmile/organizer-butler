import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { OrganizerError } from "../../domain/error.js";

export type OoxmlPackageEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  packageDataEnd: number;
};

export type OoxmlPackageFailure =
  | "malformed"
  | "unsupported"
  | "encrypted"
  | "unsafe-entry-name"
  | "duplicate-part"
  | "macro-enabled"
  | "entry-limit"
  | "compressed-metadata-limit"
  | "uncompressed-metadata-limit";

export class OoxmlPackageError extends Error {
  constructor(readonly failure: OoxmlPackageFailure) {
    super(failure);
  }
}

type MetadataLimits = {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
};

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_END_RECORD_SIZE = 22 + 65_535;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;

export async function readBoundedOoxmlSource(
  filePath: string,
  maxBytes: number,
  format: "XLSX" | "DOCX" | "PPTX",
): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    if (stats.size > maxBytes) return undefined;
    const source = Buffer.alloc(stats.size);
    let bytesRead = 0;
    while (bytesRead < source.length) {
      const result = await handle.read(source, bytesRead, source.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== stats.size) {
      throw new OrganizerError("INSPECTION_FAILED", `The ${format} file changed while it was being read.`);
    }
    return source;
  } catch (error) {
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("INSPECTION_FAILED", `The ${format} file could not be read for inspection.`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

export function parseOoxmlPackage(source: Buffer, maxEntries: number): Map<string, OoxmlPackageEntry> {
  if (source.length < 22) throw new OoxmlPackageError("malformed");
  const tailStart = Math.max(0, source.length - MAX_END_RECORD_SIZE);
  const tail = source.subarray(tailStart);
  const endOffset = findEndRecord(tail);
  if (endOffset === -1) throw new OoxmlPackageError("malformed");

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
    throw new OoxmlPackageError("unsupported");
  }
  if (tail.readUInt16LE(endOffset + 4) !== 0 || tail.readUInt16LE(endOffset + 6) !== 0 || entriesOnDisk !== entryCount) {
    throw new OoxmlPackageError("unsupported");
  }
  if (entryCount > maxEntries) throw new OoxmlPackageError("entry-limit");
  if (centralOffset + centralSize !== tailStart + endOffset) throw new OoxmlPackageError("malformed");

  const entries = new Map<string, OoxmlPackageEntry>();
  let offset = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralEnd || source.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new OoxmlPackageError("malformed");
    }
    const flags = source.readUInt16LE(offset + 8);
    const filenameLength = source.readUInt16LE(offset + 28);
    const extraLength = source.readUInt16LE(offset + 30);
    const commentLength = source.readUInt16LE(offset + 32);
    const recordLength = 46 + filenameLength + extraLength + commentLength;
    if (offset + recordLength > centralEnd) throw new OoxmlPackageError("malformed");
    if (flags & 0x41) throw new OoxmlPackageError("encrypted");

    const compressedSize = source.readUInt32LE(offset + 20);
    const uncompressedSize = source.readUInt32LE(offset + 24);
    const localOffset = source.readUInt32LE(offset + 42);
    const startDisk = source.readUInt16LE(offset + 34);
    if (
      compressedSize === ZIP64_32 ||
      uncompressedSize === ZIP64_32 ||
      localOffset === ZIP64_32 ||
      startDisk === ZIP64_16
    ) {
      throw new OoxmlPackageError("unsupported");
    }
    if (startDisk !== 0 || localOffset >= centralOffset) throw new OoxmlPackageError("malformed");

    const name = decodeEntryName(source.subarray(offset + 46, offset + 46 + filenameLength), Boolean(flags & 0x800));
    const normalizedName = normalizeOoxmlPartName(name);
    if (entries.has(normalizedName)) throw new OoxmlPackageError("duplicate-part");
    entries.set(normalizedName, {
      name: normalizedName,
      flags,
      compressionMethod: source.readUInt16LE(offset + 10),
      crc32: source.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize,
      localOffset,
      packageDataEnd: centralOffset,
    });
    offset += recordLength;
  }
  if (offset !== centralEnd) throw new OoxmlPackageError("malformed");
  if (entries.has("EncryptionInfo") || entries.has("EncryptedPackage")) {
    throw new OoxmlPackageError("encrypted");
  }
  if ([...entries.keys()].some((name) => name.toLowerCase().endsWith("/vbaproject.bin"))) {
    throw new OoxmlPackageError("macro-enabled");
  }
  return entries;
}

export function requireOoxmlEntry(
  entries: Map<string, OoxmlPackageEntry>,
  name: string,
): OoxmlPackageEntry {
  const entry = entries.get(name);
  if (entry === undefined) throw new OoxmlPackageError("malformed");
  return entry;
}

export function readOoxmlParts(
  source: Buffer,
  entries: OoxmlPackageEntry[],
  limits: MetadataLimits,
): Buffer[] {
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.name, entry])).values()];
  const compressedBytes = uniqueEntries.reduce((total, entry) => total + entry.compressedSize, 0);
  const uncompressedBytes = uniqueEntries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (compressedBytes > limits.maxCompressedBytes) {
    throw new OoxmlPackageError("compressed-metadata-limit");
  }
  if (uncompressedBytes > limits.maxUncompressedBytes) {
    throw new OoxmlPackageError("uncompressed-metadata-limit");
  }
  const parts = new Map(
    uniqueEntries.map((entry) => [entry.name, readEntry(source, entry, limits.maxUncompressedBytes)]),
  );
  return entries.map((entry) => parts.get(entry.name)!);
}

export function normalizeOoxmlPartName(name: string): string {
  if (name.length === 0 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new OoxmlPackageError("unsafe-entry-name");
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new OoxmlPackageError("unsafe-entry-name");
  }
  return name;
}

function findEndRecord(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === END_SIGNATURE && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      return offset;
    }
  }
  return -1;
}

function decodeEntryName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) throw new OoxmlPackageError("unsafe-entry-name");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OoxmlPackageError("unsafe-entry-name");
  }
}

function readEntry(source: Buffer, entry: OoxmlPackageEntry, maxOutputBytes: number): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > entry.packageDataEnd || source.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new OoxmlPackageError("malformed");
  }
  if (source.readUInt16LE(offset + 6) !== entry.flags || source.readUInt16LE(offset + 8) !== entry.compressionMethod) {
    throw new OoxmlPackageError("malformed");
  }
  const nameLength = source.readUInt16LE(offset + 26);
  const extraLength = source.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > entry.packageDataEnd) throw new OoxmlPackageError("malformed");
  const localName = decodeEntryName(source.subarray(offset + 30, offset + 30 + nameLength), Boolean(entry.flags & 0x800));
  if (normalizeOoxmlPartName(localName) !== entry.name) throw new OoxmlPackageError("malformed");
  if (
    !(entry.flags & 0x08) &&
    (source.readUInt32LE(offset + 14) !== entry.crc32 ||
      source.readUInt32LE(offset + 18) !== entry.compressedSize ||
      source.readUInt32LE(offset + 22) !== entry.uncompressedSize)
  ) {
    throw new OoxmlPackageError("malformed");
  }

  const compressed = source.subarray(dataOffset, dataEnd);
  let uncompressed: Buffer;
  try {
    if (entry.compressionMethod === 0) uncompressed = Buffer.from(compressed);
    else if (entry.compressionMethod === 8) {
      uncompressed = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, Math.min(maxOutputBytes, entry.uncompressedSize)),
      });
    }
    else throw new OoxmlPackageError("unsupported");
  } catch (error) {
    if (error instanceof OoxmlPackageError) throw error;
    throw new OoxmlPackageError("malformed");
  }
  if (uncompressed.length !== entry.uncompressedSize || crc32(uncompressed) !== entry.crc32) {
    throw new OoxmlPackageError("malformed");
  }
  return uncompressed;
}

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
