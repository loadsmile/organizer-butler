import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { validateSubmittedClassification } from "../src/core/classification/validateSubmittedClassification.js";
import {
  DirectoryPlanRegistry,
  SimulatedDirectoryExecutionCrash,
} from "../src/core/planning/directoryPlanning.js";
import { SqliteExecutionStore } from "../src/core/planning/executionStore.js";
import { OrganizationPlanRegistry } from "../src/core/planning/previewOrganizationPlan.js";
import { FileRegistry } from "../src/core/scanner/scanDownloads.js";
import { OrganizerError } from "../src/domain/error.js";
import type { FileInspection } from "../src/domain/inspection.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "organizer-directories-"));
  temporaryDirectories.push(base);
  const inbox = path.join(base, "inbox");
  const organizationRoot = path.join(base, "organized");
  await mkdir(inbox);
  await mkdir(organizationRoot);
  await writeFile(path.join(inbox, "invoice.txt"), "safe content");
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  assert.ok(file);
  const inspection: FileInspection = {
    file,
    extraction: { status: "extracted", format: "text", excerpt: "safe content", extractedTextLength: 12, truncated: false },
    ruleEvidence: [],
  };
  const proposal = validateSubmittedClassification(inspection, {
    area: "finance",
    documentType: "invoice",
    rationale: "Test.",
  });
  const plans = new OrganizationPlanRegistry();
  const movePlan = await plans.preview(registry, proposal, {
    organizationRoot,
    maxPlanPathBytes: 4_096,
    planExpiryMs: 60_000,
    confirmationExpiryMs: 60_000,
  });
  return { base, inbox, organizationRoot, file, plans, movePlan };
}

const config = { directoryPlanExpiryMs: 60_000, directoryConfirmationExpiryMs: 60_000 };
const organizerError = (code: OrganizerError["code"]) =>
  (error: unknown) => error instanceof OrganizerError && error.code === code;

describe("controlled directory planning", () => {
  it("previews missing controlled segments without mutation and consumes the move plan", async () => {
    const setup = await fixture();
    const directories = new DirectoryPlanRegistry();
    const preview = await directories.preview(setup.plans, setup.movePlan.planId, config);

    assert.deepEqual(preview.directories, [
      { name: "Finance", status: "missing" },
      { name: "Invoices", status: "missing" },
    ]);
    assert.deepEqual(await readdir(setup.organizationRoot), []);
    assert.equal(JSON.stringify(preview).includes(setup.base), false);
    await assert.rejects(setup.plans.confirm(setup.movePlan.planId), organizerError("PLAN_ALREADY_USED"));
  });

  it("creates each missing segment separately, replays safely, and never moves the file", async () => {
    const setup = await fixture();
    const created: string[] = [];
    const directories = new DirectoryPlanRegistry({
      directoryOperations: {
        async mkdir(directoryPath) { created.push(path.basename(directoryPath)); await mkdir(directoryPath); },
        rmdir,
      },
    });
    const preview = await directories.preview(setup.plans, setup.movePlan.planId, config);
    const confirmation = await directories.confirm(preview.directoryPlanId);
    const result = await directories.execute(confirmation.directoryConfirmationId);

    assert.deepEqual(created, ["Finance", "Invoices"]);
    assert.equal((await lstat(path.join(setup.organizationRoot, "Finance", "Invoices"))).isDirectory(), true);
    assert.equal(await readFile(path.join(setup.inbox, setup.file.filename), "utf8"), "safe content");
    assert.deepEqual(await directories.execute(confirmation.directoryConfirmationId), result);
    assert.equal(JSON.stringify(result).includes(setup.base), false);
  });

  it("rejects races without removing the competing entry", async () => {
    const setup = await fixture();
    const directories = new DirectoryPlanRegistry({
      directoryOperations: {
        async mkdir(directoryPath) {
          await writeFile(directoryPath, "race");
          throw Object.assign(new Error(), { code: "EEXIST" });
        },
        rmdir,
      },
    });
    const preview = await directories.preview(setup.plans, setup.movePlan.planId, config);
    const confirmation = await directories.confirm(preview.directoryPlanId);
    await assert.rejects(directories.execute(confirmation.directoryConfirmationId), organizerError("DIRECTORY_EXECUTION_CONFLICT"));
    assert.equal(await readFile(path.join(setup.organizationRoot, "Finance"), "utf8"), "race");
  });

  it("recovers a crash after durable segment evidence and completes when all directories exist", async () => {
    const setup = await fixture();
    const databasePath = path.join(setup.base, "actions.db");
    const store = new SqliteExecutionStore(databasePath);
    const directories = new DirectoryPlanRegistry({
      executionStore: store,
      executionFaults: { afterDirectoriesCreated() { throw new SimulatedDirectoryExecutionCrash(); } },
    });
    const preview = await directories.preview(setup.plans, setup.movePlan.planId, config);
    const confirmation = await directories.confirm(preview.directoryPlanId);
    await assert.rejects(directories.execute(confirmation.directoryConfirmationId), SimulatedDirectoryExecutionCrash);
    store.close();

    const recoveredStore = new SqliteExecutionStore(databasePath);
    const recovered = new DirectoryPlanRegistry({ executionStore: recoveredStore });
    await recovered.recover();
    assert.equal((await recovered.execute(confirmation.directoryConfirmationId)).status, "completed");
    recoveredStore.close();
  });

  it("rolls back only identity-proven empty directories after interrupted creation", async () => {
    const setup = await fixture();
    const databasePath = path.join(setup.base, "rollback.db");
    const store = new SqliteExecutionStore(databasePath);
    const directories = new DirectoryPlanRegistry({
      executionStore: store,
      executionFaults: {
        beforeSegmentCreate(ordinal) { if (ordinal === 1) throw new SimulatedDirectoryExecutionCrash(); },
      },
    });
    const preview = await directories.preview(setup.plans, setup.movePlan.planId, config);
    const confirmation = await directories.confirm(preview.directoryPlanId);
    await assert.rejects(directories.execute(confirmation.directoryConfirmationId), SimulatedDirectoryExecutionCrash);
    store.close();

    const recoveredStore = new SqliteExecutionStore(databasePath);
    const recovered = new DirectoryPlanRegistry({ executionStore: recoveredStore });
    await recovered.recover();
    await assert.rejects(lstat(path.join(setup.organizationRoot, "Finance")), { code: "ENOENT" });
    await assert.rejects(recovered.execute(confirmation.directoryConfirmationId), organizerError("DIRECTORY_CONFIRMATION_INVALIDATED"));
    recoveredStore.close();
  });
});
