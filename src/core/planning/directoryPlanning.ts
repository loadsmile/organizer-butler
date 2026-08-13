import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import type { OrganizerConfig } from "../../config/config.js";
import type {
  DirectoryExecutionResult,
  DirectoryPlanConfirmation,
  DirectoryPlanPreview,
} from "../../domain/directoryPlan.js";
import { OrganizerError } from "../../domain/error.js";
import { assertPathInside } from "../security/paths.js";
import type { ControlledDirectoryIntent, OrganizationPlanRegistry } from "./previewOrganizationPlan.js";
import {
  type DirectoryExecutionStore,
  type DurableDirectoryExecutionRecord,
  type DurableDirectorySegment,
  InMemoryExecutionStore,
} from "./executionStore.js";

export type DirectoryPlanningConfig = Pick<
  OrganizerConfig,
  "directoryPlanExpiryMs" | "directoryConfirmationExpiryMs"
>;

type DirectoryPlanRecord = {
  intent: ControlledDirectoryIntent;
  statuses: readonly ["existing" | "missing", "existing" | "missing"];
  expiresAt: number;
  confirmationExpiryMs: number;
  state: "pending" | "confirming" | "consumed" | "invalidated" | "expired";
};

type DirectoryOperations = {
  mkdir(directoryPath: string): Promise<void>;
  rmdir(directoryPath: string): Promise<void>;
};

export type DirectoryPlanRegistryOptions = {
  now?: () => number;
  createId?: () => string;
  executionStore?: DirectoryExecutionStore;
  directoryOperations?: DirectoryOperations;
  executionFaults?: {
    beforeSegmentCreate?(ordinal: number): void;
    afterSegmentCreate?(ordinal: number): void;
    afterDirectoriesCreated?(): void;
  };
};

export class DirectoryPlanRegistry {
  readonly #plans = new Map<string, DirectoryPlanRecord>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #store: DirectoryExecutionStore;
  readonly #operations: DirectoryOperations;
  readonly #faults: NonNullable<DirectoryPlanRegistryOptions["executionFaults"]>;
  readonly #activeExecutions = new Set<Promise<DirectoryExecutionResult>>();

