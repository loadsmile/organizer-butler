import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { folderSelectionFromNativeDialog } from "../src/application/desktopSession.js";
import { OrganizerApplication } from "../src/application/organizerApplication.js";
import { loadConfig } from "../src/config/config.js";
import { SimulatedExecutionCrash } from "../src/core/planning/previewOrganizationPlan.js";
import { OrganizerError } from "../src/domain/error.js";

const temporaryDirectories: string[] = [];
const applications: OrganizerApplication[] = [];

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map((application) => application.shutdown()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<{
  base: string;
  inbox: string;
  destination: string;
  databasePath: string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "organizer-application-"));
  temporaryDirectories.push(base);
  const inbox = path.join(base, "inbox");
  const destination = path.join(base, "destination");
  await Promise.all([mkdir(inbox), mkdir(destination)]);
  return { base, inbox, destination, databasePath: path.join(base, "actions.db") };
}

function configFor(workspace: Awaited<ReturnType<typeof createWorkspace>>) {
  return loadConfig({
    ORGANIZER_DOWNLOADS_DIRECTORY: workspace.inbox,
    ORGANIZER_ROOT: workspace.destination,
    ORGANIZER_DATABASE_PATH: workspace.databasePath,
  });
}

async function selectFolders(
  application: OrganizerApplication,
  inbox: string,
  destination: string,
): Promise<void> {
  await application.selectDesktopFolder(folderSelectionFromNativeDialog("inbox", inbox));
  await application.selectDesktopFolder(folderSelectionFromNativeDialog("destination", destination));
}

async function previewInvoice(application: OrganizerApplication): Promise<{ fileId: string; planId: string }> {
  const [file] = await application.scan();
  assert.ok(file);
  const plan = await application.submitClassificationAndPreview(file.fileId, {
    area: "finance",
    documentType: "invoice",
    rationale: "Deterministic service test classification.",
  });
  return { fileId: file.fileId, planId: plan.planId };
}

