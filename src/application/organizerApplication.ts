import path from "node:path";
import type { OrganizerConfig } from "../config/config.js";
import {
  submittedClassificationSchema,
  validateSubmittedClassification,
} from "../core/classification/validateSubmittedClassification.js";
import { inspectFile } from "../core/inspector/inspectFile.js";
import {
  DirectoryPlanRegistry,
  type DirectoryPlanRegistryOptions,
} from "../core/planning/directoryPlanning.js";
import {
  InMemoryExecutionStore,
  SqliteExecutionStore,
  type DirectoryExecutionStore,
  type ExecutionStore,
} from "../core/planning/executionStore.js";
import {
  OrganizationPlanRegistry,
  type OrganizationPlanRegistryOptions,
} from "../core/planning/previewOrganizationPlan.js";
import { FileRegistry } from "../core/scanner/scanDownloads.js";
import type { DirectoryExecutionResult, DirectoryPlanConfirmation, DirectoryPlanPreview } from "../domain/directoryPlan.js";
import { OrganizerError } from "../domain/error.js";
import type { FileInspection } from "../domain/inspection.js";
import type {
  OrganizationExecutionResult,
  OrganizationPlanConfirmation,
  OrganizationPlanPreview,
} from "../domain/organizationPlan.js";
import type { z } from "zod";
import type {
  DesktopSessionValidation,
  OrganizerApplicationState,
  OrganizerApplicationStatus,
  OrganizerDetailedScanResult,
  OrganizerEventListener,
  OrganizerLifecycleEvent,
  OrganizerScanResult,
  PrivilegedDesktopFolderSelection,
} from "./contracts.js";
import {
  isDesktopDirectoryIdentityCurrent,
  validateDesktopDirectory,
  type ValidatedDesktopDirectory,
} from "./desktopSession.js";
import {
  classifierInputFromInspection,
  type LocalClassifier,
  type LocalClassifierOutput,
} from "./localClassifier.js";

type ApplicationExecutionStore = ExecutionStore & DirectoryExecutionStore & { close?(): void };

export type OrganizerApplicationOptions = {
  deferFolders?: boolean;
  mutationUnavailable?: boolean;
  planRegistryOptions?: OrganizationPlanRegistryOptions;
  directoryPlanRegistryOptions?: DirectoryPlanRegistryOptions;
  executionStoreFactory?: (config: OrganizerConfig) => ApplicationExecutionStore;
  classifier?: LocalClassifier;
};

type RegistryGeneration = {
  registry?: FileRegistry;
  planRegistry: OrganizationPlanRegistry;
  directoryPlanRegistry: DirectoryPlanRegistry;
};

export class OrganizerApplication {
  readonly #config: OrganizerConfig;
  readonly #options: OrganizerApplicationOptions;
  readonly #listeners = new Set<OrganizerEventListener>();
  readonly #retiredGenerations: RegistryGeneration[] = [];
  readonly #desktopSessionMode: boolean;
  #store: ApplicationExecutionStore;
  #generation: RegistryGeneration;
  #state: OrganizerApplicationState;
  #mutationUnavailable = false;
  #inbox: ValidatedDesktopDirectory | undefined;
  #destination: ValidatedDesktopDirectory | undefined;
  #inboxValidation: DesktopSessionValidation["inbox"];
  #destinationValidation: DesktopSessionValidation["destination"];
  #shutdownPromise: Promise<void> | undefined;

  private constructor(
    config: OrganizerConfig,
    options: OrganizerApplicationOptions,
    state: OrganizerApplicationState,
  ) {
    this.#config = config;
    this.#options = options;
    this.#desktopSessionMode = options.deferFolders ?? false;
    this.#state = state;
    this.#mutationUnavailable = options.mutationUnavailable ?? false;
    this.#store = new InMemoryExecutionStore();
    if (!options.deferFolders) {
      this.#inbox = configuredDirectory(config.downloadsDirectory);
      this.#destination = configuredDirectory(config.organizationRoot);
      this.#inboxValidation = this.#inbox.validation;
      this.#destinationValidation = this.#destination.validation;
    }
    this.#generation = this.createGeneration(this.#store);
  }

