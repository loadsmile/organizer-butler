import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { validateSubmittedClassification } from "../src/core/classification/validateSubmittedClassification.js";
import { areaDirectories, documentTypeDirectories } from "../src/core/planning/destinationMappings.js";
import {
  OrganizationPlanRegistry,
  SimulatedExecutionCrash,
  type OrganizationPlanningConfig,
} from "../src/core/planning/previewOrganizationPlan.js";
import {
  InMemoryExecutionStore,
  SqliteExecutionStore,
  type DurableExecutionRecord,
} from "../src/core/planning/executionStore.js";
import { FileRegistry } from "../src/core/scanner/scanDownloads.js";
import { areas } from "../src/core/taxonomy/areas.js";
import { documentTypes } from "../src/core/taxonomy/documentTypes.js";
import type { ClassificationProposalResult } from "../src/domain/classification.js";
import { OrganizerError } from "../src/domain/error.js";
import type { FileInspection } from "../src/domain/inspection.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(filename = "report.txt") {
  const base = await mkdtemp(path.join(os.tmpdir(), "organizer-plan-"));
  temporaryDirectories.push(base);
  const inbox = path.join(base, "inbox");
  const organizationRoot = path.join(base, "organized");
  await mkdir(inbox);
  await mkdir(organizationRoot);
  await writeFile(path.join(inbox, filename), "safe content");
  const registry = new FileRegistry(inbox);
  const [file] = await registry.scan();
  assert.ok(file);
  return { base, inbox, organizationRoot, registry, file };
}

async function classification(
  registry: FileRegistry,
  fileId: string,
  area: (typeof areas)[number] = "work",
  documentType: (typeof documentTypes)[number] = "document",
): Promise<ClassificationProposalResult> {
  const file = await registry.resolve(fileId);
  const inspection: FileInspection = {
    file: {
      fileId: file.fileId,
      filename: file.filename,
      extension: file.extension,
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
    },
    extraction: {
      status: "extracted",
      format: "text",
      excerpt: "safe content",
      extractedTextLength: 12,
      truncated: false,
    },
    ruleEvidence: [],
  };
  return validateSubmittedClassification(inspection, {
    area,
    documentType,
    rationale: "Test proposal.",
  });
}

function planningConfig(organizationRoot: string, maxPlanPathBytes = 4_096): OrganizationPlanningConfig {
  return { organizationRoot, maxPlanPathBytes, planExpiryMs: 600_000, confirmationExpiryMs: 300_000 };
}

function assertOrganizerError(code: OrganizerError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof OrganizerError && error.code === code;
}

describe("organization destination mappings", () => {
  it("defines an explicit safe segment for every controlled taxonomy value", () => {
    assert.deepEqual(Object.keys(areaDirectories), [...areas]);
    assert.deepEqual(Object.keys(documentTypeDirectories), [...documentTypes]);
    for (const segment of [...Object.values(areaDirectories), ...Object.values(documentTypeDirectories)]) {
      assert.doesNotMatch(segment, /[\\/]/u);
      assert.notEqual(segment, ".");
      assert.notEqual(segment, "..");
    }
  });
});

