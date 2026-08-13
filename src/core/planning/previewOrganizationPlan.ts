import { randomUUID } from "node:crypto";
import { link, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OrganizerConfig } from "../../config/config.js";
import type { ClassificationProposalResult } from "../../domain/classification.js";
import { OrganizerError } from "../../domain/error.js";
import type {
  DestinationConflict,
  OrganizationExecutionResult,
  OrganizationPlanConfirmation,
  OrganizationPlanPreview,
} from "../../domain/organizationPlan.js";
import { isValidatedClassification } from "../classification/classificationCapability.js";
import type { FileRegistry, ResolvedFileIdentity } from "../scanner/scanDownloads.js";
import { assertPathInside } from "../security/paths.js";
import { areaSchema } from "../taxonomy/areas.js";
import { isCompatibleClassification } from "../taxonomy/classificationCompatibility.js";
import { documentTypeSchema } from "../taxonomy/documentTypes.js";
import { areaDirectories, documentTypeDirectories } from "./destinationMappings.js";
import {
  type DurableExecutionRecord,
  type ExecutionStore,
  InMemoryExecutionStore,
} from "./executionStore.js";

export type OrganizationPlanningConfig = Pick<
  OrganizerConfig,
  "organizationRoot" | "maxPlanPathBytes" | "planExpiryMs" | "confirmationExpiryMs"
>;

type PlanRecord = {
  registry: FileRegistry;
  file: ResolvedFileIdentity;
  organizationRoot: string;
  destinationPath: string;
  conflict: DestinationConflict;
  expiresAt: number;
  confirmationExpiryMs: number;
  state: "pending" | "confirming" | "consumed" | "invalidated" | "expired";
};

export type ControlledDirectoryIntent = {
  fileId: string;
  organizationRoot: string;
  directoryPaths: readonly [string, string];
  directoryNames: readonly [string, string];
};

type ConfirmationRecord = {
  planId: string;
  registry: FileRegistry;
  file: ResolvedFileIdentity;
  organizationRoot: string;
  destinationPath: string;
  expiresAt: number;
  state: "ready" | "executing" | "consumed" | "invalidated" | "expired";
};

