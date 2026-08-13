import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OrganizerConfig } from "../config/config.js";
import {
  submittedClassificationSchema,
  validateSubmittedClassification,
} from "../core/classification/validateSubmittedClassification.js";
import { inspectFile } from "../core/inspector/inspectFile.js";
import {
  OrganizationPlanRegistry,
  type OrganizationPlanRegistryOptions,
} from "../core/planning/previewOrganizationPlan.js";
import { FileRegistry } from "../core/scanner/scanDownloads.js";
import { areas } from "../core/taxonomy/areas.js";
import { documentTypes } from "../core/taxonomy/documentTypes.js";
import { OrganizerError } from "../domain/error.js";
import { SqliteExecutionStore } from "../core/planning/executionStore.js";
import type { OrganizationExecutionResult } from "../domain/organizationPlan.js";
import {
  DirectoryPlanRegistry,
  type DirectoryPlanRegistryOptions,
} from "../core/planning/directoryPlanning.js";
import type { DirectoryExecutionResult } from "../domain/directoryPlan.js";

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
    code: z.enum([
      "INVALID_FILE_ID",
      "FILE_NOT_FOUND",
      "FILE_CHANGED",
      "UNSAFE_PATH",
      "INSPECTION_FAILED",
      "CLASSIFICATION_INVALID_SUBMISSION",
      "PLAN_INVALID_CLASSIFICATION",
      "PLAN_UNSAFE_FILENAME",
      "PLAN_UNSAFE_DESTINATION",
      "PLAN_DESTINATION_TOO_LONG",
      "PLAN_VALIDATION_FAILED",
      "INVALID_PLAN_ID",
      "PLAN_EXPIRED",
      "PLAN_ALREADY_USED",
      "PLAN_CHANGED",
      "PLAN_CONFLICT",
      "INVALID_DIRECTORY_PLAN_ID",
      "DIRECTORY_PLAN_EXPIRED",
      "DIRECTORY_PLAN_ALREADY_USED",
      "DIRECTORY_PLAN_CHANGED",
      "DIRECTORY_PLAN_CONFLICT",
      "INVALID_DIRECTORY_CONFIRMATION_ID",
      "DIRECTORY_CONFIRMATION_EXPIRED",
      "DIRECTORY_CONFIRMATION_ALREADY_EXECUTING",
      "DIRECTORY_CONFIRMATION_INVALIDATED",
      "DIRECTORY_EXECUTION_CHANGED",
      "DIRECTORY_EXECUTION_CONFLICT",
      "DIRECTORY_EXECUTION_PARTIAL",
      "DIRECTORY_EXECUTION_FAILED",
      "INVALID_CONFIRMATION_ID",
      "CONFIRMATION_EXPIRED",
      "CONFIRMATION_ALREADY_EXECUTING",
      "CONFIRMATION_ALREADY_USED",
      "CONFIRMATION_INVALIDATED",
      "EXECUTION_CHANGED",
      "EXECUTION_CONFLICT",
      "EXECUTION_DESTINATION_UNAVAILABLE",
      "EXECUTION_CROSS_FILESYSTEM",
      "EXECUTION_PARTIAL",
      "EXECUTION_STORAGE_FAILED",
      "EXECUTION_FAILED",
    ]),
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

const planPreviewOutputSchema = z
  .object({
    ok: z.boolean(),
    plan: z
      .object({
        planId: z.string().startsWith("plan_"),
        fileId: z.string().startsWith("file_"),
        expiresAt: z.iso.datetime(),
        destination: z
          .object({
            area: z.enum(areas),
            documentType: z.enum(documentTypes),
            areaDirectory: z.string(),
            documentTypeDirectory: z.string(),
            filename: z.string(),
          })
          .strict(),
        conflict: z.enum(["none", "existing-file", "existing-directory", "existing-other"]),
      })
      .strict()
      .optional(),
    error: organizerErrorSchema.optional(),
  })
  .strict();

