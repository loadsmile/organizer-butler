import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { OrganizerError } from "../../domain/error.js";
import type { JsonExtraction, JsonPreview, RejectedJsonExtraction } from "../../domain/inspection.js";

type JsonInspectionConfig = {
  maxSourceBytes: number;
  maxDepth: number;
  maxObjectKeys: number;
  maxArrayItems: number;
  maxStringLength: number;
};

type TruncationState = Omit<JsonExtraction, "status" | "format" | "preview">;
type ParseFailure = "MALFORMED_JSON" | "DUPLICATE_OBJECT_KEY" | "JSON_NESTING_TOO_DEEP";

class JsonParseFailure extends Error {
  constructor(readonly reason: ParseFailure) {
    super(reason);
  }
}

export async function inspectJson(
  filePath: string,
  config: JsonInspectionConfig,
): Promise<JsonExtraction | RejectedJsonExtraction> {
  const source = await readBoundedSource(filePath, config.maxSourceBytes);
  if (source === undefined) {
    return { status: "rejected", format: "json", reason: "JSON_SOURCE_TOO_LARGE" };
  }

  const truncation: TruncationState = {
    depthTruncated: false,
    objectKeysTruncated: false,
    arrayItemsTruncated: false,
    stringsTruncated: false,
  };

  try {
    const parser = new JsonParser(source, config, truncation);
    const preview = parser.parse();
    return { status: "extracted", format: "json", preview, ...truncation };
  } catch (error) {
    if (error instanceof JsonParseFailure) {
      return {
        status: error.reason === "MALFORMED_JSON" || error.reason === "DUPLICATE_OBJECT_KEY" ? "malformed" : "rejected",
        format: "json",
        reason: error.reason,
      };
    }
    throw error;
  }
}

async function readBoundedSource(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    if (stats.size > maxBytes) {
      return undefined;
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      return "\u0000";
    }
  } catch (error) {
    throw new OrganizerError("INSPECTION_FAILED", "The file could not be read for inspection.", { cause: error });
  } finally {
    await handle?.close();
  }
}

class JsonParser {
  #position = 0;
  readonly #maximumParseDepth = 256;

  constructor(
    readonly source: string,
    readonly config: JsonInspectionConfig,
    readonly truncation: TruncationState,
  ) {}