describe("OrganizerApplication", () => {
  it("runs recovery and retention before becoming ready without requiring selected folders", async () => {
    const workspace = await createWorkspace();
    const application = OrganizerApplication.createDurable(configFor(workspace), { deferFolders: true });
    applications.push(application);
    const events: string[] = [];
    application.subscribe((event) => {
      events.push("operation" in event ? `${event.type}:${event.operation}` : event.type);
    });

    await application.initialize();

    assert.deepEqual(events, [
      "startup-started",
      "recovery-started:directories",
      "recovery-completed:directories",
      "recovery-started:moves",
      "recovery-completed:moves",
      "retention-cleanup-started",
      "retention-cleanup-completed",
      "startup-completed",
    ]);
    assert.deepEqual(application.status, {
      state: "ready",
      mutationAvailable: false,
      session: { sameFilesystem: null, ready: false },
    });
    await assert.rejects(
      application.selectDesktopFolder({
        source: "renderer",
        kind: "inbox",
        directoryPath: workspace.inbox,
      } as unknown as Parameters<OrganizerApplication["selectDesktopFolder"]>[0]),
      (error: unknown) => error instanceof OrganizerError && error.code === "UNSAFE_PATH",
    );

    await selectFolders(application, workspace.inbox, workspace.destination);
    assert.equal(application.status.session.ready, true);
    assert.equal(application.status.mutationAvailable, true);
  });

  it("keeps reads available in degraded startup and rejects mutation admission", async () => {
    const workspace = await createWorkspace();
    await mkdir(workspace.databasePath);
    const application = OrganizerApplication.createDurable(configFor(workspace), { deferFolders: true });
    applications.push(application);
    const events: { type: string; degraded?: boolean }[] = [];
    application.subscribe((event) => events.push(event));

    await application.initialize();
    await selectFolders(application, workspace.inbox, workspace.destination);

    assert.equal(application.status.state, "degraded");
    assert.deepEqual(await application.scan(), []);
    assert.equal(events.some((event) => event.type === "session-configured"), true);
    assert.equal(events.find((event) => event.type === "startup-completed")?.degraded, true);
    await assert.rejects(
      application.confirmMove("plan_fabricated"),
      (error: unknown) => error instanceof OrganizerError && error.code === "EXECUTION_STORAGE_FAILED",
    );
  });

  it("rotates process-local IDs and unconfirmed plans when a selected folder changes", async () => {
    const workspace = await createWorkspace();
    const replacementInbox = path.join(workspace.base, "replacement-inbox");
    await mkdir(replacementInbox);
    await writeFile(path.join(workspace.inbox, "invoice.txt"), "invoice");
    const application = OrganizerApplication.createInMemory(configFor(workspace), { deferFolders: true });
    applications.push(application);
    const events: string[] = [];
    application.subscribe((event) => events.push(event.type));
    await selectFolders(application, workspace.inbox, workspace.destination);
    const originalRegistry = application.registry;
    const { fileId, planId } = await previewInvoice(application);

    await application.selectDesktopFolder(folderSelectionFromNativeDialog("inbox", replacementInbox));

    assert.notEqual(application.registry, originalRegistry);
    await assert.rejects(
      application.inspect(fileId),
      (error: unknown) => error instanceof OrganizerError && error.code === "INVALID_FILE_ID",
    );
    await assert.rejects(
      application.confirmMove(planId),
      (error: unknown) => error instanceof OrganizerError && error.code === "INVALID_PLAN_ID",
    );
    assert.equal(events.filter((event) => event === "session-invalidated").length, 3);
    assert.equal(events.filter((event) => event === "session-configured").length, 2);
  });

  it("invalidates a desktop session when a selected directory is replaced at the same path", async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.inbox, "notes.txt"), "notes");
    const application = OrganizerApplication.createInMemory(configFor(workspace), { deferFolders: true });
    applications.push(application);
    await selectFolders(application, workspace.inbox, workspace.destination);
    await application.scan();
    await rm(workspace.destination, { recursive: true });
    await mkdir(workspace.destination);

    await assert.rejects(
      application.scan(),
      (error: unknown) => error instanceof OrganizerError && error.code === "UNSAFE_PATH",
    );
    assert.equal(application.status.session.ready, false);
    assert.deepEqual(application.status.session.destination, {
      displayPath: workspace.destination,
      status: "unavailable",
      readable: false,
      writable: false,
    });
  });

  it("recovers an interrupted durable move during the next service startup", async () => {
    const workspace = await createWorkspace();
    const destinationDirectory = path.join(workspace.destination, "Finance", "Invoices");
    await mkdir(destinationDirectory, { recursive: true });
    const sourcePath = path.join(workspace.inbox, "invoice.txt");
    const destinationPath = path.join(destinationDirectory, "invoice.txt");
    await writeFile(sourcePath, "invoice");
    const crashing = OrganizerApplication.createDurable(configFor(workspace), {
      planRegistryOptions: {
        executionFaults: {
          afterDestinationCreated() {
            throw new SimulatedExecutionCrash();
          },
        },
      },
    });
    applications.push(crashing);
    await crashing.initialize();
    const { planId } = await previewInvoice(crashing);
    const confirmation = await crashing.confirmMove(planId);
    await assert.rejects(crashing.executeMove(confirmation.confirmationId), SimulatedExecutionCrash);
    await crashing.shutdown();

    const recovered = OrganizerApplication.createDurable(configFor(workspace), { deferFolders: true });
    applications.push(recovered);
    await recovered.initialize();

    assert.equal(await readFile(destinationPath, "utf8"), "invoice");
    await assert.rejects(readFile(sourcePath, "utf8"), { code: "ENOENT" });
    assert.equal(recovered.status.session.ready, false);
    assert.equal((await recovered.executeMove(confirmation.confirmationId)).status, "completed");
  });

  it("stops admitting work while graceful shutdown waits for an active execution", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace.destination, "Finance", "Invoices"), { recursive: true });
    await writeFile(path.join(workspace.inbox, "invoice.txt"), "invoice");
    let releaseLink!: () => void;
    let markLinkStarted!: () => void;
    const linkStarted = new Promise<void>((resolve) => { markLinkStarted = resolve; });
    const linkReleased = new Promise<void>((resolve) => { releaseLink = resolve; });
    const application = OrganizerApplication.createInMemory(configFor(workspace), {
      planRegistryOptions: {
        executionOperations: {
          async link(sourcePath, destinationPath) {
            markLinkStarted();
            await linkReleased;
            await link(sourcePath, destinationPath);
          },
          unlink,
        },
      },
    });
    applications.push(application);
    const { planId } = await previewInvoice(application);
    const confirmation = await application.confirmMove(planId);
    const execution = application.executeMove(confirmation.confirmationId);
    await linkStarted;

    let shutdownCompleted = false;
    const shutdown = application.shutdown().then(() => { shutdownCompleted = true; });
    await assert.rejects(
      application.scan(),
      (error: unknown) => error instanceof OrganizerError && error.code === "EXECUTION_FAILED",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownCompleted, false);
    releaseLink();
    await execution;
    await shutdown;
    assert.equal(application.status.state, "stopped");
  });

  it("emits truthful scan boundary events and isolates listener failures", async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.inbox, "notes.txt"), "notes");
    await writeFile(path.join(workspace.inbox, ".hidden.txt"), "hidden");
    const application = OrganizerApplication.createInMemory(configFor(workspace));
    applications.push(application);
    const events: unknown[] = [];
    application.subscribe(() => { throw new Error("presentation failure"); });
    application.subscribe((event) => events.push(event));

    const files = await application.scan();

    assert.equal(files.length, 1);
    assert.deepEqual(events, [
      { type: "scan-started" },
      { type: "scan-completed", discoveredFileCount: 1, skippedEntryCount: 1 },
    ]);
  });

  it("returns detailed desktop scan counts while the regular scan remains an array", async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.inbox, "notes.txt"), "notes");
    await mkdir(path.join(workspace.inbox, "nested"));
    await writeFile(path.join(workspace.inbox, "nested", "not-scanned.txt"), "nested");
    const application = OrganizerApplication.createInMemory(configFor(workspace));
    applications.push(application);

    const detailed = await application.scanDetailed();
    const regular = await application.scan();

    assert.deepEqual(detailed.files.map((file) => file.filename), ["notes.txt"]);
    assert.equal(detailed.skippedEntryCount, 1);
    assert.equal(detailed.skipped.directories, 1);
    assert.equal(detailed.skipped.nestedEntriesNotEnumerated, 1);
    assert.equal(Array.isArray(regular), true);
    assert.deepEqual(regular.map((file) => file.filename), ["notes.txt"]);
  });
});