describe("previewOrganizationPlan", () => {
  it("returns deterministic safe destination data and fresh opaque plan IDs without mutating", async () => {
    const { organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId, "finance", "invoice");
    const plans = new OrganizationPlanRegistry();
    const before = await readdir(organizationRoot);

    const first = await plans.preview(registry, proposal, planningConfig(organizationRoot));
    const second = await plans.preview(registry, proposal, planningConfig(organizationRoot));

    assert.deepEqual(first.destination, {
      area: "finance",
      documentType: "invoice",
      areaDirectory: "Finance",
      documentTypeDirectory: "Invoices",
      filename: "report.txt",
    });
    assert.equal(first.conflict, "none");
    assert.match(first.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(first.planId, /^plan_/u);
    assert.notEqual(first.planId, second.planId);
    assert.deepEqual(first.destination, second.destination);
    assert.deepEqual(await readdir(organizationRoot), before);
    assert.equal(JSON.stringify(first).includes(organizationRoot), false);
    assert.equal(JSON.stringify(first).includes(path.dirname(organizationRoot)), false);
  });

  it("maps unknown classifications only to controlled review segments", async () => {
    const { organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId, "unknown", "unknown");
    const result = await new OrganizationPlanRegistry().preview(registry, proposal, planningConfig(organizationRoot));
    assert.equal(result.destination.areaDirectory, "_Review");
    assert.equal(result.destination.documentTypeDirectory, "_Review");
  });

  it("reports existing file, directory, and other-node conflicts without changing them", async () => {
    for (const [kind, create] of [
      ["existing-file", (target: string) => writeFile(target, "existing")],
      ["existing-directory", (target: string) => mkdir(target)],
      ["existing-other", (target: string) => symlink("missing-target", target)],
    ] as const) {
      const { organizationRoot, registry, file } = await fixture();
      const destinationDirectory = path.join(organizationRoot, "Work", "Documents");
      await mkdir(destinationDirectory, { recursive: true });
      await create(path.join(destinationDirectory, file.filename));
      const proposal = await classification(registry, file.fileId);
      const result = await new OrganizationPlanRegistry().preview(registry, proposal, planningConfig(organizationRoot));
      assert.equal(result.conflict, kind);
    }
  });

  it("rejects a destination that is a hard link to the source", async () => {
    const { inbox, organizationRoot, registry, file } = await fixture();
    const destinationDirectory = path.join(organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    await link(path.join(inbox, file.filename), path.join(destinationDirectory, file.filename));
    const proposal = await classification(registry, file.fileId);
    await assert.rejects(
      new OrganizationPlanRegistry().preview(registry, proposal, planningConfig(organizationRoot)),
      assertOrganizerError("PLAN_UNSAFE_DESTINATION"),
    );
  });

  it("rejects stale files and invalid or fabricated classification values", async () => {
    const { inbox, organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId);
    await writeFile(path.join(inbox, file.filename), "changed content");
    await assert.rejects(
      new OrganizationPlanRegistry().preview(registry, proposal, planningConfig(organizationRoot)),
      assertOrganizerError("FILE_CHANGED"),
    );

    const invalid = {
      ...proposal,
      proposal: { area: "invented", documentType: "document", rationale: "Invalid." },
    } as unknown as ClassificationProposalResult;
    await assert.rejects(
      new OrganizationPlanRegistry().preview(registry, invalid, planningConfig(organizationRoot)),
      assertOrganizerError("PLAN_INVALID_CLASSIFICATION"),
    );

    const replayed = structuredClone(proposal) as ClassificationProposalResult;
    await assert.rejects(
      new OrganizationPlanRegistry().preview(registry, replayed, planningConfig(organizationRoot)),
      assertOrganizerError("PLAN_INVALID_CLASSIFICATION"),
    );
  });

  it("rejects unsafe and reserved source filenames", async () => {
    for (const filename of ["CON.txt", "trailing.", "control\u0001.txt"]) {
      const { organizationRoot, registry, file } = await fixture(filename);
      const proposal = await classification(registry, file.fileId);
      await assert.rejects(
        new OrganizationPlanRegistry().preview(registry, proposal, planningConfig(organizationRoot)),
        assertOrganizerError("PLAN_UNSAFE_FILENAME"),
      );
    }
  });

  it("rejects excessive destination paths, missing roots, and symlinked destination ancestors", async () => {
    const { base, organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId);
    const plans = new OrganizationPlanRegistry();
    await assert.rejects(
      plans.preview(registry, proposal, planningConfig(organizationRoot, 1)),
      assertOrganizerError("PLAN_DESTINATION_TOO_LONG"),
    );
    await assert.rejects(
      plans.preview(registry, proposal, planningConfig(path.join(base, "missing"))),
      assertOrganizerError("PLAN_VALIDATION_FAILED"),
    );

    await symlink(base, path.join(organizationRoot, "Work"));
    await assert.rejects(
      plans.preview(registry, proposal, planningConfig(organizationRoot)),
      assertOrganizerError("PLAN_UNSAFE_DESTINATION"),
    );
  });
});

describe("organization plan confirmation", () => {
  it("consumes a plan once and issues a bounded confirmation without mutating files", async () => {
    const { inbox, organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId);
    let now = Date.parse("2026-08-13T12:00:00.000Z");
    let nextId = 0;
    const plans = new OrganizationPlanRegistry({ now: () => now, createId: () => `id-${++nextId}` });
    const preview = await plans.preview(registry, proposal, {
      ...planningConfig(organizationRoot),
      planExpiryMs: 1_000,
      confirmationExpiryMs: 500,
    });
    const beforeInbox = await readdir(inbox);
    const beforeRoot = await readdir(organizationRoot);

    now += 100;
    const confirmation = await plans.confirm(preview.planId);

    assert.deepEqual(confirmation, {
      confirmationId: "confirm_id-2",
      planId: "plan_id-1",
      fileId: file.fileId,
      expiresAt: "2026-08-13T12:00:00.600Z",
    });
    assert.equal(preview.expiresAt, "2026-08-13T12:00:01.000Z");
    assert.deepEqual(await readdir(inbox), beforeInbox);
    assert.deepEqual(await readdir(organizationRoot), beforeRoot);
    await assert.rejects(plans.confirm(preview.planId), assertOrganizerError("PLAN_ALREADY_USED"));
    assert.equal(JSON.stringify({ preview, confirmation }).includes(organizationRoot), false);
  });

  it("rejects fabricated, cross-registry, and expired plan capabilities", async () => {
    const { organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId);
    let now = 100;
    const first = new OrganizationPlanRegistry({ now: () => now });
    const second = new OrganizationPlanRegistry({ now: () => now });
    const preview = await first.preview(registry, proposal, {
      ...planningConfig(organizationRoot),
      planExpiryMs: 10,
    });

    await assert.rejects(first.confirm("plan_fabricated"), assertOrganizerError("INVALID_PLAN_ID"));
    await assert.rejects(second.confirm(preview.planId), assertOrganizerError("INVALID_PLAN_ID"));
    now = 110;
    await assert.rejects(first.confirm(preview.planId), assertOrganizerError("PLAN_EXPIRED"));
    await assert.rejects(first.confirm(preview.planId), assertOrganizerError("PLAN_ALREADY_USED"));
  });

  it("allows only one concurrent confirmation", async () => {
    const { organizationRoot, registry, file } = await fixture();
    const proposal = await classification(registry, file.fileId);
    const plans = new OrganizationPlanRegistry();
    const preview = await plans.preview(registry, proposal, planningConfig(organizationRoot));

    const results = await Promise.allSettled([plans.confirm(preview.planId), plans.confirm(preview.planId)]);

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal(rejected.reason instanceof OrganizerError && rejected.reason.code, "PLAN_ALREADY_USED");
  });

  it("invalidates plans when source or destination state changes", async () => {
    for (const change of ["source", "destination"] as const) {
      const { inbox, organizationRoot, registry, file } = await fixture();
      const proposal = await classification(registry, file.fileId);
      const plans = new OrganizationPlanRegistry();
      const preview = await plans.preview(registry, proposal, planningConfig(organizationRoot));
      if (change === "source") {
        await writeFile(path.join(inbox, file.filename), "changed source content");
      } else {
        const destinationDirectory = path.join(organizationRoot, "Work", "Documents");
        await mkdir(destinationDirectory, { recursive: true });
        await writeFile(path.join(destinationDirectory, file.filename), "new conflict");
      }

      await assert.rejects(
        plans.confirm(preview.planId),
        assertOrganizerError(change === "source" ? "PLAN_CHANGED" : "PLAN_CONFLICT"),
      );
      await assert.rejects(plans.confirm(preview.planId), assertOrganizerError("PLAN_ALREADY_USED"));
    }
  });

  it("refuses to confirm a conflict reported by the preview", async () => {
    const { organizationRoot, registry, file } = await fixture();
    const destinationDirectory = path.join(organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(path.join(destinationDirectory, file.filename), "existing");
    const proposal = await classification(registry, file.fileId);
    const plans = new OrganizationPlanRegistry();
    const preview = await plans.preview(registry, proposal, planningConfig(organizationRoot));

    assert.equal(preview.conflict, "existing-file");
    await assert.rejects(plans.confirm(preview.planId), assertOrganizerError("PLAN_CONFLICT"));
  });
});

describe("organization confirmation execution", () => {
  async function confirmedFixture(options: ConstructorParameters<typeof OrganizationPlanRegistry>[0] = {}) {
    const setup = await fixture();
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry(options);
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);
    return { ...setup, plans, preview, confirmation };
  }

  it("moves only to a pre-existing controlled directory and returns a path-free result", async () => {
    const setup = await fixture();
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry();
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    const result = await plans.execute(confirmation.confirmationId);
    const destinationPath = path.join(destinationDirectory, setup.file.filename);

    assert.deepEqual(result, {
      confirmationId: confirmation.confirmationId,
      planId: preview.planId,
      fileId: setup.file.fileId,
      status: "completed",
    });
    assert.equal(await readFile(destinationPath, "utf8"), "safe content");
    await assert.rejects(lstat(path.join(setup.inbox, setup.file.filename)), { code: "ENOENT" });
    assert.equal(JSON.stringify(result).includes(setup.base), false);
    assert.deepEqual(await plans.execute(confirmation.confirmationId), result);
    assert.equal(await readFile(destinationPath, "utf8"), "safe content");
  });

  it("rejects fabricated, cross-registry, and exactly expired confirmations", async () => {
    let now = 100;
    const setup = await fixture();
    const proposal = await classification(setup.registry, setup.file.fileId);
    const first = new OrganizationPlanRegistry({ now: () => now });
    const second = new OrganizationPlanRegistry({ now: () => now });
    const preview = await first.preview(setup.registry, proposal, {
      ...planningConfig(setup.organizationRoot),
      confirmationExpiryMs: 10,
    });
    const confirmation = await first.confirm(preview.planId);

    await assert.rejects(first.execute("confirm_fabricated"), assertOrganizerError("INVALID_CONFIRMATION_ID"));
    await assert.rejects(second.execute(confirmation.confirmationId), assertOrganizerError("INVALID_CONFIRMATION_ID"));
    now = 110;
    await assert.rejects(first.execute(confirmation.confirmationId), assertOrganizerError("CONFIRMATION_EXPIRED"));
    await assert.rejects(first.execute(confirmation.confirmationId), assertOrganizerError("CONFIRMATION_EXPIRED"));
  });

  it("allows only one concurrent execution attempt", async () => {
    let releaseLink: (() => void) | undefined;
    const linkStarted = new Promise<void>((resolve) => {
      releaseLink = resolve;
    });
    let continueLink: (() => void) | undefined;
    const linkCanFinish = new Promise<void>((resolve) => {
      continueLink = resolve;
    });
    const setup = await fixture();
    await mkdir(path.join(setup.organizationRoot, "Work", "Documents"), { recursive: true });
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionOperations: {
        async link(sourcePath, destinationPath) {
          releaseLink?.();
          await linkCanFinish;
          await link(sourcePath, destinationPath);
        },
        unlink,
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    const first = plans.execute(confirmation.confirmationId);
    await linkStarted;
    await assert.rejects(
      plans.execute(confirmation.confirmationId),
      assertOrganizerError("CONFIRMATION_ALREADY_EXECUTING"),
    );
    continueLink?.();
    await first;
  });

  it("waits for an active execution before allowing owned storage shutdown", async () => {
    const setup = await fixture();
    await mkdir(path.join(setup.organizationRoot, "Work", "Documents"), { recursive: true });
    const proposal = await classification(setup.registry, setup.file.fileId);
    let releaseLink!: () => void;
    const linkReleased = new Promise<void>((resolve) => { releaseLink = resolve; });
    let linkStarted!: () => void;
    const linkHasStarted = new Promise<void>((resolve) => { linkStarted = resolve; });
    const plans = new OrganizationPlanRegistry({
      executionOperations: {
        async link(sourcePath, destinationPath) {
          linkStarted();
          await linkReleased;
          await link(sourcePath, destinationPath);
        },
        unlink,
      },
    });
    const confirmation = await plans.confirm((await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot))).planId);
    const execution = plans.execute(confirmation.confirmationId);
    await linkHasStarted;
    let shutdownReady = false;
    const waiting = plans.waitForActiveExecutions().then(() => { shutdownReady = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownReady, false);
    releaseLink();
    await waiting;
    assert.equal((await execution).status, "completed");
  });

  it("terminally rejects missing destination directories, source replacement, conflicts, and ancestor symlinks", async () => {
    for (const change of ["missing-directory", "source", "conflict", "symlink"] as const) {
      const setup = await fixture();
      const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
      await mkdir(destinationDirectory, { recursive: true });
      const proposal = await classification(setup.registry, setup.file.fileId);
      const plans = new OrganizationPlanRegistry();
      const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
      const confirmation = await plans.confirm(preview.planId);
      if (change === "missing-directory") {
        await rm(path.join(setup.organizationRoot, "Work"), { recursive: true });
      } else if (change === "source") {
        const sourcePath = path.join(setup.inbox, setup.file.filename);
        await unlink(sourcePath);
        await writeFile(sourcePath, "replacement");
      } else if (change === "conflict") {
        await writeFile(path.join(destinationDirectory, setup.file.filename), "conflict");
      } else {
        await rm(path.join(setup.organizationRoot, "Work"), { recursive: true });
        await symlink(setup.inbox, path.join(setup.organizationRoot, "Work"));
      }

      const expected =
        change === "missing-directory"
          ? "EXECUTION_DESTINATION_UNAVAILABLE"
          : change === "conflict"
            ? "EXECUTION_CONFLICT"
            : "EXECUTION_CHANGED";
      await assert.rejects(plans.execute(confirmation.confirmationId), assertOrganizerError(expected));
      await assert.rejects(
        plans.execute(confirmation.confirmationId),
        assertOrganizerError("CONFIRMATION_INVALIDATED"),
      );
      if (change === "missing-directory") {
        assert.deepEqual(await readdir(setup.organizationRoot), []);
      }
    }
  });

  it("maps exclusive-link races, cross-filesystem failures, and partial moves to terminal safe errors", async () => {
    for (const [failureCode, expected] of [
      ["EEXIST", "EXECUTION_CONFLICT"],
      ["EXDEV", "EXECUTION_CROSS_FILESYSTEM"],
    ] as const) {
      const setup = await fixture();
      await mkdir(path.join(setup.organizationRoot, "Work", "Documents"), { recursive: true });
      const proposal = await classification(setup.registry, setup.file.fileId);
      const plans = new OrganizationPlanRegistry({
        executionOperations: {
          async link() {
            throw Object.assign(new Error("private diagnostic"), { code: failureCode });
          },
          unlink,
        },
      });
      const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
      const confirmation = await plans.confirm(preview.planId);
      await assert.rejects(plans.execute(confirmation.confirmationId), assertOrganizerError(expected));
    }

    const setup = await fixture();
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionOperations: {
        link,
        async unlink() {
          throw new Error("private diagnostic");
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    await assert.rejects(plans.execute(confirmation.confirmationId), assertOrganizerError("EXECUTION_PARTIAL"));
    assert.equal(await readFile(path.join(setup.inbox, setup.file.filename), "utf8"), "safe content");
    assert.equal(await readFile(path.join(destinationDirectory, setup.file.filename), "utf8"), "safe content");
    await assert.rejects(
      plans.execute(confirmation.confirmationId),
      assertOrganizerError("CONFIRMATION_ALREADY_EXECUTING"),
    );
  });

  it("stops with both entries retained when the source changes after exclusive destination creation", async () => {
    const setup = await fixture();
    const sourcePath = path.join(setup.inbox, setup.file.filename);
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionOperations: {
        async link(currentSourcePath, destinationPath) {
          await link(currentSourcePath, destinationPath);
          await unlink(currentSourcePath);
          await writeFile(currentSourcePath, "replacement");
        },
        unlink,
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    await assert.rejects(plans.execute(confirmation.confirmationId), assertOrganizerError("EXECUTION_PARTIAL"));
    assert.equal(await readFile(sourcePath, "utf8"), "replacement");
    assert.equal(await readFile(path.join(destinationDirectory, setup.file.filename), "utf8"), "safe content");
  });

  it("recovers crashes before destination creation without mutating", async () => {
    const setup = await fixture();
    await mkdir(path.join(setup.organizationRoot, "Work", "Documents"), { recursive: true });
    const databasePath = path.join(setup.base, "operations.db");
    const firstStore = new SqliteExecutionStore(databasePath);
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionStore: firstStore,
      executionFaults: {
        beforeDestinationCreated() {
          throw new SimulatedExecutionCrash();
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
    firstStore.close();
    const recoveredStore = new SqliteExecutionStore(databasePath);
    const recovered = new OrganizationPlanRegistry({ executionStore: recoveredStore });
    await recovered.recover();

    assert.equal(await readFile(path.join(setup.inbox, setup.file.filename), "utf8"), "safe content");
    await assert.rejects(
      lstat(path.join(setup.organizationRoot, "Work", "Documents", setup.file.filename)),
      { code: "ENOENT" },
    );
    await assert.rejects(
      recovered.execute(confirmation.confirmationId),
      assertOrganizerError("CONFIRMATION_INVALIDATED"),
    );
    recoveredStore.close();
  });

  it("recovers crashes after destination creation by safely finishing the move", async () => {
    const setup = await fixture();
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const databasePath = path.join(setup.base, "operations.db");
    const firstStore = new SqliteExecutionStore(databasePath);
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionStore: firstStore,
      executionFaults: {
        afterDestinationCreated() {
          throw new SimulatedExecutionCrash();
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
    assert.equal(await readFile(path.join(setup.inbox, setup.file.filename), "utf8"), "safe content");
    assert.equal(await readFile(path.join(destinationDirectory, setup.file.filename), "utf8"), "safe content");
    firstStore.close();

    const recoveredStore = new SqliteExecutionStore(databasePath);
    const recovered = new OrganizationPlanRegistry({ executionStore: recoveredStore });
    await recovered.recover();
    await assert.rejects(lstat(path.join(setup.inbox, setup.file.filename)), { code: "ENOENT" });
    assert.deepEqual(await recovered.execute(confirmation.confirmationId), {
      confirmationId: confirmation.confirmationId,
      planId: preview.planId,
      fileId: setup.file.fileId,
      status: "completed",
    });
    recoveredStore.close();
  });

  it("recovers crashes after source removal and replays the prior safe success", async () => {
    const setup = await fixture();
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const databasePath = path.join(setup.base, "operations.db");
    const firstStore = new SqliteExecutionStore(databasePath);
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionStore: firstStore,
      executionFaults: {
        afterSourceRemoved() {
          throw new SimulatedExecutionCrash();
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);

    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
    firstStore.close();
    const recoveredStore = new SqliteExecutionStore(databasePath);
    const recovered = new OrganizationPlanRegistry({ executionStore: recoveredStore });
    await recovered.recover();

    await assert.rejects(lstat(path.join(setup.inbox, setup.file.filename)), { code: "ENOENT" });
    assert.equal(await readFile(path.join(destinationDirectory, setup.file.filename), "utf8"), "safe content");
    const replay = await recovered.execute(confirmation.confirmationId);
    assert.equal(JSON.stringify(replay).includes(setup.base), false);
    assert.equal(replay.status, "completed");
    recoveredStore.close();
  });

  it("invalidates recovery rather than touching unrelated destination entries", async () => {
    const setup = await fixture();
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const databasePath = path.join(setup.base, "operations.db");
    const firstStore = new SqliteExecutionStore(databasePath);
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionStore: firstStore,
      executionFaults: {
        beforeDestinationCreated() {
          throw new SimulatedExecutionCrash();
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);
    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
    await writeFile(path.join(destinationDirectory, setup.file.filename), "unrelated");
    firstStore.close();

    const recoveredStore = new SqliteExecutionStore(databasePath);
    const recovered = new OrganizationPlanRegistry({ executionStore: recoveredStore });
    await recovered.recover();
    assert.equal(await readFile(path.join(setup.inbox, setup.file.filename), "utf8"), "safe content");
    assert.equal(await readFile(path.join(destinationDirectory, setup.file.filename), "utf8"), "unrelated");
    await assert.rejects(
      recovered.execute(confirmation.confirmationId),
      assertOrganizerError("CONFIRMATION_INVALIDATED"),
    );
    recoveredStore.close();
  });

  it("recovers a post-link crash in a fresh process without exposing paths", async () => {
    const setup = await fixture();
    const destinationDirectory = path.join(setup.organizationRoot, "Work", "Documents");
    await mkdir(destinationDirectory, { recursive: true });
    const databasePath = path.join(setup.base, "operations.db");
    const firstStore = new SqliteExecutionStore(databasePath);
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionStore: firstStore,
      executionFaults: {
        afterDestinationCreated() {
          throw new SimulatedExecutionCrash();
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);
    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
    firstStore.close();

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/recoverExecution.ts", databasePath],
      { cwd: process.cwd() },
    );
    assert.equal(stdout, "");
    assert.equal(stderr.includes(setup.base), false);
    await assert.rejects(lstat(path.join(setup.inbox, setup.file.filename)), { code: "ENOENT" });
    assert.equal(await readFile(path.join(destinationDirectory, setup.file.filename), "utf8"), "safe content");

    const replayStore = new SqliteExecutionStore(databasePath);
    const replayRegistry = new OrganizationPlanRegistry({ executionStore: replayStore });
    assert.equal((await replayRegistry.execute(confirmation.confirmationId)).status, "completed");
    replayStore.close();
  });

  it("allows only one SQLite process to claim each executing recovery record", async () => {
    const setup = await fixture();
    await mkdir(path.join(setup.organizationRoot, "Work", "Documents"), { recursive: true });
    const databasePath = path.join(setup.base, "operations.db");
    const firstStore = new SqliteExecutionStore(databasePath);
    const proposal = await classification(setup.registry, setup.file.fileId);
    const plans = new OrganizationPlanRegistry({
      executionStore: firstStore,
      executionFaults: {
        beforeDestinationCreated() {
          throw new SimulatedExecutionCrash();
        },
      },
    });
    const preview = await plans.preview(setup.registry, proposal, planningConfig(setup.organizationRoot));
    const confirmation = await plans.confirm(preview.planId);
    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);

    const secondStore = new SqliteExecutionStore(databasePath);
    assert.equal(firstStore.claimRecovery(confirmation.confirmationId, 1_000), true);
    assert.equal(secondStore.claimRecovery(confirmation.confirmationId, 1_000), false);
    assert.equal(secondStore.claimRecovery(confirmation.confirmationId, 31_000), true);
    firstStore.close();
    secondStore.close();
  });

  it("versions new databases, migrates legacy terminal records, and rejects future schemas", async () => {
    const setup = await fixture();
    const databasePath = path.join(setup.base, "versioned.db");
    const fresh = new SqliteExecutionStore(databasePath);
    fresh.close();
    const freshDatabase = new DatabaseSync(databasePath);
    assert.equal((freshDatabase.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    freshDatabase.close();

    const legacyPath = path.join(setup.base, "legacy.db");
    const legacy = new DatabaseSync(legacyPath);
    createLegacySchema(legacy);
    legacy.prepare(`INSERT INTO organization_executions VALUES (
      'confirm_legacy', 'plan_legacy', 'file_legacy', '/source', 1, 2, 3, 4,
      '/inbox', 1, 2, '/root', 1, 2, '/destination', 5, 'completed', 'source-removed', 'none'
    )`).run();
    legacy.close();
    const migrated = new SqliteExecutionStore(legacyPath, { now: () => 1_000 });
    assert.equal(migrated.get("confirm_legacy")?.terminalAt, 1_000);
    migrated.close();

    const futurePath = path.join(setup.base, "future.db");
    const future = new DatabaseSync(futurePath);
    future.exec("PRAGMA user_version = 3");
    future.close();
    assert.throws(() => new SqliteExecutionStore(futurePath), assertOrganizerError("EXECUTION_STORAGE_FAILED"));
  });

  it("cleans terminal records only after their independent authority horizons", () => {
    const store = new InMemoryExecutionStore();
    for (const [id, state, terminalAt] of [
      ["invalidated", "invalidated", 100],
      ["expired", "expired", 200],
      ["completed", "completed", 300],
      ["ready", "ready", null],
      ["executing", "executing", null],
    ] as const) {
      store.create(durableRecord(id, state, terminalAt));
    }
    assert.equal(store.cleanupTerminal(1_100, { invalidatedMs: 1_000, expiredMs: 1_000, completedMs: 1_000 }), 1);
    assert.equal(store.get("confirm_invalidated"), undefined);
    assert.ok(store.get("confirm_expired"));
    assert.ok(store.get("confirm_completed"));
    assert.ok(store.get("confirm_ready"));
    assert.ok(store.get("confirm_executing"));
    assert.equal(store.cleanupTerminal(1_300, { invalidatedMs: 1_000, expiredMs: 1_000, completedMs: 2_000 }), 1);
    assert.equal(store.get("confirm_expired"), undefined);
    assert.ok(store.get("confirm_completed"));
  });

  it("applies terminal retention transactionally in SQLite without deleting active authority", async () => {
    const setup = await fixture();
    const store = new SqliteExecutionStore(path.join(setup.base, "retention.db"));
    for (const [id, state, terminalAt] of [
      ["invalidated", "invalidated", 100],
      ["expired", "expired", 200],
      ["completed", "completed", 300],
      ["ready", "ready", null],
      ["executing", "executing", null],
    ] as const) {
      store.create(durableRecord(id, state, terminalAt));
    }
    assert.equal(store.cleanupTerminal(1_100, { invalidatedMs: 1_000, expiredMs: 1_000, completedMs: 2_000 }), 1);
    assert.equal(store.get("confirm_invalidated"), undefined);
    assert.ok(store.get("confirm_expired"));
    assert.ok(store.get("confirm_completed"));
    assert.ok(store.get("confirm_ready"));
    assert.ok(store.get("confirm_executing"));
    store.close();
  });
});

function durableRecord(id: string, state: DurableExecutionRecord["state"], terminalAt: number | null): DurableExecutionRecord {
  return {
    confirmationId: `confirm_${id}`,
    planId: `plan_${id}`,
    fileId: `file_${id}`,
    sourcePath: "/source",
    sourceDevice: 1,
    sourceInode: 2,
    sourceSize: 3,
    sourceModifiedAtMs: 4,
    inboxRoot: "/inbox",
    inboxRootDevice: 1,
    inboxRootInode: 2,
    organizationRoot: "/root",
    organizationRootDevice: 1,
    organizationRootInode: 2,
    destinationPath: "/destination",
    expiresAt: 10_000,
    state,
    phase: "prepared",
    recoveryOutcome: state === "completed" ? "none" : state === "ready" || state === "executing" ? "none" : "invalidated",
    terminalAt,
  };
}

function createLegacySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE organization_executions (
      confirmation_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, file_id TEXT NOT NULL,
      source_path TEXT NOT NULL, source_device INTEGER NOT NULL, source_inode INTEGER NOT NULL,
      source_size INTEGER NOT NULL, source_modified_at_ms REAL NOT NULL, inbox_root TEXT NOT NULL,
      inbox_root_device INTEGER NOT NULL, inbox_root_inode INTEGER NOT NULL, organization_root TEXT NOT NULL,
      organization_root_device INTEGER NOT NULL, organization_root_inode INTEGER NOT NULL,
      destination_path TEXT NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'executing', 'completed', 'invalidated', 'expired')),
      phase TEXT NOT NULL CHECK (phase IN ('prepared', 'destination-created', 'source-removed')),
      recovery_outcome TEXT NOT NULL CHECK (recovery_outcome IN ('none', 'completed', 'invalidated'))
    ) STRICT;
    CREATE TABLE organization_execution_recovery_claims (
      confirmation_id TEXT PRIMARY KEY REFERENCES organization_executions(confirmation_id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
  `);
}