  parse(): JsonPreview {
    this.#skipWhitespace();
    const value = this.#parseValue(0, true);
    this.#skipWhitespace();
    if (this.#position !== this.source.length) this.#fail();
    return value;
  }

  #parseValue(depth: number, retain: boolean): JsonPreview {
    if (depth > this.#maximumParseDepth) throw new JsonParseFailure("JSON_NESTING_TOO_DEEP");
    if (retain && depth > this.config.maxDepth) {
      this.truncation.depthTruncated = true;
      this.#parseValue(depth, false);
      return this.#omitted();
    }
    const character = this.source[this.#position];
    if (character === "{") return this.#parseObject(depth, retain);
    if (character === "[") return this.#parseArray(depth, retain);
    if (character === '"') return this.#parseStringPreview(retain);
    if (character === "t") return this.#parseLiteral("true", { type: "boolean", value: true }, retain);
    if (character === "f") return this.#parseLiteral("false", { type: "boolean", value: false }, retain);
    if (character === "n") return this.#parseLiteral("null", { type: "null" }, retain);
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      return this.#parseNumber(retain);
    }
    return this.#fail();
  }

  #parseObject(depth: number, retain: boolean): JsonPreview {
    this.#position += 1;
    const entries: { key: string; keyTruncated: boolean; value: JsonPreview }[] = [];
    const keys = new Set<string>();
    let totalKeyCount = 0;
    this.#skipWhitespace();
    if (this.#consume("}")) return retain ? { type: "object", entries, totalKeyCount: 0, keysTruncated: false } : this.#omitted();

    while (true) {
      if (this.source[this.#position] !== '"') this.#fail();
      const key = this.#parseString();
      if (keys.has(key)) throw new JsonParseFailure("DUPLICATE_OBJECT_KEY");
      keys.add(key);
      this.#skipWhitespace();
      if (!this.#consume(":")) this.#fail();
      this.#skipWhitespace();
      const retainEntry = retain && entries.length < this.config.maxObjectKeys;
      const value = this.#parseValue(depth + 1, retainEntry);
      totalKeyCount += 1;
      if (retainEntry) {
        const retainedKey = this.#boundString(key);
        entries.push({ key: retainedKey.value, keyTruncated: retainedKey.truncated, value });
      }
      this.#skipWhitespace();
      if (this.#consume("}")) break;
      if (!this.#consume(",")) this.#fail();
      this.#skipWhitespace();
    }

    if (!retain) return this.#omitted();
    const keysTruncated = totalKeyCount > entries.length;
    if (keysTruncated) this.truncation.objectKeysTruncated = true;
    return { type: "object", entries, totalKeyCount, keysTruncated };
  }

  #parseArray(depth: number, retain: boolean): JsonPreview {
    this.#position += 1;
    const items: JsonPreview[] = [];
    let totalItemCount = 0;
    this.#skipWhitespace();
    if (this.#consume("]")) return retain ? { type: "array", items, totalItemCount: 0, itemsTruncated: false } : this.#omitted();

    while (true) {
      const retainItem = retain && items.length < this.config.maxArrayItems;
      const value = this.#parseValue(depth + 1, retainItem);
      totalItemCount += 1;
      if (retainItem) items.push(value);
      this.#skipWhitespace();
      if (this.#consume("]")) break;
      if (!this.#consume(",")) this.#fail();
      this.#skipWhitespace();
    }

    if (!retain) return this.#omitted();
    const itemsTruncated = totalItemCount > items.length;
    if (itemsTruncated) this.truncation.arrayItemsTruncated = true;
    return { type: "array", items, totalItemCount, itemsTruncated };
  }

  #parseStringPreview(retain: boolean): JsonPreview {
    const value = this.#parseString();
    if (!retain) return this.#omitted();
    return { type: "string", ...this.#boundString(value) };
  }

  #parseString(): string {
    const start = this.#position;
    this.#position += 1;
    while (this.#position < this.source.length) {
      const character = this.source[this.#position];
      if (character === '"') {
        this.#position += 1;
        try {
          return JSON.parse(this.source.slice(start, this.#position)) as string;
        } catch {
          return this.#fail();
        }
      }
      if (character === "\\") {
        this.#position += 1;
        const escape = this.source[this.#position];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.#position + 1, this.#position + 5))) this.#fail();
          this.#position += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) this.#fail();
      } else if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.#fail();
      }
      this.#position += 1;
    }
    return this.#fail();
  }

  #parseNumber(retain: boolean): JsonPreview {
    const remainder = this.source.slice(this.#position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (!match) return this.#fail();
    this.#position += match[0].length;
    return retain ? { type: "number", value: match[0] } : this.#omitted();
  }

  #parseLiteral(text: string, preview: JsonPreview, retain: boolean): JsonPreview {
    if (!this.source.startsWith(text, this.#position)) return this.#fail();
    this.#position += text.length;
    return retain ? preview : this.#omitted();
  }

  #boundString(value: string): { value: string; truncated: boolean } {
    const characters = [...value];
    const truncated = characters.length > this.config.maxStringLength;
    if (truncated) this.truncation.stringsTruncated = true;
    return { value: characters.slice(0, this.config.maxStringLength).join(""), truncated };
  }

  #skipWhitespace(): void {
    while (this.#position < this.source.length && " \t\r\n".includes(this.source[this.#position]!)) {
      this.#position += 1;
    }
  }

  #consume(character: string): boolean {
    if (this.source[this.#position] !== character) return false;
    this.#position += 1;
    return true;
  }

  #omitted(): JsonPreview {
    return { type: "truncated", reason: "MAX_DEPTH" };
  }

  #fail(): never {
    throw new JsonParseFailure("MALFORMED_JSON");
  }
}