type ExecutionOperations = {
  link(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(sourcePath: string): Promise<void>;
};

export type OrganizationPlanRegistryOptions = {
  now?: () => number;
  createId?: () => string;
  executionOperations?: ExecutionOperations;
  executionStore?: ExecutionStore;
  executionFaults?: {
    beforeDestinationCreated?(): void;
    afterDestinationCreated?(): void;
    afterSourceRemoved?(): void;
  };
};

const proposalSchema = z
  .object({
    area: areaSchema,
    documentType: documentTypeSchema,
    rationale: z.string(),
  })
  .strict();

const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class OrganizationPlanRegistry {
  readonly #plans = new Map<string, PlanRecord>();
  readonly #confirmations = new Map<string, ConfirmationRecord>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #executionOperations: ExecutionOperations;
  readonly #executionStore: ExecutionStore;
  readonly #executionFaults: NonNullable<OrganizationPlanRegistryOptions["executionFaults"]>;
  readonly #activeExecutions = new Set<Promise<OrganizationExecutionResult>>();

  constructor(options: OrganizationPlanRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#executionOperations = options.executionOperations ?? { link, unlink };
    this.#executionStore = options.executionStore ?? new InMemoryExecutionStore();
    this.#executionFaults = options.executionFaults ?? {};
  }

  async preview(
    registry: FileRegistry,
    classification: ClassificationProposalResult,
    config: OrganizationPlanningConfig,
  ): Promise<OrganizationPlanPreview> {
    const proposal = proposalSchema.safeParse(classification.proposal);
    if (
      !isValidatedClassification(classification) ||
      !proposal.success ||
      classification.fileId.length > 128 ||
      !classification.fileId.startsWith("file_") ||
      !isCompatibleClassification(proposal.data.area, proposal.data.documentType)
    ) {
      throw new OrganizerError("PLAN_INVALID_CLASSIFICATION", "The classification proposal is invalid for planning.");
    }

    const file = await registry.resolveIdentity(classification.fileId);
    assertSafeFilename(file.filename);

    const organizationRoot = await resolveOrganizationRoot(config.organizationRoot);
    const areaDirectory = areaDirectories[proposal.data.area];
    const documentTypeDirectory = documentTypeDirectories[proposal.data.documentType];
    const destinationDirectory = path.join(organizationRoot, areaDirectory, documentTypeDirectory);
    const destinationPath = path.join(destinationDirectory, file.filename);

    try {
      assertPathInside(organizationRoot, destinationPath);
    } catch {
      throw new OrganizerError("PLAN_UNSAFE_DESTINATION", "The proposed destination is outside the organization root.");
    }
    if (Buffer.byteLength(destinationPath, "utf8") > config.maxPlanPathBytes) {
      throw new OrganizerError("PLAN_DESTINATION_TOO_LONG", "The proposed destination exceeds the configured path limit.");
    }
    if (path.resolve(file.path) === path.resolve(destinationPath)) {
      throw new OrganizerError("PLAN_UNSAFE_DESTINATION", "The source and proposed destination must be different.");
    }

    await assertNoSymlinkedAncestors(organizationRoot, destinationDirectory);
    const conflict = await inspectConflict(file.path, destinationPath);
    await registry.resolveIdentity(file.fileId);
    const expiresAt = this.#now() + config.planExpiryMs;
    const planId = `plan_${this.#createId()}`;
    this.#plans.set(planId, {
      registry,
      file: { ...file },
      organizationRoot,
      destinationPath,
      conflict,
      expiresAt,
      confirmationExpiryMs: config.confirmationExpiryMs,
      state: "pending",
    });

    return {
      planId,
      fileId: file.fileId,
      expiresAt: new Date(expiresAt).toISOString(),
      destination: {
        area: proposal.data.area,
        documentType: proposal.data.documentType,
        areaDirectory,
        documentTypeDirectory,
        filename: file.filename,
      },
      conflict,
    };
  }

  async confirm(planId: string): Promise<OrganizationPlanConfirmation> {
    const plan = this.#plans.get(planId);
    if (!plan) {
      throw new OrganizerError("INVALID_PLAN_ID", "The plan ID was not produced by this server process.");
    }
    if (plan.state !== "pending") {
      throw new OrganizerError("PLAN_ALREADY_USED", "The organization plan has already been used.");
    }
    if (this.#now() >= plan.expiresAt) {
      plan.state = "expired";
      throw new OrganizerError("PLAN_EXPIRED", "The organization plan has expired.");
    }

    plan.state = "confirming";
    try {
      if (plan.conflict !== "none") {
        throw new OrganizerError(
          "PLAN_CONFLICT",
          "The organization plan cannot be confirmed because its destination is unavailable.",
        );
      }
      await revalidatePlan(plan);
      if (this.#now() >= plan.expiresAt) {
        plan.state = "expired";
        throw new OrganizerError("PLAN_EXPIRED", "The organization plan has expired.");
      }

      const confirmationId = `confirm_${this.#createId()}`;
      const expiresAt = this.#now() + plan.confirmationExpiryMs;
      const [inboxRootStats, organizationRootStats] = await Promise.all([
        lstat(plan.file.inboxRoot),
        lstat(plan.organizationRoot),
      ]);
      if (
        !inboxRootStats.isDirectory() ||
        inboxRootStats.dev !== plan.file.inboxRootDevice ||
        inboxRootStats.ino !== plan.file.inboxRootInode ||
        !organizationRootStats.isDirectory()
      ) {
        throw new OrganizerError("PLAN_CHANGED", "The organization plan no longer matches current filesystem state.");
      }
      this.#executionStore.create({
        confirmationId,
        planId,
        fileId: plan.file.fileId,
        sourcePath: plan.file.path,
        sourceDevice: plan.file.device,
        sourceInode: plan.file.inode,
        sourceSize: plan.file.size,
        sourceModifiedAtMs: plan.file.modifiedAtMs,
        inboxRoot: plan.file.inboxRoot,
        inboxRootDevice: plan.file.inboxRootDevice,
        inboxRootInode: plan.file.inboxRootInode,
        organizationRoot: plan.organizationRoot,
        organizationRootDevice: organizationRootStats.dev,
        organizationRootInode: organizationRootStats.ino,
        destinationPath: plan.destinationPath,
        expiresAt,
        state: "ready",
        phase: "prepared",
        recoveryOutcome: "none",
        terminalAt: null,
      });
      this.#confirmations.set(confirmationId, {
        planId,
        registry: plan.registry,
        file: { ...plan.file },
        organizationRoot: plan.organizationRoot,
        destinationPath: plan.destinationPath,
        expiresAt,
        state: "ready",
      });
      plan.state = "consumed";
      return {
        confirmationId,
        planId,
        fileId: plan.file.fileId,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      if (plan.state === "confirming") plan.state = "invalidated";
      throw error;
    }
  }

  async consumeForDirectoryPlanning(planId: string): Promise<ControlledDirectoryIntent> {
    const plan = this.#plans.get(planId);
    if (!plan) {
      throw new OrganizerError("INVALID_PLAN_ID", "The plan ID was not produced by this server process.");
    }
    if (plan.state !== "pending") {
      throw new OrganizerError("PLAN_ALREADY_USED", "The organization plan has already been used.");
    }
    if (this.#now() >= plan.expiresAt) {
      plan.state = "expired";
      throw new OrganizerError("PLAN_EXPIRED", "The organization plan has expired.");
    }

    plan.state = "confirming";
    try {
      await revalidatePlan(plan);
      const documentTypePath = path.dirname(plan.destinationPath);
      const areaPath = path.dirname(documentTypePath);
      const intent: ControlledDirectoryIntent = {
        fileId: plan.file.fileId,
        organizationRoot: plan.organizationRoot,
        directoryPaths: [areaPath, documentTypePath],
        directoryNames: [path.basename(areaPath), path.basename(documentTypePath)],
      };
      plan.state = "consumed";
      return intent;
    } catch (error) {
      if (plan.state === "confirming") plan.state = "invalidated";
      throw error;
    }
  }

  execute(confirmationId: string): Promise<OrganizationExecutionResult> {
    const execution = this.#execute(confirmationId);
    this.#activeExecutions.add(execution);
    void execution.finally(() => this.#activeExecutions.delete(execution)).catch(() => {});
    return execution;
  }

  async waitForActiveExecutions(): Promise<void> {
    await Promise.allSettled([...this.#activeExecutions]);
  }

  async #execute(confirmationId: string): Promise<OrganizationExecutionResult> {
    const claim = this.#executionStore.claim(confirmationId, this.#now());
    if (!claim) {
      throw new OrganizerError(
        "INVALID_CONFIRMATION_ID",
        "The confirmation ID was not produced by this server process.",
      );
    }
    const { record: confirmation } = claim;
    if (confirmation.state === "executing" && !claim.claimed) {
      throw new OrganizerError("CONFIRMATION_ALREADY_EXECUTING", "The organization confirmation is already executing.");
    }
    if (confirmation.state === "completed") {
      return executionResult(confirmation);
    }
    if (confirmation.state === "invalidated") {
      throw new OrganizerError("CONFIRMATION_INVALIDATED", "The organization confirmation is no longer valid.");
    }
    if (confirmation.state === "expired") {
      throw new OrganizerError("CONFIRMATION_EXPIRED", "The organization confirmation has expired.");
    }
    if (confirmation.state !== "executing") {
      throw new OrganizerError("CONFIRMATION_INVALIDATED", "The organization confirmation is no longer valid.");
    }
    let destinationCreated = false;
    try {
      await revalidateDurableExecution(confirmation);
      if (this.#now() >= confirmation.expiresAt) {
        this.#executionStore.invalidate(confirmationId, true, this.#now());
        throw new OrganizerError("CONFIRMATION_EXPIRED", "The organization confirmation has expired.");
      }

      this.#executionFaults.beforeDestinationCreated?.();
      try {
        await this.#executionOperations.link(confirmation.sourcePath, confirmation.destinationPath);
      } catch (error) {
        throw mapLinkError(error);
      }
      destinationCreated = true;
      this.#executionFaults.afterDestinationCreated?.();
      this.#executionStore.setPhase(confirmationId, "destination-created");
      try {
        const [sourceStats, destinationStats] = await Promise.all([
          lstat(confirmation.sourcePath),
          lstat(confirmation.destinationPath),
        ]);
        if (
          sourceStats.isSymbolicLink() ||
          !sourceStats.isFile() ||
          destinationStats.isSymbolicLink() ||
          !destinationStats.isFile() ||
          sourceStats.dev !== confirmation.sourceDevice ||
          sourceStats.ino !== confirmation.sourceInode ||
          destinationStats.dev !== confirmation.sourceDevice ||
          destinationStats.ino !== confirmation.sourceInode
        ) {
          throw new Error();
        }
      } catch {
        throw new OrganizerError(
          "EXECUTION_PARTIAL",
          "The organization operation stopped after creating the destination entry.",
        );
      }
      try {
        await this.#executionOperations.unlink(confirmation.sourcePath);
      } catch {
        throw new OrganizerError(
          "EXECUTION_PARTIAL",
          "The organization operation stopped after creating the destination entry.",
        );
      }
      this.#executionFaults.afterSourceRemoved?.();
      this.#executionStore.setPhase(confirmationId, "source-removed");

      this.#executionStore.complete(confirmationId, false, this.#now());
      const processConfirmation = this.#confirmations.get(confirmationId);
      if (processConfirmation) processConfirmation.state = "consumed";
      return executionResult(confirmation);
    } catch (error) {
      if (!destinationCreated && !(error instanceof SimulatedExecutionCrash) && !isStorageError(error)) {
        this.#executionStore.invalidate(confirmationId, false, this.#now());
        const processConfirmation = this.#confirmations.get(confirmationId);
        if (processConfirmation) processConfirmation.state = "invalidated";
      }
      throw error;
    }
  }

  async recover(): Promise<void> {
    while (true) {
      const records = this.#executionStore.listExecuting();
      if (records.length === 0) return;
      let recovered = false;
      for (const record of records) {
        if (!this.#executionStore.claimRecovery(record.confirmationId, this.#now())) continue;
        recovered = true;
        await this.#recoverRecord(record);
      }
      if (!recovered) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async #recoverRecord(record: DurableExecutionRecord): Promise<void> {
    try {
      await validateDurableRoots(record);
      const [source, destination] = await Promise.all([
        inspectRetainedEntry(record.sourcePath, record),
        inspectRetainedEntry(record.destinationPath, record),
      ]);
      if (source === "retained" && destination === "missing") {
        this.#executionStore.invalidate(record.confirmationId, false, this.#now());
        return;
      }
      if (source === "retained" && destination === "retained") {
        await this.#executionOperations.unlink(record.sourcePath);
        this.#executionStore.setPhase(record.confirmationId, "source-removed");
        this.#executionStore.complete(record.confirmationId, true, this.#now());
        return;
      }
      if (source === "missing" && destination === "retained") {
        this.#executionStore.complete(record.confirmationId, true, this.#now());
        return;
      }
      this.#executionStore.invalidate(record.confirmationId, false, this.#now());
    } catch (error) {
      if (isStorageError(error)) throw error;
      this.#executionStore.invalidate(record.confirmationId, false, this.#now());
    }
  }
}

export class SimulatedExecutionCrash extends Error {}

async function revalidatePlan(plan: PlanRecord): Promise<void> {
  try {
    assertPathInside(plan.organizationRoot, plan.destinationPath);
    const currentRoot = await resolveOrganizationRoot(plan.organizationRoot);
    if (currentRoot !== plan.organizationRoot) throw new Error();
    const resolved = await plan.registry.resolveIdentity(plan.file.fileId);
    if (!sameResolvedIdentity(resolved, plan.file)) throw new Error();
    await assertNoSymlinkedAncestors(plan.organizationRoot, path.dirname(plan.destinationPath));
    const conflict = await inspectConflict(plan.file.path, plan.destinationPath);
    if (conflict !== "none") {
      throw new OrganizerError(
        "PLAN_CONFLICT",
        "The organization plan cannot be confirmed because its destination is unavailable.",
      );
    }
    const finalResolved = await plan.registry.resolveIdentity(plan.file.fileId);
    if (!sameResolvedIdentity(finalResolved, plan.file)) throw new Error();
  } catch (error) {
    if (error instanceof OrganizerError && error.code === "PLAN_CONFLICT") throw error;
    throw new OrganizerError("PLAN_CHANGED", "The organization plan no longer matches current filesystem state.");
  }
}

async function revalidateConfirmation(confirmation: ConfirmationRecord): Promise<void> {
  try {
    assertPathInside(confirmation.organizationRoot, confirmation.destinationPath);
    const currentRoot = await resolveOrganizationRoot(confirmation.organizationRoot);
    if (currentRoot !== confirmation.organizationRoot) throw new Error();

    const resolved = await confirmation.registry.resolveIdentity(confirmation.file.fileId);
    if (!sameResolvedIdentity(resolved, confirmation.file)) throw new Error();

    const destinationDirectory = path.dirname(confirmation.destinationPath);
    await assertNoSymlinkedAncestors(confirmation.organizationRoot, destinationDirectory);
    const [sourceStats, destinationDirectoryStats] = await Promise.all([
      lstat(confirmation.file.path),
      lstat(destinationDirectory),
    ]);
    if (
      sourceStats.isSymbolicLink() ||
      !sourceStats.isFile() ||
      sourceStats.dev !== confirmation.file.device ||
      sourceStats.ino !== confirmation.file.inode
    ) {
      throw new Error();
    }
    if (destinationDirectoryStats.isSymbolicLink() || !destinationDirectoryStats.isDirectory()) {
      throw new OrganizerError(
        "EXECUTION_DESTINATION_UNAVAILABLE",
        "The controlled destination directory is unavailable.",
      );
    }
    if (sourceStats.dev !== destinationDirectoryStats.dev) {
      throw new OrganizerError(
        "EXECUTION_CROSS_FILESYSTEM",
        "The organization operation requires source and destination to use the same filesystem.",
      );
    }
    if ((await inspectConflict(confirmation.file.path, confirmation.destinationPath)) !== "none") {
      throw new OrganizerError("EXECUTION_CONFLICT", "The organization destination is no longer available.");
    }

    const finalResolved = await confirmation.registry.resolveIdentity(confirmation.file.fileId);
    if (!sameResolvedIdentity(finalResolved, confirmation.file)) throw new Error();
  } catch (error) {
    if (
      error instanceof OrganizerError &&
      ["EXECUTION_DESTINATION_UNAVAILABLE", "EXECUTION_CROSS_FILESYSTEM", "EXECUTION_CONFLICT"].includes(error.code)
    ) {
      throw error;
    }
    if (isMissingFileError(error) && path.dirname(confirmation.destinationPath) !== confirmation.organizationRoot) {
      throw new OrganizerError(
        "EXECUTION_DESTINATION_UNAVAILABLE",
        "The controlled destination directory is unavailable.",
      );
    }
    throw new OrganizerError("EXECUTION_CHANGED", "The confirmed organization operation no longer matches filesystem state.");
  }
}

async function revalidateDurableExecution(record: DurableExecutionRecord): Promise<void> {
  try {
    await validateDurableRoots(record);
    assertPathInside(record.inboxRoot, record.sourcePath);
    assertPathInside(record.organizationRoot, record.destinationPath);
    await assertNoSymlinkedAncestors(record.organizationRoot, path.dirname(record.destinationPath));
    const [sourceStats, destinationDirectoryStats] = await Promise.all([
      lstat(record.sourcePath),
      lstat(path.dirname(record.destinationPath)),
    ]);
    if (
      sourceStats.isSymbolicLink() ||
      !sourceStats.isFile() ||
      sourceStats.dev !== record.sourceDevice ||
      sourceStats.ino !== record.sourceInode ||
      sourceStats.size !== record.sourceSize ||
      sourceStats.mtimeMs !== record.sourceModifiedAtMs
    ) {
      throw new Error();
    }
    if (destinationDirectoryStats.isSymbolicLink() || !destinationDirectoryStats.isDirectory()) {
      throw new OrganizerError("EXECUTION_DESTINATION_UNAVAILABLE", "The controlled destination directory is unavailable.");
    }
    if (sourceStats.dev !== destinationDirectoryStats.dev) {
      throw new OrganizerError(
        "EXECUTION_CROSS_FILESYSTEM",
        "The organization operation requires source and destination to use the same filesystem.",
      );
    }
    if ((await inspectConflict(record.sourcePath, record.destinationPath)) !== "none") {
      throw new OrganizerError("EXECUTION_CONFLICT", "The organization destination is no longer available.");
    }
  } catch (error) {
    if (
      error instanceof OrganizerError &&
      ["EXECUTION_DESTINATION_UNAVAILABLE", "EXECUTION_CROSS_FILESYSTEM", "EXECUTION_CONFLICT"].includes(error.code)
    ) {
      throw error;
    }
    if (isMissingFileError(error) && path.dirname(record.destinationPath) !== record.organizationRoot) {
      throw new OrganizerError("EXECUTION_DESTINATION_UNAVAILABLE", "The controlled destination directory is unavailable.");
    }
    throw new OrganizerError("EXECUTION_CHANGED", "The confirmed organization operation no longer matches filesystem state.");
  }
}

async function validateDurableRoots(record: DurableExecutionRecord): Promise<void> {
  const [inboxCanonical, organizationCanonical] = await Promise.all([
    realpath(record.inboxRoot),
    realpath(record.organizationRoot),
  ]);
  if (inboxCanonical !== record.inboxRoot || organizationCanonical !== record.organizationRoot) throw new Error();
  const [inboxStats, organizationStats] = await Promise.all([
    lstat(inboxCanonical),
    lstat(organizationCanonical),
  ]);
  if (
    !inboxStats.isDirectory() ||
    inboxStats.dev !== record.inboxRootDevice ||
    inboxStats.ino !== record.inboxRootInode ||
    !organizationStats.isDirectory() ||
    organizationStats.dev !== record.organizationRootDevice ||
    organizationStats.ino !== record.organizationRootInode
  ) {
    throw new Error();
  }
  assertPathInside(record.inboxRoot, record.sourcePath);
  assertPathInside(record.organizationRoot, record.destinationPath);
  await assertNoSymlinkedAncestors(record.organizationRoot, path.dirname(record.destinationPath));
}

async function inspectRetainedEntry(
  entryPath: string,
  record: DurableExecutionRecord,
): Promise<"retained" | "missing" | "other"> {
  try {
    const stats = await lstat(entryPath);
    return !stats.isSymbolicLink() &&
      stats.isFile() &&
      stats.dev === record.sourceDevice &&
      stats.ino === record.sourceInode
      ? "retained"
      : "other";
  } catch (error) {
    if (isMissingFileError(error)) return "missing";
    throw error;
  }
}

function executionResult(record: DurableExecutionRecord): OrganizationExecutionResult {
  return {
    confirmationId: record.confirmationId,
    planId: record.planId,
    fileId: record.fileId,
    status: "completed",
  };
}

function isStorageError(error: unknown): boolean {
  return error instanceof OrganizerError && error.code === "EXECUTION_STORAGE_FAILED";
}

function sameResolvedIdentity(left: ResolvedFileIdentity, right: ResolvedFileIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function mapLinkError(error: unknown): OrganizerError {
  if (hasErrorCode(error, "EEXIST")) {
    return new OrganizerError("EXECUTION_CONFLICT", "The organization destination is no longer available.");
  }
  if (hasErrorCode(error, "EXDEV")) {
    return new OrganizerError(
      "EXECUTION_CROSS_FILESYSTEM",
      "The organization operation requires source and destination to use the same filesystem.",
    );
  }
  return new OrganizerError("EXECUTION_FAILED", "The organization operation could not be completed.");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function assertSafeFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(filename) ||
    filename.endsWith(".") ||
    filename.endsWith(" ") ||
    windowsReservedName.test(filename)
  ) {
    throw new OrganizerError("PLAN_UNSAFE_FILENAME", "The source filename is not safe for planning.");
  }
}

async function resolveOrganizationRoot(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    const stats = await lstat(canonical);
    if (!stats.isDirectory()) {
      throw new Error();
    }
    return canonical;
  } catch {
    throw new OrganizerError("PLAN_VALIDATION_FAILED", "The organization root could not be validated.");
  }
}

async function assertNoSymlinkedAncestors(root: string, destinationDirectory: string): Promise<void> {
  const relative = path.relative(root, destinationDirectory);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new OrganizerError("PLAN_UNSAFE_DESTINATION", "The proposed destination has an unsafe ancestor.");
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      if (error instanceof OrganizerError) {
        throw error;
      }
      throw new OrganizerError("PLAN_VALIDATION_FAILED", "The proposed destination could not be validated.");
    }
  }
}

async function inspectConflict(sourcePath: string, destinationPath: string): Promise<DestinationConflict> {
  try {
    const [sourceStats, destinationStats] = await Promise.all([lstat(sourcePath), lstat(destinationPath)]);
    if (sourceStats.dev === destinationStats.dev && sourceStats.ino === destinationStats.ino) {
      throw new OrganizerError("PLAN_UNSAFE_DESTINATION", "The source and proposed destination must be different.");
    }
    if (destinationStats.isFile()) return "existing-file";
    if (destinationStats.isDirectory()) return "existing-directory";
    return "existing-other";
  } catch (error) {
    if (isMissingFileError(error)) return "none";
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("PLAN_VALIDATION_FAILED", "The proposed destination could not be validated.");
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