  static createInMemory(
    config: OrganizerConfig,
    options: OrganizerApplicationOptions = {},
  ): OrganizerApplication {
    return new OrganizerApplication(config, options, "ready");
  }

  static createDurable(
    config: OrganizerConfig,
    options: OrganizerApplicationOptions = {},
  ): OrganizerApplication {
    return new OrganizerApplication(config, options, "created");
  }

  get registry(): FileRegistry {
    this.assertAcceptingOperations();
    return this.requireRegistry();
  }

  get planRegistry(): OrganizationPlanRegistry {
    return this.#generation.planRegistry;
  }

  get directoryPlanRegistry(): DirectoryPlanRegistry {
    return this.#generation.directoryPlanRegistry;
  }

  get status(): OrganizerApplicationStatus {
    return {
      state: this.#state,
      mutationAvailable: this.#state === "ready" && !this.#mutationUnavailable && this.sessionValidation().ready,
      session: this.sessionValidation(),
    };
  }

  subscribe(listener: OrganizerEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    if (this.#state !== "created") return;
    this.#state = "initializing";
    this.emit({ type: "startup-started" });
    let store: ApplicationExecutionStore | undefined;
    try {
      store = this.#options.executionStoreFactory?.(this.#config) ?? new SqliteExecutionStore(
        this.#config.databasePath,
        { recoveryLeaseMs: this.#config.executionRecoveryLeaseMs },
      );
      this.replaceStoreAndGeneration(store);
      this.emit({ type: "recovery-started", operation: "directories" });
      await this.#generation.directoryPlanRegistry.recover();
      this.emit({ type: "recovery-completed", operation: "directories" });
      this.emit({ type: "recovery-started", operation: "moves" });
      await this.#generation.planRegistry.recover();
      this.emit({ type: "recovery-completed", operation: "moves" });
      this.emit({ type: "retention-cleanup-started" });
      const policy = {
        invalidatedMs: this.#config.invalidatedExecutionRetentionMs,
        expiredMs: this.#config.expiredExecutionRetentionMs,
        completedMs: this.#config.completedExecutionReplayRetentionMs,
      };
      store.cleanupTerminal(Date.now(), policy);
      store.cleanupTerminalDirectories(Date.now(), policy);
      this.emit({ type: "retention-cleanup-completed" });
      this.#state = "ready";
      this.emit({ type: "startup-completed", degraded: false });
    } catch {
      try {
        store?.close?.();
      } catch {}
      this.#mutationUnavailable = true;
      this.replaceStoreAndGeneration(new InMemoryExecutionStore());
      this.#state = "degraded";
      this.emit({ type: "startup-completed", degraded: true });
    }
  }

  async selectDesktopFolder(
    selection: PrivilegedDesktopFolderSelection,
  ): Promise<DesktopSessionValidation> {
    this.assertAcceptingOperations();
    if (
      selection.source !== "native-dialog" ||
      !["inbox", "destination"].includes(selection.kind) ||
      typeof selection.directoryPath !== "string" ||
      !path.isAbsolute(selection.directoryPath)
    ) {
      throw new OrganizerError("UNSAFE_PATH", "The selected directory was not provided by a native dialog.");
    }

    const previous = selection.kind === "inbox" ? this.#inbox : this.#destination;
    const validated = await validateDesktopDirectory(selection);
    const next = validated.directory;
    const changed = !sameDirectory(previous, next);
    if (selection.kind === "inbox") {
      this.#inbox = next;
      this.#inboxValidation = validated.validation;
    } else {
      this.#destination = next;
      this.#destinationValidation = validated.validation;
    }

    if (changed) {
      this.rotateSession();
      this.emit({ type: "session-invalidated" });
      if (this.sessionValidation().ready) this.emit({ type: "session-configured" });
    }
    return this.sessionValidation(selection.kind, validated.validation);
  }

  async scan(): Promise<OrganizerScanResult> {
    return (await this.scanDetailed()).files;
  }

  async scanDetailed(): Promise<OrganizerDetailedScanResult> {
    this.assertAcceptingOperations();
    await this.assertSessionIdentity();
    const registry = this.requireRegistry();
    this.emit({ type: "scan-started" });
    const result = await registry.scanDetailed();
    this.emit({
      type: "scan-completed",
      discoveredFileCount: result.files.length,
      skippedEntryCount: result.skippedEntryCount,
    });
    return result;
  }

  async inspect(fileId: string): Promise<FileInspection> {
    this.assertAcceptingOperations();
    await this.assertSessionIdentity();
    return inspectFile(this.requireRegistry(), fileId, this.sessionConfig());
  }

  async classify(fileId: string): Promise<LocalClassifierOutput> {
    this.assertAcceptingOperations();
    await this.assertSessionIdentity();
    if (!this.#options.classifier) {
      throw new OrganizerError("EXECUTION_FAILED", "AI classification is not configured.");
    }
    const inspection = await inspectFile(this.requireRegistry(), fileId, this.sessionConfig());
    return this.#options.classifier.classify(classifierInputFromInspection(inspection));
  }

  async submitClassificationAndPreview(
    fileId: string,
    submittedClassification: z.infer<typeof submittedClassificationSchema>,
  ): Promise<OrganizationPlanPreview> {
    this.assertAcceptingOperations();
    await this.assertSessionIdentity();
    const generation = this.#generation;
    const registry = this.requireRegistry(generation);
    const inspection = await inspectFile(registry, fileId, this.sessionConfig());
    const classification = validateSubmittedClassification(inspection, submittedClassification);
    return generation.planRegistry.preview(registry, classification, this.sessionConfig());
  }

  async previewDirectories(planId: string): Promise<DirectoryPlanPreview> {
    this.assertAcceptingOperations();
    await this.assertSessionIdentity();
    return this.#generation.directoryPlanRegistry.preview(
      this.#generation.planRegistry,
      planId,
      this.sessionConfig(),
    );
  }

