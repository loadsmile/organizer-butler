import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OrganizerConfig } from "../config/config.js";
import { inspectFile } from "../core/inspector/inspectFile.js";
import { FileRegistry } from "../core/scanner/scanDownloads.js";
import { OrganizerError } from "../domain/error.js";

const scannedFileSchema = z
  .object({
    fileId: z.string().startsWith("file_"),
    filename: z.string(),
    extension: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    modifiedAt: z.string(),
  })
  .strict();

const organizerErrorSchema = z
  .object({
    code: z.enum(["INVALID_FILE_ID", "FILE_NOT_FOUND", "FILE_CHANGED", "UNSAFE_PATH", "INSPECTION_FAILED"]),
    message: z.string(),
  })
  .strict();

const scanOutputSchema = z
  .object({
    ok: z.boolean(),
    files: z.array(scannedFileSchema).optional(),
    error: organizerErrorSchema.optional(),
  })
  .strict();

const ruleEvidenceSchema = z
  .object({
    ruleId: z.string(),
    source: z.enum(["filename", "extension"]),
    matchedValue: z.string(),
    areaSignal: z.string().optional(),
    documentTypeSignal: z.string(),
  })
  .strict();

const inspectionOutputSchema = z
  .object({
    ok: z.boolean(),
    inspection: z
      .object({
        file: scannedFileSchema,
        extraction: z.record(z.string(), z.unknown()),
        ruleEvidence: z.array(ruleEvidenceSchema),
      })
      .strict()
      .optional(),
    error: organizerErrorSchema.optional(),
  })
  .strict();

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type OrganizerMcpServer = {
  server: McpServer;
  registry: FileRegistry;
};

export function createOrganizerMcpServer(config: OrganizerConfig): OrganizerMcpServer {
  const registry = new FileRegistry(config.downloadsDirectory);
  const server = new McpServer({ name: "organizer-butler", version: "0.1.0" });

  server.registerTool(
    "scan_files",
    {
      description: "Scan the configured inbox non-recursively and return opaque process-local file IDs.",
      inputSchema: z.object({}).strict(),
      outputSchema: scanOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => toolResult(await safelyRun(async () => ({ ok: true as const, files: await registry.scan() }))),
  );

  server.registerTool(
    "inspect_file",
    {
      description: "Inspect one file previously returned by scan_files using its opaque file ID.",
      inputSchema: z.object({ fileId: z.string().startsWith("file_").max(128) }).strict(),
      outputSchema: inspectionOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ fileId }) =>
      toolResult(
        await safelyRun(async () => ({
          ok: true as const,
          inspection: await inspectFile(registry, fileId, config),
        })),
      ),
  );

  return { server, registry };
}

async function safelyRun<T>(operation: () => Promise<T>): Promise<T | { ok: false; error: z.infer<typeof organizerErrorSchema> }> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OrganizerError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }

    return {
      ok: false,
      error: { code: "INSPECTION_FAILED", message: "The operation could not be completed safely." },
    };
  }
}

function toolResult(result: z.infer<typeof scanOutputSchema> | z.infer<typeof inspectionOutputSchema>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.ok ? {} : { isError: true }),
  };
}
