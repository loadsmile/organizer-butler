import { open } from "node:fs/promises";
import { OrganizerError } from "../../domain/error.js";
import type {
  ImageExtraction,
  ImageMetadataField,
  RejectedImageExtraction,
} from "../../domain/inspection.js";

type ImageFormat = ImageExtraction["format"];

type ImageInspectionConfig = {
  maxSourceBytes: number;
  maxDimension: number;
  maxPixels: number;
  maxStructures: number;
  maxMetadataFields: number;
  maxMetadataStringLength: number;
};

type ParsedImage = {
  width: number;
  height: number;
  metadata: Map<ImageMetadataField["key"], string>;
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const metadataOrder = ["title", "author", "description", "copyright"] as const;
const exifTags = new Map<number, ImageMetadataField["key"]>([
  [0x010e, "description"],
  [0x013b, "author"],
  [0x8298, "copyright"],
]);
const pngKeywords = new Map<string, ImageMetadataField["key"]>([
  ["Title", "title"],
  ["Author", "author"],
  ["Description", "description"],
  ["Copyright", "copyright"],
]);

export async function inspectImage(
  filePath: string,
  format: ImageFormat,
  config: ImageInspectionConfig,
): Promise<ImageExtraction | RejectedImageExtraction> {
  const source = await readBoundedSource(filePath, config.maxSourceBytes);
  if (source === undefined) return rejected(format, "IMAGE_SOURCE_TOO_LARGE");

  const parsed = format === "jpeg"
    ? parseJpeg(source, config.maxStructures)
    : parsePng(source, config.maxStructures);
  if ("reason" in parsed) return parsed;

  if (parsed.width === 0 || parsed.height === 0) return rejected(format, "INVALID_IMAGE_DIMENSIONS");
  if (parsed.width > config.maxDimension || parsed.height > config.maxDimension) {
    return rejected(format, "IMAGE_DIMENSION_LIMIT_EXCEEDED");
  }
  if (parsed.width > Math.floor(config.maxPixels / parsed.height)) {
    return rejected(format, "IMAGE_PIXEL_LIMIT_EXCEEDED");
  }

  const availableMetadata = metadataOrder.flatMap((key) => {
    const value = parsed.metadata.get(key);
    return value === undefined ? [] : [{ key, value }];
  });
  const retainedMetadata = availableMetadata.slice(0, config.maxMetadataFields);
  let metadataStringsTruncated = false;
  const metadata = retainedMetadata.map(({ key, value }): ImageMetadataField => {
    const characters = [...value];
    const truncated = characters.length > config.maxMetadataStringLength;
    metadataStringsTruncated ||= truncated;
    return {
      key,
      value: characters.slice(0, config.maxMetadataStringLength).join(""),
      truncated,
    };
  });

  return {
    status: "extracted",
    format,
    width: parsed.width,
    height: parsed.height,
    metadata,
    metadataFieldsTruncated: availableMetadata.length > metadata.length,
    metadataStringsTruncated,
  };
}

async function readBoundedSource(filePath: string, maxBytes: number): Promise<Buffer | undefined> {
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
      throw new OrganizerError("INSPECTION_FAILED", "The image file changed while it was being read.");
    }
    return source;
  } catch (error) {
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("INSPECTION_FAILED", "The image file could not be read for inspection.", { cause: error });
  } finally {
    await handle?.close();
  }
}