  constructor(options: DirectoryPlanRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#store = options.executionStore ?? new InMemoryExecutionStore();
    this.#operations = options.directoryOperations ?? {
      mkdir: (directoryPath) => mkdir(directoryPath),
      rmdir: (directoryPath) => rmdir(directoryPath),
    };
    this.#faults = options.executionFaults ?? {};
  }

  async preview(
    plans: OrganizationPlanRegistry,
    planId: string,
    config: DirectoryPlanningConfig,
  ): Promise<DirectoryPlanPreview> {
    const intent = await plans.consumeForDirectoryPlanning(planId);
    const statuses = await inspectIntent(intent);
    const directoryPlanId = `directory_plan_${this.#createId()}`;
    const expiresAt = this.#now() + config.directoryPlanExpiryMs;
    this.#plans.set(directoryPlanId, {
      intent,
      statuses,
      expiresAt,
      confirmationExpiryMs: config.directoryConfirmationExpiryMs,
      state: "pending",
    });
    return {
      directoryPlanId,
      fileId: intent.fileId,
      expiresAt: new Date(expiresAt).toISOString(),
      directories: intent.directoryNames.map((name, index) => ({ name, status: statuses[index] ?? "missing" })),
    };
  }

  async confirm(directoryPlanId: string): Promise<DirectoryPlanConfirmation> {
    const plan = this.#plans.get(directoryPlanId);
    if (!plan) {
      throw new OrganizerError("INVALID_DIRECTORY_PLAN_ID", "The directory plan ID was not produced by this server process.");
    }
    if (plan.state !== "pending") {
      throw new OrganizerError("DIRECTORY_PLAN_ALREADY_USED", "The directory plan has already been used.");
    }
    if (this.#now() >= plan.expiresAt) {
      plan.state = "expired";
      throw new OrganizerError("DIRECTORY_PLAN_EXPIRED", "The directory plan has expired.");
    }
    plan.state = "confirming";
    try {
      const statuses = await inspectIntent(plan.intent);
      if (statuses.some((status, index) => status !== plan.statuses[index])) {
        throw new OrganizerError("DIRECTORY_PLAN_CHANGED", "The directory plan no longer matches current filesystem state.");
      }
      const rootStats = await lstat(plan.intent.organizationRoot);
      const confirmationId = `directory_confirm_${this.#createId()}`;
      const expiresAt = this.#now() + plan.confirmationExpiryMs;
      this.#store.createDirectory({
        confirmationId,
        planId: directoryPlanId,
        fileId: plan.intent.fileId,
        organizationRoot: plan.intent.organizationRoot,
        organizationRootDevice: rootStats.dev,
        organizationRootInode: rootStats.ino,
        organizationRootUid: rootStats.uid,
        organizationRootGid: rootStats.gid,
        destinationPath: plan.intent.directoryPaths[1],
        expiresAt,
        state: "ready",
        phase: "prepared",
        recoveryOutcome: "none",
        terminalAt: null,
        segments: await Promise.all(plan.intent.directoryPaths.map(async (directoryPath, ordinal) => {
          const stats = statuses[ordinal] === "existing" ? await lstat(directoryPath) : undefined;
          return {
            ordinal,
            directoryPath,
            state: statuses[ordinal] === "existing" ? "existing" as const : "pending" as const,
            parentDevice: null,
            parentInode: null,
            parentUid: null,
            parentGid: null,
            directoryDevice: stats ? Number(stats.dev) : null,
            directoryInode: stats ? Number(stats.ino) : null,
            directoryUid: stats ? Number(stats.uid) : null,
            directoryGid: stats ? Number(stats.gid) : null,
            createdByOperation: false,
          };
        })),
      });
      plan.state = "consumed";
      return {
        directoryConfirmationId: confirmationId,
        directoryPlanId,
        fileId: plan.intent.fileId,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      if (plan.state === "confirming") plan.state = "invalidated";
      throw error;
    }
  }

  execute(confirmationId: string): Promise<DirectoryExecutionResult> {
    const execution = this.#execute(confirmationId);
    this.#activeExecutions.add(execution);
    void execution.finally(() => this.#activeExecutions.delete(execution)).catch(() => {});
    return execution;
  }

  async waitForActiveExecutions(): Promise<void> {
    await Promise.allSettled([...this.#activeExecutions]);
  }

  async recover(): Promise<void> {
    while (true) {
      const records = this.#store.listExecutingDirectories();
      if (records.length === 0) return;
      let claimed = false;
      for (const record of records) {
        if (!this.#store.claimDirectoryRecovery(record.confirmationId, this.#now())) continue;
        claimed = true;
        await this.#recoverRecord(record);
      }
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async #execute(confirmationId: string): Promise<DirectoryExecutionResult> {
    const claim = this.#store.claimDirectory(confirmationId, this.#now());
    if (!claim) {
      throw new OrganizerError(
        "INVALID_DIRECTORY_CONFIRMATION_ID",
        "The directory confirmation ID was not produced by this server process.",
      );
    }
    const record = claim.record;
    if (record.state === "completed") return directoryResult(record);
    if (record.state === "executing" && !claim.claimed) {
      throw new OrganizerError("DIRECTORY_CONFIRMATION_ALREADY_EXECUTING", "The directory confirmation is already executing.");
    }
    if (record.state === "expired") {
      throw new OrganizerError("DIRECTORY_CONFIRMATION_EXPIRED", "The directory confirmation has expired.");
    }
    if (record.state !== "executing") {
      throw new OrganizerError("DIRECTORY_CONFIRMATION_INVALIDATED", "The directory confirmation is no longer valid.");
    }

    let created = false;
    try {
      await validateRoot(record);
      if (this.#now() >= record.expiresAt) {
        this.#store.invalidateDirectory(confirmationId, true, "invalidated", this.#now());
        throw new OrganizerError("DIRECTORY_CONFIRMATION_EXPIRED", "The directory confirmation has expired.");
      }
      for (const segment of record.segments) {
        if (segment.state === "existing") {
          await validateExistingSegment(record, segment);
          continue;
        }
        const parentStats = await validateParent(record, segment);
        const creating = withParent(segment, parentStats, "creating");
        this.#store.setDirectoryPhase(confirmationId, "creating");
        this.#store.setDirectorySegment(confirmationId, creating);
        this.#faults.beforeSegmentCreate?.(segment.ordinal);
        try {
          await this.#operations.mkdir(segment.directoryPath);
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            throw new OrganizerError("DIRECTORY_EXECUTION_CONFLICT", "A controlled directory is no longer available.");
          }
          throw new OrganizerError("DIRECTORY_EXECUTION_FAILED", "The controlled directories could not be created.");
        }
        created = true;
        this.#faults.afterSegmentCreate?.(segment.ordinal);
        const stats = await lstat(segment.directoryPath);
        if (stats.isSymbolicLink() || !stats.isDirectory() || !sameOwner(stats, parentStats)) {
          throw new OrganizerError("DIRECTORY_EXECUTION_PARTIAL", "Directory creation stopped after a controlled directory was created.");
        }
        this.#store.setDirectorySegment(confirmationId, {
          ...creating,
          state: "created",
          directoryDevice: stats.dev,
          directoryInode: stats.ino,
          directoryUid: stats.uid,
          directoryGid: stats.gid,
          createdByOperation: true,
        });
      }
      this.#store.setDirectoryPhase(confirmationId, "directories-created");
      this.#faults.afterDirectoriesCreated?.();
      this.#store.completeDirectory(confirmationId, false, this.#now());
      return directoryResult(record);
    } catch (error) {
      if (!created && !(error instanceof SimulatedDirectoryExecutionCrash) && !isStorageError(error)) {
        this.#store.invalidateDirectory(confirmationId, false, "invalidated", this.#now());
      }
      throw error;
    }
  }

  async #recoverRecord(record: DurableDirectoryExecutionRecord): Promise<void> {
    try {
      await validateRoot(record);
      const allPresent = await this.#allSegmentsPresent(record);
      if (allPresent) {
        this.#store.completeDirectory(record.confirmationId, true, this.#now());
        return;
      }
      const rolledBack = await this.#rollbackCreated(record);
      this.#store.invalidateDirectory(
        record.confirmationId,
        false,
        rolledBack ? "rolled-back" : "rollback-incomplete",
        this.#now(),
      );
    } catch (error) {
      if (isStorageError(error)) throw error;
      this.#store.invalidateDirectory(record.confirmationId, false, "rollback-incomplete", this.#now());
    }
  }

  async #allSegmentsPresent(record: DurableDirectoryExecutionRecord): Promise<boolean> {
    for (const segment of record.segments) {
      try {
        const stats = await lstat(segment.directoryPath);
        if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
        if (segment.createdByOperation &&
          (stats.dev !== segment.directoryDevice || stats.ino !== segment.directoryInode ||
            stats.uid !== segment.directoryUid || stats.gid !== segment.directoryGid)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async #rollbackCreated(record: DurableDirectoryExecutionRecord): Promise<boolean> {
    this.#store.setDirectoryPhase(record.confirmationId, "rolling-back");
    let complete = true;
    for (const segment of [...record.segments].reverse()) {
      if (!segment.createdByOperation || segment.state !== "created") continue;
      try {
        const stats = await lstat(segment.directoryPath);
        if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== segment.directoryDevice ||
          stats.ino !== segment.directoryInode || stats.uid !== segment.directoryUid || stats.gid !== segment.directoryGid) {
          throw new Error();
        }
        await this.#operations.rmdir(segment.directoryPath);
        this.#store.setDirectorySegment(record.confirmationId, { ...segment, state: "removed" });
      } catch {
        complete = false;
        this.#store.setDirectorySegment(record.confirmationId, { ...segment, state: "rollback-blocked" });
      }
    }
    return complete;
  }
}

