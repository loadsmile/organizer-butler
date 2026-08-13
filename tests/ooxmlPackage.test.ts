import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  OoxmlPackageError,
  parseOoxmlPackage,
  readOoxmlParts,
  requireOoxmlEntry,
} from "../src/core/inspector/ooxmlPackage.js";

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPackage(content = "metadata"): Buffer {
  const name = Buffer.from("metadata.xml");
  const source = Buffer.from(content);
  const compressed = deflateRawSync(source);
  const checksum = crc32(source);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function readOnlyEntry(source: Buffer): Buffer {
  const entries = parseOoxmlPackage(source, 1);
  return readOoxmlParts(source, [requireOoxmlEntry(entries, "metadata.xml")], {
    maxCompressedBytes: 100,
    maxUncompressedBytes: 100,
  })[0]!;
}

describe("OOXML package reader", () => {
  it("reads a bounded member with matching local and central declarations", () => {
    assert.equal(readOnlyEntry(createPackage()).toString(), "metadata");
  });

  it("rejects contradictory local size and CRC declarations", () => {
    for (const offset of [14, 18, 22]) {
      const source = createPackage();
      source.writeUInt32LE(source.readUInt32LE(offset) + 1, offset);
      assert.throws(
        () => readOnlyEntry(source),
        (error) => error instanceof OoxmlPackageError && error.failure === "malformed",
      );
    }
  });

  it("rejects member data that overlaps the central directory", () => {
    const source = createPackage();
    const centralOffset = source.readUInt32LE(source.length - 6);
    source.writeUInt32LE(source.readUInt32LE(centralOffset + 20) + 1, centralOffset + 20);
    assert.throws(
      () => readOnlyEntry(source),
      (error) => error instanceof OoxmlPackageError && error.failure === "malformed",
    );
  });

  it("bounds inflation by the member's declared size", () => {
    const source = createPackage("metadata");
    const centralOffset = source.readUInt32LE(source.length - 6);
    source.writeUInt32LE(1, 22);
    source.writeUInt32LE(1, centralOffset + 24);
    assert.throws(
      () => readOnlyEntry(source),
      (error) => error instanceof OoxmlPackageError && error.failure === "malformed",
    );
  });
});
