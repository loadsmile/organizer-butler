import { open } from "node:fs/promises";
import { OrganizerError } from "../../domain/error.js";
import type { TextExtraction } from "../../domain/inspection.js";

const maxUtf8BytesPerCharacter = 4;

export async function inspectText(
  filePath: string,
  format: TextExtraction["format"],
  maxExtractedTextLength: number,
): Promise<TextExtraction> {
  const byteLimit = maxExtractedTextLength * maxUtf8BytesPerCharacter + 1;
  const buffer = Buffer.alloc(byteLimit);
  let bytesRead: number;

  try {
    const handle = await open(filePath, "r");
    try {
      ({ bytesRead } = await handle.read(buffer, 0, byteLimit, 0));
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new OrganizerError("INSPECTION_FAILED", "The file could not be read for inspection.", {
      cause: error,
    });
  }

  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, bytesRead));
  const characters = Array.from(decoded);
  const truncated = characters.length > maxExtractedTextLength;
  const excerpt = characters.slice(0, maxExtractedTextLength).join("");

  return {
    status: "extracted",
    format,
    excerpt,
    extractedTextLength: characters.length,
    truncated,
  };
}