export class SimulatedDirectoryExecutionCrash extends Error {}

async function inspectIntent(intent: ControlledDirectoryIntent): Promise<readonly ["existing" | "missing", "existing" | "missing"]> {
  const canonical = await realpath(intent.organizationRoot).catch(() => "");
  if (canonical !== intent.organizationRoot) throw directoryChanged();
  const statuses: Array<"existing" | "missing"> = [];
  let missing = false;
  for (const directoryPath of intent.directoryPaths) {
    assertPathInside(intent.organizationRoot, directoryPath);
    if (missing) {
      statuses.push("missing");
      continue;
    }
    try {
      const stats = await lstat(directoryPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new OrganizerError("DIRECTORY_PLAN_CONFLICT", "A controlled directory is unavailable.");
      }
      statuses.push("existing");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        missing = true;
        statuses.push("missing");
      } else if (error instanceof OrganizerError) {
        throw error;
      } else {
        throw directoryChanged();
      }
    }
  }
  return statuses as ["existing" | "missing", "existing" | "missing"];
}

async function validateRoot(record: DurableDirectoryExecutionRecord): Promise<void> {
  const canonical = await realpath(record.organizationRoot);
  const stats = await lstat(canonical);
  if (canonical !== record.organizationRoot || stats.isSymbolicLink() || !stats.isDirectory() ||
    stats.dev !== record.organizationRootDevice || stats.ino !== record.organizationRootInode ||
    stats.uid !== record.organizationRootUid || stats.gid !== record.organizationRootGid) throw new Error();
  assertPathInside(record.organizationRoot, record.destinationPath);
}