  async confirmDirectories(directoryPlanId: string): Promise<DirectoryPlanConfirmation> {
    this.assertMutationAvailable();
    await this.assertSessionIdentity();
    return this.#generation.directoryPlanRegistry.confirm(directoryPlanId);
  }

  async executeDirectories(directoryConfirmationId: string): Promise<DirectoryExecutionResult> {
    this.assertDurableExecutionAvailable();
    return this.#generation.directoryPlanRegistry.execute(directoryConfirmationId);
  }

  async confirmMove(planId: string): Promise<OrganizationPlanConfirmation> {
    this.assertMutationAvailable();
    await this.assertSessionIdentity();
    return this.#generation.planRegistry.confirm(planId);
  }

  async executeMove(confirmationId: string): Promise<OrganizationExecutionResult> {
    this.assertDurableExecutionAvailable();
    return this.#generation.planRegistry.execute(confirmationId);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#state === "stopped") return;
    this.#state = "shutting-down";
    this.emit({ type: "shutdown-started" });
    this.#shutdownPromise = (async () => {
      const generations = [this.#generation, ...this.#retiredGenerations];
      await Promise.all(generations.flatMap((generation) => [
        generation.planRegistry.waitForActiveExecutions(),
        generation.directoryPlanRegistry.waitForActiveExecutions(),
      ]));
      this.#store.close?.();
      this.#state = "stopped";
      this.emit({ type: "shutdown-completed" });
    })();
    return this.#shutdownPromise;
  }

  private createGeneration(store: ApplicationExecutionStore): RegistryGeneration {
    const registry = this.#inbox && this.#destination && this.#inbox.device === this.#destination.device
      ? new FileRegistry(this.#inbox.canonicalPath)
      : undefined;
    return {
      ...(registry ? { registry } : {}),
      planRegistry: new OrganizationPlanRegistry({
        ...this.#options.planRegistryOptions,
        executionStore: store,
      }),
      directoryPlanRegistry: new DirectoryPlanRegistry({
        ...this.#options.directoryPlanRegistryOptions,
        executionStore: store,
      }),
    };
  }

  private replaceStoreAndGeneration(store: ApplicationExecutionStore): void {
    this.#store = store;
    this.#generation = this.createGeneration(store);
  }

  private rotateSession(): void {
    this.#retiredGenerations.push(this.#generation);
    this.#generation = this.createGeneration(this.#store);
  }

  private requireRegistry(generation = this.#generation): FileRegistry {
    if (!generation.registry || !this.sessionValidation().ready) {
      throw new OrganizerError("UNSAFE_PATH", "The inbox and destination directories are not configured safely.");
    }
    return generation.registry;
  }

  private sessionConfig(): OrganizerConfig {
    if (!this.#inbox || !this.#destination || this.#inbox.device !== this.#destination.device) {
      throw new OrganizerError("UNSAFE_PATH", "The inbox and destination directories are not configured safely.");
    }
    return {
      ...this.#config,
      downloadsDirectory: this.#inbox.canonicalPath,
      organizationRoot: this.#destination.canonicalPath,
    };
  }

  private sessionValidation(
    overrideKind?: "inbox" | "destination",
    overrideValidation?: DesktopSessionValidation["inbox"],
  ): DesktopSessionValidation {
    const inbox = overrideKind === "inbox" ? overrideValidation : this.#inboxValidation;
    const destination = overrideKind === "destination" ? overrideValidation : this.#destinationValidation;
    const sameFilesystem = this.#inbox && this.#destination
      ? this.#inbox.device === this.#destination.device
      : null;
    return {
      ...(inbox ? { inbox } : {}),
      ...(destination ? { destination } : {}),
      sameFilesystem,
      ready: Boolean(this.#inbox && this.#destination && sameFilesystem),
    };
  }

  private assertAcceptingOperations(): void {
    if (!["ready", "degraded"].includes(this.#state)) {
      throw new OrganizerError("EXECUTION_FAILED", "The organizer application is not accepting operations.");
    }
  }

  private assertMutationAvailable(): void {
    this.assertDurableExecutionAvailable();
    this.requireRegistry();
  }

  private assertDurableExecutionAvailable(): void {
    this.assertAcceptingOperations();
    if (this.#mutationUnavailable) {
      throw new OrganizerError("EXECUTION_STORAGE_FAILED", "The organization operation state could not be stored safely.");
    }
  }

  private async assertSessionIdentity(): Promise<void> {
    if (!this.#desktopSessionMode || !this.#inbox || !this.#destination) return;
    const [inboxCurrent, destinationCurrent] = await Promise.all([
      isDesktopDirectoryIdentityCurrent(this.#inbox),
      isDesktopDirectoryIdentityCurrent(this.#destination),
    ]);
    if (inboxCurrent && destinationCurrent) return;

    if (!inboxCurrent) {
      this.#inboxValidation = unavailableValidation(this.#inbox.displayPath);
      this.#inbox = undefined;
    }
    if (!destinationCurrent) {
      this.#destinationValidation = unavailableValidation(this.#destination.displayPath);
      this.#destination = undefined;
    }
    this.rotateSession();
    this.emit({ type: "session-invalidated" });
    throw new OrganizerError("UNSAFE_PATH", "A selected directory no longer matches the validated desktop session.");
  }

  private emit(event: OrganizerLifecycleEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

function configuredDirectory(directoryPath: string): ValidatedDesktopDirectory {
  return {
    canonicalPath: directoryPath,
    displayPath: directoryPath,
    device: 0,
    inode: 0,
    validation: { displayPath: directoryPath, status: "valid", readable: true, writable: true },
  };
}

function sameDirectory(
  left: ValidatedDesktopDirectory | undefined,
  right: ValidatedDesktopDirectory | undefined,
): boolean {
  return Boolean(left && right && left.canonicalPath === right.canonicalPath && left.device === right.device && left.inode === right.inode);
}

function unavailableValidation(displayPath: string): NonNullable<DesktopSessionValidation["inbox"]> {
  return { displayPath, status: "unavailable", readable: false, writable: false };
}
