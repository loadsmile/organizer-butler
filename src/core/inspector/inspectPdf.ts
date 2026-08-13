import { open } from "node:fs/promises";
import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { OrganizerError } from "../../domain/error.js";
import type {
  PdfExtraction,
  PdfMetadataField,
  RejectedPdfExtraction,
} from "../../domain/inspection.js";

type PdfInspectionConfig = {
  maxSourceBytes: number;
  maxObjects: number;
  maxMetadataFields: number;
  maxMetadataStringLength: number;
};

type MetadataKey = PdfMetadataField["key"];

const metadataReaders: readonly [MetadataKey, (document: PDFDocument) => string | undefined][] = [
  ["title", (document) => document.getTitle()],
  ["author", (document) => document.getAuthor()],
  ["subject", (document) => document.getSubject()],
  ["keywords", (document) => document.getKeywords()],
  ["creator", (document) => document.getCreator()],
  ["producer", (document) => document.getProducer()],
];

export async function inspectPdf(
  filePath: string,
  config: PdfInspectionConfig,
): Promise<PdfExtraction | RejectedPdfExtraction> {
  const source = await readBoundedSource(filePath, config.maxSourceBytes);
  if (source === undefined) return rejected("PDF_SOURCE_TOO_LARGE");

  const version = readVersion(source);
  if (version === undefined) return rejected("MALFORMED_PDF");
  if (!isSupportedVersion(version)) return rejected("UNSUPPORTED_PDF_FEATURE");

  try {
    const document = await PDFDocument.load(source, {
      // Parsing the trailer is required to identify encryption; no encrypted
      // object content is read after this flag is observed.
      ignoreEncryption: true,
      throwOnInvalidObject: true,
      updateMetadata: false,
      capNumbers: true,
    });
    if (document.isEncrypted) return rejected("ENCRYPTED_PDF");
    if (document.context.enumerateIndirectObjects().length > config.maxObjects) {
      return rejected("PDF_OBJECT_LIMIT_EXCEEDED");
    }

    const availableMetadata = metadataReaders.flatMap(([key, read]) => {
      const value = read(document);
      return value === undefined ? [] : [{ key, value }];
    });
    const retainedMetadata = availableMetadata.slice(0, config.maxMetadataFields);
    let metadataStringsTruncated = false;
    const metadata = retainedMetadata.map(({ key, value }): PdfMetadataField => {
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
      format: "pdf",
      version,
      pageCount: document.getPageCount(),
      encrypted: false,
      metadata,
      metadataFieldsTruncated: availableMetadata.length > metadata.length,
      metadataStringsTruncated,
    };
  } catch (error) {
    if (error instanceof EncryptedPDFError) return rejected("ENCRYPTED_PDF");
    return rejected("MALFORMED_PDF");
  }
}

async function readBoundedSource(filePath: string, maxBytes: number): Promise<Uint8Array | undefined> {
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
      throw new OrganizerError("INSPECTION_FAILED", "The PDF file changed while it was being read.");
    }
    return source;
  } catch (error) {
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("INSPECTION_FAILED", "The PDF file could not be read for inspection.", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

function readVersion(source: Uint8Array): string | undefined {
  const header = Buffer.from(source.subarray(0, Math.min(source.length, 1_024))).toString("latin1");
  return /(?:^|[\r\n])%PDF-(\d+\.\d+)(?:[\r\n]|$)/.exec(header)?.[1];
}

function isSupportedVersion(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major === 1 && minor !== undefined && minor >= 0 && minor <= 7;
}

function rejected(reason: RejectedPdfExtraction["reason"]): RejectedPdfExtraction {
  return { status: "rejected", format: "pdf", reason };
}