function parseJpeg(source: Buffer, maxStructures: number): ParsedImage | RejectedImageExtraction {
  if (source.length < 4 || source.readUInt16BE(0) !== 0xffd8) return rejected("jpeg", "MALFORMED_JPEG");

  const metadata = new Map<ImageMetadataField["key"], string>();
  let dimensions: { width: number; height: number } | undefined;
  let frameComponents: Set<number> | undefined;
  let offset = 2;
  let structureCount = 0;
  let inScan = false;

  while (offset < source.length) {
    if (source[offset] !== 0xff) return rejected("jpeg", "MALFORMED_JPEG");
    while (source[offset] === 0xff) offset += 1;
    if (offset >= source.length) return rejected("jpeg", "MALFORMED_JPEG");
    const marker = source[offset++]!;
    if (marker === 0x00) return rejected("jpeg", "MALFORMED_JPEG");
    structureCount += 1;
    if (structureCount > maxStructures) return rejected("jpeg", "IMAGE_STRUCTURE_LIMIT_EXCEEDED");

    if (marker === 0xd9) {
      if (!inScan || dimensions === undefined || offset !== source.length) {
        return rejected("jpeg", "MALFORMED_JPEG");
      }
      return { ...dimensions, metadata };
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!inScan) return rejected("jpeg", "MALFORMED_JPEG");
      continue;
    }
    if (marker === 0xd8 || marker === 0x01) return rejected("jpeg", "MALFORMED_JPEG");

    if (inScan) return rejected("jpeg", "UNSUPPORTED_JPEG_FEATURE");
    if (offset + 2 > source.length) return rejected("jpeg", "MALFORMED_JPEG");
    const segmentLength = source.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > source.length) {
      return rejected("jpeg", "MALFORMED_JPEG");
    }
    const payload = source.subarray(offset + 2, offset + segmentLength);
    offset += segmentLength;

    if (isUnsupportedJpegMarker(marker)) return rejected("jpeg", "UNSUPPORTED_JPEG_FEATURE");
    if (marker === 0xc0) {
      if (dimensions !== undefined || payload.length < 6 || payload[0] !== 8) {
        return rejected("jpeg", "MALFORMED_JPEG");
      }
      const componentCount = payload[5]!;
      if (componentCount === 0 || payload.length !== 6 + componentCount * 3) {
        return rejected("jpeg", "MALFORMED_JPEG");
      }
      frameComponents = new Set<number>();
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = 6 + index * 3;
        const componentId = payload[componentOffset]!;
        const sampling = payload[componentOffset + 1]!;
        const horizontalSampling = sampling >> 4;
        const verticalSampling = sampling & 0x0f;
        const quantizationTable = payload[componentOffset + 2]!;
        if (
          frameComponents.has(componentId)
          || horizontalSampling < 1
          || horizontalSampling > 4
          || verticalSampling < 1
          || verticalSampling > 4
          || quantizationTable > 3
        ) {
          return rejected("jpeg", "MALFORMED_JPEG");
        }
        frameComponents.add(componentId);
      }
      dimensions = { height: payload.readUInt16BE(1), width: payload.readUInt16BE(3) };
    } else if (isStartOfFrame(marker)) {
      return rejected("jpeg", "UNSUPPORTED_JPEG_FEATURE");
    } else if (marker === 0xe1 && payload.subarray(0, 6).equals(Buffer.from("Exif\0\0", "ascii"))) {
      const result = parseExif(payload.subarray(6), metadata);
      if (!result) return rejected("jpeg", "MALFORMED_JPEG");
    } else if (marker === 0xda) {
      if (dimensions === undefined || frameComponents === undefined || payload.length < 4) {
        return rejected("jpeg", "MALFORMED_JPEG");
      }
      const componentCount = payload[0]!;
      if (componentCount === 0 || payload.length !== 4 + componentCount * 2) {
        return rejected("jpeg", "MALFORMED_JPEG");
      }
      if (componentCount !== frameComponents.size || payload.at(-3) !== 0 || payload.at(-2) !== 63 || payload.at(-1) !== 0) {
        return rejected("jpeg", "UNSUPPORTED_JPEG_FEATURE");
      }
      const scanComponents = new Set<number>();
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = 1 + index * 2;
        const componentId = payload[componentOffset]!;
        const tables = payload[componentOffset + 1]!;
        if (
          !frameComponents.has(componentId)
          || scanComponents.has(componentId)
          || (tables >> 4) > 3
          || (tables & 0x0f) > 3
        ) {
          return rejected("jpeg", "MALFORMED_JPEG");
        }
        scanComponents.add(componentId);
      }
      inScan = true;
      while (true) {
        const scanEnd = findNextJpegMarker(source, offset);
        if (scanEnd === -1) return rejected("jpeg", "MALFORMED_JPEG");
        let markerOffset = scanEnd + 1;
        while (source[markerOffset] === 0xff) markerOffset += 1;
        const scanMarker = source[markerOffset];
        if (scanMarker === undefined) return rejected("jpeg", "MALFORMED_JPEG");
        if (scanMarker < 0xd0 || scanMarker > 0xd7) {
          offset = scanEnd;
          break;
        }
        structureCount += 1;
        if (structureCount > maxStructures) return rejected("jpeg", "IMAGE_STRUCTURE_LIMIT_EXCEEDED");
        offset = markerOffset + 1;
      }
    }
  }
  return rejected("jpeg", "MALFORMED_JPEG");
}

function findNextJpegMarker(source: Buffer, start: number): number {
  for (let offset = start; offset < source.length - 1; offset += 1) {
    if (source[offset] !== 0xff) continue;
    let next = offset + 1;
    while (source[next] === 0xff) next += 1;
    if (next >= source.length) return -1;
    if (source[next] === 0x00) {
      offset = next;
      continue;
    }
    return offset;
  }
  return -1;
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function isUnsupportedJpegMarker(marker: number): boolean {
  return marker === 0xcc || marker === 0xc8 || (marker >= 0xc9 && marker <= 0xcf && marker !== 0xcc);
}

function parseExif(source: Buffer, metadata: Map<ImageMetadataField["key"], string>): boolean {
  if (source.length < 8) return false;
  const byteOrder = source.subarray(0, 2).toString("ascii");
  if (byteOrder !== "II" && byteOrder !== "MM") return false;
  const littleEndian = byteOrder === "II";
  const read16 = (offset: number) => littleEndian ? source.readUInt16LE(offset) : source.readUInt16BE(offset);
  const read32 = (offset: number) => littleEndian ? source.readUInt32LE(offset) : source.readUInt32BE(offset);
  if (read16(2) !== 42) return false;
  const directoryOffset = read32(4);
  if (directoryOffset > source.length - 2) return false;
  const entryCount = read16(directoryOffset);
  const tableEnd = directoryOffset + 2 + entryCount * 12 + 4;
  if (tableEnd > source.length) return false;

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + 2 + index * 12;
    const key = exifTags.get(read16(entryOffset));
    if (key === undefined) continue;
    const type = read16(entryOffset + 2);
    const count = read32(entryOffset + 4);
    if (type !== 2 || count === 0) continue;
    const valueOffset = count <= 4 ? entryOffset + 8 : read32(entryOffset + 8);
    if (valueOffset > source.length || count > source.length - valueOffset) return false;
    const bytes = source.subarray(valueOffset, valueOffset + count);
    const nul = bytes.indexOf(0);
    const valueBytes = nul === -1 ? bytes : bytes.subarray(0, nul);
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(valueBytes);
      if (!metadata.has(key)) metadata.set(key, value);
    } catch {
      return false;
    }
  }
  return true;
}

