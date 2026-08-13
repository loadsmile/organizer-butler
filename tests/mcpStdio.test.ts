import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/config.js";
import { validateSubmittedClassification } from "../src/core/classification/validateSubmittedClassification.js";
import { inspectFile } from "../src/core/inspector/inspectFile.js";
import { SqliteExecutionStore } from "../src/core/planning/executionStore.js";
import { OrganizationPlanRegistry, SimulatedExecutionCrash } from "../src/core/planning/previewOrganizationPlan.js";
import { FileRegistry } from "../src/core/scanner/scanDownloads.js";

describe("Organizer MCP stdio server", () => {
  it("submits and previews without OPENAI_API_KEY or any outbound request", async () => {
    const inbox = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-mcp-stdio-"));
    await writeFile(path.join(inbox, "notes.txt"), "bounded notes");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        path.resolve("tests/fixtures/denyOutboundRequests.js"),
        "--import",
        "tsx",
        "src/mcp/index.ts",
      ],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
        ORGANIZER_ROOT: inbox,
      },
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "organizer-butler-stdio-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const scan = await client.callTool({ name: "scan_files", arguments: {} });
      assert.ok("structuredContent" in scan && scan.structuredContent);
      const fileId = (scan.structuredContent as { files: { fileId: string }[] }).files[0]!.fileId;
      const preview = await client.callTool({
        name: "submit_classification_and_preview_file",
        arguments: {
          fileId,
          classification: {
            area: "personal",
            documentType: "document",
            rationale: "Host classification from the inspected notes.",
          },
        },
      });
      const serialized = JSON.stringify({ scan, preview });

      assert.equal(preview.isError, undefined);
      assert.equal((preview.structuredContent as { ok: boolean }).ok, true);
      assert.equal(serialized.includes(inbox), false);
      assert.equal(stderr.includes(inbox), false);
      assert.equal(stderr.includes("Outbound request attempted"), false);
    } finally {
      await client.close();
      await rm(inbox, { recursive: true, force: true });
    }
  });

  it("recovers every persisted execution phase before accepting requests", async () => {
    for (const phase of ["prepared", "destination-created", "source-removed"] as const) {
      const base = await mkdtemp(path.join(os.tmpdir(), `organizer-butler-mcp-recovery-${phase}-`));
      const inbox = path.join(base, "inbox");
      const organizationRoot = path.join(base, "organized");
      const databasePath = path.join(base, "actions.db");
      const sourcePath = path.join(inbox, `${phase}.txt`);
      const destinationDirectory = path.join(organizationRoot, "Work", "Documents");
      const destinationPath = path.join(destinationDirectory, `${phase}.txt`);
      await mkdir(inbox);
      await mkdir(destinationDirectory, { recursive: true });
      await writeFile(sourcePath, phase);
      const config = loadConfig({
        ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
        ORGANIZER_ROOT: organizationRoot,
        ORGANIZER_DATABASE_PATH: databasePath,
      });
      const registry = new FileRegistry(inbox);
      const file = (await registry.scan())[0]!;
      const classification = validateSubmittedClassification(
        await inspectFile(registry, file.fileId, config),
        { area: "work", documentType: "document", rationale: "Work document." },
      );
      const store = new SqliteExecutionStore(databasePath);
      const plans = new OrganizationPlanRegistry({
        executionStore: store,
        executionFaults: {
          beforeDestinationCreated() {
            if (phase === "prepared") throw new SimulatedExecutionCrash();
          },
          afterDestinationCreated() {
            if (phase === "destination-created") throw new SimulatedExecutionCrash();
          },
          afterSourceRemoved() {
            if (phase === "source-removed") throw new SimulatedExecutionCrash();
          },
        },
      });
      const preview = await plans.preview(registry, classification, config);
      const confirmation = await plans.confirm(preview.planId);
      await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
      if (phase !== "prepared") store.setPhase(confirmation.confirmationId, phase);
      store.close();

      const { client, transport, stderr } = await connectStdio({
        ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
        ORGANIZER_ROOT: organizationRoot,
        ORGANIZER_DATABASE_PATH: databasePath,
      });
      try {
        const execution = await client.callTool({
          name: "execute_organization_plan",
          arguments: { confirmationId: confirmation.confirmationId },
        });
        if (phase === "prepared") {
          assert.equal((execution.structuredContent as { error: { code: string } }).error.code, "CONFIRMATION_INVALIDATED");
          assert.equal(await readFile(sourcePath, "utf8"), phase);
          await assert.rejects(lstat(destinationPath), { code: "ENOENT" });
        } else {
          assert.equal((execution.structuredContent as { execution: { status: string } }).execution.status, "completed");
          await assert.rejects(lstat(sourcePath), { code: "ENOENT" });
          assert.equal(await readFile(destinationPath, "utf8"), phase);
        }
        assert.equal(stderr().includes(base), false);
      } finally {
        await client.close();
        await transport.close();
        await rm(base, { recursive: true, force: true });
      }
    }
  });

  it("keeps scan available and sanitizes mutation failures for a corrupt database", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-mcp-corrupt-db-"));
    const inbox = path.join(base, "inbox");
    const databasePath = path.join(base, "secret-diagnostic.db");
    await mkdir(inbox);
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    await writeFile(databasePath, "not a sqlite database");
    const { client, transport, stderr } = await connectStdio({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: inbox,
      ORGANIZER_DATABASE_PATH: databasePath,
    });
    try {
      const scan = await client.callTool({ name: "scan_files", arguments: {} });
      const execution = await client.callTool({
        name: "execute_organization_plan",
        arguments: { confirmationId: "confirm_fabricated" },
      });
      assert.equal((scan.structuredContent as { ok: boolean }).ok, true);
      assert.deepEqual(execution.structuredContent, {
        ok: false,
        error: {
          code: "EXECUTION_STORAGE_FAILED",
          message: "The organization operation state could not be stored safely.",
        },
      });
      assert.equal(JSON.stringify({ scan, execution }).includes(base), false);
      assert.equal(stderr().includes(base), false);
    } finally {
      await client.close();
      await transport.close();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("waits for a spawned database lock before accepting requests", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-mcp-lock-"));
    const inbox = path.join(base, "inbox");
    const databasePath = path.join(base, "actions.db");
    await mkdir(inbox);
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    new SqliteExecutionStore(databasePath).close();
    const lockOwner = spawn(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/holdDatabaseLock.ts", databasePath, "400"],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const lockExit = once(lockOwner, "exit");
    await waitForOutput(lockOwner.stdout, "locked\n");
    const startedAt = Date.now();
    const { client, transport } = await connectStdio({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: inbox,
      ORGANIZER_DATABASE_PATH: databasePath,
    });
    try {
      assert.ok(Date.now() - startedAt >= 200);
      assert.equal((await client.callTool({ name: "scan_files", arguments: {} }).then((result) => result.structuredContent) as { ok: boolean }).ok, true);
      assert.equal((await lockExit)[0], 0);
    } finally {
      await client.close();
      await transport.close();
      lockOwner.kill();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("takes over a killed recovery owner's lease before accepting requests", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-mcp-lease-"));
    const inbox = path.join(base, "inbox");
    const organizationRoot = path.join(base, "organized");
    const databasePath = path.join(base, "actions.db");
    const destinationDirectory = path.join(organizationRoot, "Work", "Documents");
    await mkdir(inbox);
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    const config = loadConfig({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: organizationRoot,
      ORGANIZER_DATABASE_PATH: databasePath,
    });
    const registry = new FileRegistry(inbox);
    const file = (await registry.scan())[0]!;
    const classification = validateSubmittedClassification(
      await inspectFile(registry, file.fileId, config),
      { area: "work", documentType: "document", rationale: "Work document." },
    );
    const store = new SqliteExecutionStore(databasePath);
    const plans = new OrganizationPlanRegistry({
      executionStore: store,
      executionFaults: { beforeDestinationCreated() { throw new SimulatedExecutionCrash(); } },
    });
    const confirmation = await plans.confirm((await plans.preview(registry, classification, config)).planId);
    await assert.rejects(plans.execute(confirmation.confirmationId), SimulatedExecutionCrash);
    store.close();

    const leaseOwner = spawn(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/claimRecoveryLease.ts", databasePath, confirmation.confirmationId, "400"],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const leaseExit = once(leaseOwner, "exit");
    await waitForOutput(leaseOwner.stdout, "claimed\n");
    leaseOwner.kill("SIGKILL");
    await leaseExit;
    const startedAt = Date.now();
    const { client, transport, stderr } = await connectStdio({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: organizationRoot,
      ORGANIZER_DATABASE_PATH: databasePath,
      ORGANIZER_EXECUTION_RECOVERY_LEASE_MS: "400",
    });
    try {
      assert.ok(Date.now() - startedAt >= 200);
      const execution = await client.callTool({
        name: "execute_organization_plan",
        arguments: { confirmationId: confirmation.confirmationId },
      });
      assert.equal((execution.structuredContent as { error: { code: string } }).error.code, "CONFIRMATION_INVALIDATED");
      assert.equal(stderr().includes(base), false);
    } finally {
      await client.close();
      await transport.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});

async function waitForOutput(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  let output = "";
  for await (const chunk of stream) {
    output += String(chunk);
    if (output.includes(expected)) return;
  }
  throw new Error("Child process exited before producing expected output.");
}

async function connectStdio(environment: Record<string, string>): Promise<{
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/index.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: environment,
  });
  let capturedStderr = "";
  transport.stderr?.on("data", (chunk) => {
    capturedStderr += String(chunk);
  });
  const client = new Client({ name: "organizer-butler-stdio-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, stderr: () => capturedStderr };
}