async function validateParent(record: DurableDirectoryExecutionRecord, segment: DurableDirectorySegment) {
  await validateRoot(record);
  const stats = await lstat(path.dirname(segment.directoryPath));
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== record.organizationRootUid ||
    stats.gid !== record.organizationRootGid) throw directoryExecutionChanged();
  return stats;
}

async function validateExistingSegment(record: DurableDirectoryExecutionRecord, segment: DurableDirectorySegment): Promise<void> {
  await validateParent(record, segment);
  const stats = await lstat(segment.directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== record.organizationRootUid ||
    stats.gid !== record.organizationRootGid || stats.dev !== segment.directoryDevice ||
    stats.ino !== segment.directoryInode) throw directoryExecutionChanged();
}

function withParent(segment: DurableDirectorySegment, stats: Awaited<ReturnType<typeof lstat>>, state: "creating") {
  return {
    ...segment,
    state,
    parentDevice: Number(stats.dev),
    parentInode: Number(stats.ino),
    parentUid: Number(stats.uid),
    parentGid: Number(stats.gid),
  };
}

function sameOwner(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.uid === right.uid && left.gid === right.gid;
}

function directoryResult(record: DurableDirectoryExecutionRecord): DirectoryExecutionResult {
  return {
    directoryConfirmationId: record.confirmationId,
    directoryPlanId: record.planId,
    fileId: record.fileId,
    status: "completed",
  };
}

function directoryChanged(): OrganizerError {
  return new OrganizerError("DIRECTORY_PLAN_CHANGED", "The directory plan no longer matches current filesystem state.");
}

function directoryExecutionChanged(): OrganizerError {
  return new OrganizerError("DIRECTORY_EXECUTION_CHANGED", "The confirmed directory operation no longer matches filesystem state.");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isStorageError(error: unknown): boolean {
  return error instanceof OrganizerError && error.code === "EXECUTION_STORAGE_FAILED";
}