const planConfirmationOutputSchema = z
  .object({
    ok: z.boolean(),
    confirmation: z
      .object({
        confirmationId: z.string().startsWith("confirm_"),
        planId: z.string().startsWith("plan_"),
        fileId: z.string().startsWith("file_"),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
    error: organizerErrorSchema.optional(),
  })
  .strict();

const executionOutputSchema = z
  .object({
    ok: z.boolean(),
    execution: z
      .object({
        confirmationId: z.string().startsWith("confirm_"),
        planId: z.string().startsWith("plan_"),
        fileId: z.string().startsWith("file_"),
        status: z.literal("completed"),
      })
      .strict()
      .optional(),
    error: organizerErrorSchema.optional(),
  })
  .strict();

const directoryPreviewOutputSchema = z.object({
  ok: z.boolean(),
  directoryPlan: z.object({
    directoryPlanId: z.string().startsWith("directory_plan_"),
    fileId: z.string().startsWith("file_"),
    expiresAt: z.iso.datetime(),
    directories: z.array(z.object({ name: z.string(), status: z.enum(["existing", "missing"]) }).strict()).length(2),
  }).strict().optional(),
  error: organizerErrorSchema.optional(),
}).strict();

const directoryConfirmationOutputSchema = z.object({
  ok: z.boolean(),
  confirmation: z.object({
    directoryConfirmationId: z.string().startsWith("directory_confirm_"),
    directoryPlanId: z.string().startsWith("directory_plan_"),
    fileId: z.string().startsWith("file_"),
    expiresAt: z.iso.datetime(),
  }).strict().optional(),
  error: organizerErrorSchema.optional(),
}).strict();

const directoryExecutionOutputSchema = z.object({
  ok: z.boolean(),
  execution: z.object({
    directoryConfirmationId: z.string().startsWith("directory_confirm_"),
    directoryPlanId: z.string().startsWith("directory_plan_"),
    fileId: z.string().startsWith("file_"),
    status: z.literal("completed"),
  }).strict().optional(),
  error: organizerErrorSchema.optional(),
}).strict();

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const previewAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const confirmationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const executionAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export type OrganizerMcpServer = {
  server: McpServer;
  registry: FileRegistry;
  planRegistry: OrganizationPlanRegistry;
  directoryPlanRegistry: DirectoryPlanRegistry;
  shutdown(): Promise<void>;
};

export type OrganizerMcpServerOptions = {
  planRegistryOptions?: OrganizationPlanRegistryOptions;
  directoryPlanRegistryOptions?: DirectoryPlanRegistryOptions;
  mutationUnavailable?: boolean;
};

export async function initializeOrganizerMcpServer(
  config: OrganizerConfig,
  options: Omit<OrganizerMcpServerOptions, "planRegistryOptions" | "directoryPlanRegistryOptions" | "mutationUnavailable"> = {},
): Promise<OrganizerMcpServer> {
  let store: SqliteExecutionStore | undefined;
  try {
    const executionStore = new SqliteExecutionStore(config.databasePath, { recoveryLeaseMs: config.executionRecoveryLeaseMs });
    store = executionStore;
    const result = createOrganizerMcpServer(config, {
      ...options,
      planRegistryOptions: { executionStore },
      directoryPlanRegistryOptions: { executionStore },
    });
    await result.directoryPlanRegistry.recover();
    await result.planRegistry.recover();
    executionStore.cleanupTerminal(Date.now(), {
      invalidatedMs: config.invalidatedExecutionRetentionMs,
      expiredMs: config.expiredExecutionRetentionMs,
      completedMs: config.completedExecutionReplayRetentionMs,
    });
    executionStore.cleanupTerminalDirectories(Date.now(), {
      invalidatedMs: config.invalidatedExecutionRetentionMs,
      expiredMs: config.expiredExecutionRetentionMs,
      completedMs: config.completedExecutionReplayRetentionMs,
    });
    let closed = false;
    return {
      ...result,
      async shutdown() {
        if (closed) return;
        closed = true;
        await result.planRegistry.waitForActiveExecutions();
        await result.directoryPlanRegistry.waitForActiveExecutions();
        executionStore.close();
      },
    };
  } catch {
    try {
      store?.close();
    } catch {}
    return createOrganizerMcpServer(config, { ...options, mutationUnavailable: true });
  }
}

export function createOrganizerMcpServer(
  config: OrganizerConfig,
  options: OrganizerMcpServerOptions = {},
): OrganizerMcpServer {
  const registry = new FileRegistry(config.downloadsDirectory);
  const planRegistry = new OrganizationPlanRegistry(options.planRegistryOptions);
  const directoryPlanRegistry = new DirectoryPlanRegistry(options.directoryPlanRegistryOptions);
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

  server.registerTool(
    "submit_classification_and_preview_file",
    {
      description:
        "Freshly inspect a file, validate a host-submitted controlled classification, and create a read-only organization preview.",
      inputSchema: z
        .object({
          fileId: z.string().startsWith("file_").max(128),
          classification: submittedClassificationSchema,
        })
        .strict(),
      outputSchema: planPreviewOutputSchema,
      annotations: previewAnnotations,
    },
    async ({ fileId, classification: submittedClassification }) =>
      toolResult(
        await safelyRun(async () => {
          const inspection = await inspectFile(registry, fileId, config);
          const classification = validateSubmittedClassification(
            inspection,
            submittedClassification,
          );
          return {
            ok: true as const,
            plan: await planRegistry.preview(registry, classification, config),
          };
        }),
      ),
  );

  server.registerTool(
    "preview_organization_directories",
    {
      description: "Consume one process-local move preview and create a separate read-only preview for its missing controlled destination directories. A fresh move preview is required after directory creation.",
      inputSchema: z.object({ planId: z.string().startsWith("plan_").max(128) }).strict(),
      outputSchema: directoryPreviewOutputSchema,
      annotations: { ...readOnlyAnnotations, idempotentHint: false },
    },
    async ({ planId }) => toolResult(await safelyRun(async () => ({
      ok: true as const,
      directoryPlan: await directoryPlanRegistry.preview(planRegistry, planId, config),
    }))),
  );

  server.registerTool(
    "confirm_organization_directories",
    {
      description: "Confirm exactly one process-local controlled-directory plan. This persists separate authority but does not create directories.",
      inputSchema: z.object({ directoryPlanId: z.string().startsWith("directory_plan_").max(160) }).strict(),
      outputSchema: directoryConfirmationOutputSchema,
      annotations: confirmationAnnotations,
    },
    async ({ directoryPlanId }) => toolResult(await safelyRun(async () => {
      assertMutationAvailable(options.mutationUnavailable);
      return { ok: true as const, confirmation: await directoryPlanRegistry.confirm(directoryPlanId) };
    })),
  );

  server.registerTool(
    "execute_organization_directories",
    {
      description: "Create only the missing controlled destination directories from a separately confirmed directory plan, one level at a time. Call only after explicit user approval. This does not move a file.",
      inputSchema: z.object({ directoryConfirmationId: z.string().startsWith("directory_confirm_").max(160) }).strict(),
      outputSchema: directoryExecutionOutputSchema,
      annotations: { ...executionAnnotations, destructiveHint: false },
    },
    async ({ directoryConfirmationId }) => toolResult(await safelyRun(async () => {
      assertMutationAvailable(options.mutationUnavailable);
      return {
        ok: true as const,
        execution: await directoryPlanRegistry.execute(directoryConfirmationId),
      } satisfies { ok: true; execution: DirectoryExecutionResult };
    })),
  );

  server.registerTool(
    "confirm_organization_plan",
    {
      description:
        "Confirm exactly one process-local organization plan and issue a short-lived one-time confirmation capability. This tool does not move files or otherwise mutate the filesystem.",
      inputSchema: z.object({ planId: z.string().startsWith("plan_").max(128) }).strict(),
      outputSchema: planConfirmationOutputSchema,
      annotations: confirmationAnnotations,
    },
    async ({ planId }) =>
      toolResult(
        await safelyRun(async () => {
          assertMutationAvailable(options.mutationUnavailable);
          return {
            ok: true as const,
            confirmation: await planRegistry.confirm(planId),
          };
        }),
      ),
  );

  server.registerTool(
    "execute_organization_plan",
    {
      description:
        "Move exactly one previously confirmed file. Call only after the user explicitly approves the preview and confirm_organization_plan returns its one-time confirmation ID. The destination must already exist; collisions, overwrites, automatic renames, and cross-filesystem moves are rejected.",
      inputSchema: z.object({ confirmationId: z.string().startsWith("confirm_").max(128) }).strict(),
      outputSchema: executionOutputSchema,
      annotations: executionAnnotations,
    },
    async ({ confirmationId }) =>
      toolResult(
        await safelyRun(async () => {
          assertMutationAvailable(options.mutationUnavailable);
          return {
            ok: true as const,
            execution: await planRegistry.execute(confirmationId),
          } satisfies { ok: true; execution: OrganizationExecutionResult };
        }),
      ),
  );

  return { server, registry, planRegistry, directoryPlanRegistry, async shutdown() {} };
}

function assertMutationAvailable(unavailable: boolean | undefined): void {
  if (unavailable) {
    throw new OrganizerError("EXECUTION_STORAGE_FAILED", "The organization operation state could not be stored safely.");
  }
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

function toolResult(
  result:
    | z.infer<typeof scanOutputSchema>
    | z.infer<typeof inspectionOutputSchema>
    | z.infer<typeof planPreviewOutputSchema>
    | z.infer<typeof planConfirmationOutputSchema>
    | z.infer<typeof executionOutputSchema>
    | z.infer<typeof directoryPreviewOutputSchema>
    | z.infer<typeof directoryConfirmationOutputSchema>
    | z.infer<typeof directoryExecutionOutputSchema>,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.ok ? {} : { isError: true }),
  };
}