function parsePng(source: Buffer, maxStructures: number): ParsedImage | RejectedImageExtraction {
  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return rejected("png", "MALFORMED_PNG");
  }

  const metadata = new Map<ImageMetadataField["key"], string>();
  let dimensions: { width: number; height: number } | undefined;
  let colorType: number | undefined;
  let offset = 8;
  let structureCount = 0;
  let seenPalette = false;
  let seenData = false;
  let dataEnded = false;

  while (offset < source.length) {
    if (offset + 12 > source.length) return rejected("png", "MALFORMED_PNG");
    const length = source.readUInt32BE(offset);
    const typeBytes = source.subarray(offset + 4, offset + 8);
    if (!isValidPngType(typeBytes) || length > source.length - offset - 12) {
      return rejected("png", "MALFORMED_PNG");
    }
    const type = typeBytes.toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = source.subarray(dataStart, dataEnd);
    if (crc32(source.subarray(offset + 4, dataEnd)) !== source.readUInt32BE(dataEnd)) {
      return rejected("png", "MALFORMED_PNG");
    }
    offset = dataEnd + 4;
    structureCount += 1;
    if (structureCount > maxStructures) return rejected("png", "IMAGE_STRUCTURE_LIMIT_EXCEEDED");

    if (dimensions === undefined && type !== "IHDR") return rejected("png", "MALFORMED_PNG");
    if (type === "IHDR") {
      if (dimensions !== undefined || length !== 13) return rejected("png", "MALFORMED_PNG");
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8]!;
      colorType = data[9]!;
      if (!isValidPngColorMode(bitDepth, colorType) || data[10] !== 0 || data[11] !== 0 || data[12]! > 1) {
        return rejected("png", "UNSUPPORTED_PNG_FEATURE");
      }
      dimensions = { width, height };
    } else if (type === "PLTE") {
      if (seenPalette || seenData || colorType === 0 || colorType === 4 || length === 0 || length % 3 !== 0 || length > 768) {
        return rejected("png", "MALFORMED_PNG");
      }
      seenPalette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (colorType === 3 && !seenPalette)) return rejected("png", "MALFORMED_PNG");
      seenData = true;
    } else {
      if (seenData) dataEnded = true;
      if (type === "IEND") {
        if (length !== 0 || !seenData || offset !== source.length) return rejected("png", "MALFORMED_PNG");
        return { ...dimensions!, metadata };
      }
      if (type === "acTL" || type === "fcTL" || type === "fdAT") {
        return rejected("png", "UNSUPPORTED_PNG_FEATURE");
      }
      if ((typeBytes[0]! & 0x20) === 0) return rejected("png", "UNSUPPORTED_PNG_FEATURE");
      if (type === "tEXt") {
        const result = parsePngText(data, metadata);
        if (!result) return rejected("png", "MALFORMED_PNG");
      } else {
        return rejected("png", "UNSUPPORTED_PNG_FEATURE");
      }
    }
  }
  return rejected("png", "MALFORMED_PNG");
}

function isValidPngType(type: Buffer): boolean {
  return type.length === 4
    && type.every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))
    && (type[2]! & 0x20) === 0;
}

function isValidPngColorMode(bitDepth: number, colorType: number): boolean {
  const validDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return validDepths[colorType]?.includes(bitDepth) ?? false;
}

function parsePngText(data: Buffer, metadata: Map<ImageMetadataField["key"], string>): boolean {
  const separator = data.indexOf(0);
  if (separator < 1 || separator > 79) return false;
  const keywordBytes = data.subarray(0, separator);
  if (
    keywordBytes[0] === 32
    || keywordBytes.at(-1) === 32
    || keywordBytes.some((byte, index) =>
      (byte < 32 || (byte > 126 && byte < 161)) || (byte === 32 && keywordBytes[index - 1] === 32)
    )
  ) return false;
  const keyword = keywordBytes.toString("latin1");
  const key = pngKeywords.get(keyword);
  if (key !== undefined && !metadata.has(key)) {
    metadata.set(key, data.subarray(separator + 1).toString("latin1"));
  }
  return true;
}

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rejected(
  format: ImageFormat,
  reason: RejectedImageExtraction["reason"],
): RejectedImageExtraction {
  return { status: "rejected", format, reason };
}
