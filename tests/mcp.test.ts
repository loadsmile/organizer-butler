import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config/config.js";
import {
  createOrganizerMcpServer,
  initializeOrganizerMcpServer,
  type OrganizerMcpServerOptions,
} from "../src/mcp/server.js";
import type { FileRegistry } from "../src/core/scanner/scanDownloads.js";
import { OrganizerError } from "../src/domain/error.js";

const temporaryDirectories: string[] = [];
const connections: { client: Client; closeServer: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, closeServer }) => {
    await client.close();
    await closeServer();
  }));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInbox(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function connect(inbox: string, options: OrganizerMcpServerOptions = {}): Promise<Client> {
  return (await connectServer(inbox, options)).client;
}

async function connectServer(
  inbox: string,
  options: OrganizerMcpServerOptions = {},
): Promise<{ client: Client; registry: FileRegistry }> {
  const { server, registry } = createOrganizerMcpServer(
    loadConfig({ ORGANIZER_DOWNLOADS_DIRECTORY: inbox, ORGANIZER_ROOT: inbox }),
    options,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "organizer-butler-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, closeServer: () => server.close() });
  return { client, registry };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok("structuredContent" in result);
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
}

function submission(
  fileId: string,
  area = "finance",
  documentType = "invoice",
  rationale = "Host classification based on the fresh inspection.",
) {
  return { fileId, classification: { area, documentType, rationale } };
}

describe("Organizer MCP server", () => {
  it("lists local preview, confirmation, and execution tools with distinct annotations", async () => {
    const client = await connect(await createInbox());

    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name), [
      "scan_files",
      "inspect_file",
      "submit_classification_and_preview_file",
      "preview_organization_directories",
      "confirm_organization_directories",
      "execute_organization_directories",
      "confirm_organization_plan",
      "execute_organization_plan",
    ]);
    assert.equal(tools[0]!.inputSchema.type, "object");
    assert.deepEqual(tools[0]!.inputSchema.properties, {});
    assert.equal(tools[0]!.inputSchema.additionalProperties, false);
    assert.deepEqual(tools[1]!.inputSchema.required, ["fileId"]);
    assert.equal(tools[1]!.inputSchema.properties?.fileId !== undefined, true);
    for (const tool of tools.slice(0, 2)) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
    }
    for (const tool of tools.slice(2, 3)) {
      assert.deepEqual(tool.inputSchema.required, ["fileId", "classification"]);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.idempotentHint, false);
    }
    assert.deepEqual(tools[3]!.inputSchema.required, ["planId"]);
    assert.equal(tools[3]!.annotations?.readOnlyHint, true);
    assert.equal(tools[3]!.annotations?.idempotentHint, false);
    assert.deepEqual(tools[4]!.inputSchema.required, ["directoryPlanId"]);
    assert.equal(tools[4]!.annotations?.destructiveHint, false);
    assert.deepEqual(tools[5]!.inputSchema.required, ["directoryConfirmationId"]);
    assert.equal(tools[5]!.annotations?.destructiveHint, false);
    assert.deepEqual(tools[6]!.inputSchema.required, ["planId"]);
    assert.equal(tools[6]!.annotations?.destructiveHint, false);
    assert.deepEqual(tools[7]!.inputSchema.required, ["confirmationId"]);
    assert.equal(tools[7]!.annotations?.destructiveHint, true);
  });

  it("keeps scanned IDs usable across separate calls on one server", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "invoice.txt"), "bounded content");
    const client = await connect(inbox);

    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const files = scan.files as { fileId: string }[];
    const inspection = structured(
      await client.callTool({ name: "inspect_file", arguments: { fileId: files[0]!.fileId } }),
    );

    assert.equal(scan.ok, true);
    assert.equal(inspection.ok, true);
    assert.equal((inspection.inspection as { file: { filename: string } }).file.filename, "invoice.txt");
    assert.equal(JSON.stringify({ scan, inspection }).includes(inbox), false);
    assert.equal(JSON.stringify({ scan, inspection }).includes('"path"'), false);
  });

  it("rejects an ID issued by a different server registry", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    const firstClient = await connect(inbox);
    const secondClient = await connect(inbox);
    const scan = structured(await firstClient.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;

    const result = await secondClient.callTool({ name: "inspect_file", arguments: { fileId } });

    assert.equal(result.isError, true);
    assert.deepEqual(structured(result), {
      ok: false,
      error: { code: "INVALID_FILE_ID", message: "The file ID was not produced by this server process." },
    });
  });

  it("returns a structured error for fabricated IDs", async () => {
    const client = await connect(await createInbox());

    const result = await client.callTool({ name: "inspect_file", arguments: { fileId: "file_fabricated" } });

    assert.equal(result.isError, true);
    assert.equal((structured(result).error as { code: string }).code, "INVALID_FILE_ID");
  });

  it("returns a structured error for stale IDs without exposing paths", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "notes.txt");
    await writeFile(filePath, "before");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    await writeFile(filePath, "after and larger");

    const result = await client.callTool({ name: "inspect_file", arguments: { fileId } });

    assert.equal(result.isError, true);
    assert.equal((structured(result).error as { code: string }).code, "FILE_CHANGED");
    assert.equal(JSON.stringify(result).includes(inbox), false);
  });

  it("rejects missing, extra, and raw-path inspection inputs", async () => {
    const inbox = await createInbox();
    const client = await connect(inbox);

    for (const arguments_ of [{}, { fileId: "file_fabricated", extra: true }, { path: inbox }]) {
      const result = await client.callTool({ name: "inspect_file", arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.equal("structuredContent" in result, false);
      assert.equal(JSON.stringify(result).includes(inbox), false);
    }
  });

  it("returns unsupported-format evidence without paths", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "travel-receipt.bin"), "opaque");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;

    const result = structured(await client.callTool({ name: "inspect_file", arguments: { fileId } }));
    const inspection = result.inspection as {
      extraction: unknown;
      ruleEvidence: { ruleId: string }[];
    };

    assert.deepEqual(inspection.extraction, { status: "unsupported", reason: "UNSUPPORTED_FORMAT" });
    assert.deepEqual(inspection.ruleEvidence.map((evidence) => evidence.ruleId), ["filename.receipt"]);
    assert.equal(JSON.stringify(result).includes(inbox), false);
    assert.equal(JSON.stringify(result).includes('"path"'), false);
  });

  it("validates a host classification and previews through one capability flow without mutating", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "invoice.txt"), "Invoice content");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const before = await readdir(inbox);

    const result = structured(
      await client.callTool({ name: "submit_classification_and_preview_file", arguments: submission(fileId) }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.plan, {
      planId: (result.plan as { planId: string }).planId,
      fileId,
      expiresAt: (result.plan as { expiresAt: string }).expiresAt,
      destination: {
        area: "finance",
        documentType: "invoice",
        areaDirectory: "Finance",
        documentTypeDirectory: "Invoices",
        filename: "invoice.txt",
      },
      conflict: "none",
    });
    assert.match((result.plan as { planId: string }).planId, /^plan_/u);
    assert.match((result.plan as { expiresAt: string }).expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(await readdir(inbox), before);
    assert.equal(JSON.stringify(result).includes(inbox), false);
    assert.equal(JSON.stringify(result).includes("rationale"), false);
    assert.equal(JSON.stringify(result).includes("ruleEvidence"), false);
  });

  it("previews, confirms, and creates controlled directories without moving the file", async () => {
    const base = await createInbox();
    const inbox = path.join(base, "inbox");
    const organizationRoot = path.join(base, "organized");
    await mkdir(inbox);
    await mkdir(organizationRoot);
    const sourcePath = path.join(inbox, "invoice.txt");
    await writeFile(sourcePath, "Invoice content");
    const organizer = createOrganizerMcpServer(loadConfig({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: organizationRoot,
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const directoryClient = new Client({ name: "directory-test", version: "0.1.0" });
    await organizer.server.connect(serverTransport);
    await directoryClient.connect(clientTransport);
    connections.push({ client: directoryClient, closeServer: () => organizer.server.close() });

    const scan = structured(await directoryClient.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const movePlan = structured(await directoryClient.callTool({
      name: "submit_classification_and_preview_file", arguments: submission(fileId),
    })).plan as { planId: string };
    const preview = structured(await directoryClient.callTool({
      name: "preview_organization_directories", arguments: { planId: movePlan.planId },
    }));
    const directoryPlan = preview.directoryPlan as { directoryPlanId: string; directories: unknown[] };
    assert.deepEqual(directoryPlan.directories, [
      { name: "Finance", status: "missing" },
      { name: "Invoices", status: "missing" },
    ]);
    const confirmation = structured(await directoryClient.callTool({
      name: "confirm_organization_directories",
      arguments: { directoryPlanId: directoryPlan.directoryPlanId },
    })).confirmation as { directoryConfirmationId: string };
    const execution = structured(await directoryClient.callTool({
      name: "execute_organization_directories",
      arguments: { directoryConfirmationId: confirmation.directoryConfirmationId },
    }));

    assert.equal((execution.execution as { status: string }).status, "completed");
    assert.equal((await lstat(path.join(organizationRoot, "Finance", "Invoices"))).isDirectory(), true);
    assert.equal(await readFile(sourcePath, "utf8"), "Invoice content");
    assert.equal(JSON.stringify({ preview, execution }).includes(base), false);
    const consumedMove = structured(await directoryClient.callTool({
      name: "confirm_organization_plan", arguments: { planId: movePlan.planId },
    }));
    assert.equal((consumedMove.error as { code: string }).code, "PLAN_ALREADY_USED");
  });

  it("confirms one same-instance plan without filesystem mutation", async () => {
    const inbox = await createInbox();
    const sourcePath = path.join(inbox, "invoice.txt");
    await writeFile(sourcePath, "Invoice content");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const preview = structured(
      await client.callTool({ name: "submit_classification_and_preview_file", arguments: submission(fileId) }),
    ).plan as { planId: string };
    const before = await readdir(inbox);

    const result = structured(
      await client.callTool({ name: "confirm_organization_plan", arguments: { planId: preview.planId } }),
    );
    const confirmation = result.confirmation as Record<string, string>;

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(confirmation), ["confirmationId", "planId", "fileId", "expiresAt"]);
    assert.match(confirmation.confirmationId!, /^confirm_/u);
    assert.equal(confirmation.planId, preview.planId);
    assert.equal(confirmation.fileId, fileId);
    assert.match(confirmation.expiresAt!, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(await readFile(sourcePath, "utf8"), "Invoice content");
    assert.deepEqual(await readdir(inbox), before);
    assert.equal(JSON.stringify(result).includes(inbox), false);

    const repeated = await client.callTool({
      name: "confirm_organization_plan",
      arguments: { planId: preview.planId },
    });
    assert.equal((structured(repeated).error as { code: string }).code, "PLAN_ALREADY_USED");
  });

  it("rejects fabricated, cross-instance, expired, and changed confirmation plans", async () => {
    const inbox = await createInbox();
    const sourcePath = path.join(inbox, "notes.txt");
    await writeFile(sourcePath, "notes");
    let now = 1_000;
    const firstClient = await connect(inbox, {
      planRegistryOptions: { now: () => now },
    });
    const secondClient = await connect(inbox);
    const scan = structured(await firstClient.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const firstPlan = structured(
      await firstClient.callTool({
        name: "submit_classification_and_preview_file",
        arguments: submission(fileId, "personal", "document"),
      }),
    ).plan as { planId: string };

    for (const [client, planId] of [
      [secondClient, firstPlan.planId],
      [firstClient, "plan_fabricated"],
    ] as const) {
      const result = await client.callTool({ name: "confirm_organization_plan", arguments: { planId } });
      assert.equal((structured(result).error as { code: string }).code, "INVALID_PLAN_ID");
    }

    await writeFile(sourcePath, "changed and larger");
    const changed = await firstClient.callTool({
      name: "confirm_organization_plan",
      arguments: { planId: firstPlan.planId },
    });
    assert.equal((structured(changed).error as { code: string }).code, "PLAN_CHANGED");

    await writeFile(sourcePath, "fresh");
    const freshScan = structured(await firstClient.callTool({ name: "scan_files", arguments: {} }));
    const freshId = (freshScan.files as { fileId: string }[])[0]!.fileId;
    const expiringPlan = structured(
      await firstClient.callTool({
        name: "submit_classification_and_preview_file",
        arguments: submission(freshId, "personal", "document"),
      }),
    ).plan as { planId: string };
    now += 600_000;
    const expired = await firstClient.callTool({
      name: "confirm_organization_plan",
      arguments: { planId: expiringPlan.planId },
    });
    assert.equal((structured(expired).error as { code: string }).code, "PLAN_EXPIRED");
    assert.equal(JSON.stringify({ changed, expired }).includes(inbox), false);
  });

  it("rejects caller-supplied confirmation context and raw paths", async () => {
    const inbox = await createInbox();
    const client = await connect(inbox);
    for (const arguments_ of [
      {},
      { path: inbox },
      { planId: "plan_fabricated", confirmed: true },
      { planId: "plan_fabricated", destination: inbox },
      { planId: "plan_fabricated", plan: {} },
      { planId: "plan_fabricated", fileId: "file_fabricated" },
    ]) {
      const result = await client.callTool({ name: "confirm_organization_plan", arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.equal("structuredContent" in result, false);
      assert.equal(JSON.stringify(result).includes(inbox), false);
    }
  });

  it("executes one explicitly confirmed plan and durably replays its path-free result", async () => {
    const inbox = await createInbox();
    const organizationRoot = await createInbox();
    const sourcePath = path.join(inbox, "invoice.txt");
    const destinationDirectory = path.join(organizationRoot, "Finance", "Invoices");
    await writeFile(sourcePath, "Invoice content");
    await mkdir(destinationDirectory, { recursive: true });
    const { server } = createOrganizerMcpServer(
      loadConfig({ ORGANIZER_DOWNLOADS_DIRECTORY: inbox, ORGANIZER_ROOT: organizationRoot }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "organizer-butler-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, closeServer: () => server.close() });
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const preview = structured(
      await client.callTool({ name: "submit_classification_and_preview_file", arguments: submission(fileId) }),
    ).plan as { planId: string };
    const confirmation = structured(
      await client.callTool({ name: "confirm_organization_plan", arguments: { planId: preview.planId } }),
    ).confirmation as { confirmationId: string };

    const first = structured(
      await client.callTool({
        name: "execute_organization_plan",
        arguments: { confirmationId: confirmation.confirmationId },
      }),
    );
    const replay = structured(
      await client.callTool({
        name: "execute_organization_plan",
        arguments: { confirmationId: confirmation.confirmationId },
      }),
    );

    assert.deepEqual(first, replay);
    assert.deepEqual(first.execution, {
      confirmationId: confirmation.confirmationId,
      planId: preview.planId,
      fileId,
      status: "completed",
    });
    await assert.rejects(lstat(sourcePath), { code: "ENOENT" });
    assert.equal(await readFile(path.join(destinationDirectory, "invoice.txt"), "utf8"), "Invoice content");
    assert.equal(JSON.stringify(first).includes(inbox), false);
    assert.equal(JSON.stringify(first).includes(organizationRoot), false);
  });

  it("rejects unconfirmed, fabricated, strict-extra, and unavailable-destination execution", async () => {
    const inbox = await createInbox();
    const organizationRoot = await createInbox();
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    const { server } = createOrganizerMcpServer(
      loadConfig({ ORGANIZER_DOWNLOADS_DIRECTORY: inbox, ORGANIZER_ROOT: organizationRoot }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "organizer-butler-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, closeServer: () => server.close() });

    for (const arguments_ of [
      {},
      { confirmationId: "confirm_fabricated", path: inbox },
      { confirmationId: "confirm_fabricated", overwrite: true },
    ]) {
      const result = await client.callTool({ name: "execute_organization_plan", arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.equal("structuredContent" in result, false);
    }
    const fabricated = await client.callTool({
      name: "execute_organization_plan",
      arguments: { confirmationId: "confirm_fabricated" },
    });
    assert.equal((structured(fabricated).error as { code: string }).code, "INVALID_CONFIRMATION_ID");

    const fileId = ((structured(await client.callTool({ name: "scan_files", arguments: {} })).files as { fileId: string }[])[0]!).fileId;
    const planId = (structured(
      await client.callTool({
        name: "submit_classification_and_preview_file",
        arguments: submission(fileId, "personal", "document"),
      }),
    ).plan as { planId: string }).planId;
    const confirmationId = (structured(
      await client.callTool({ name: "confirm_organization_plan", arguments: { planId } }),
    ).confirmation as { confirmationId: string }).confirmationId;
    const unavailable = await client.callTool({
      name: "execute_organization_plan",
      arguments: { confirmationId },
    });
    assert.equal((structured(unavailable).error as { code: string }).code, "EXECUTION_DESTINATION_UNAVAILABLE");
    assert.equal(await readFile(path.join(inbox, "notes.txt"), "utf8"), "notes");
  });

  it("keeps local read operations available when durable startup is unavailable", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    const config = loadConfig({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: inbox,
      ORGANIZER_DATABASE_PATH: path.join(inbox, "database-directory"),
    });
    await mkdir(config.databasePath);
    const { server } = await initializeOrganizerMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "organizer-butler-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, closeServer: () => server.close() });

    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    assert.equal(scan.ok, true);
    for (const [name, arguments_] of [
      ["confirm_organization_plan", { planId: "plan_fabricated" }],
      ["execute_organization_plan", { confirmationId: "confirm_fabricated" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.deepEqual(structured(result), {
        ok: false,
        error: {
          code: "EXECUTION_STORAGE_FAILED",
          message: "The organization operation state could not be stored safely.",
        },
      });
      assert.equal(JSON.stringify(result).includes(inbox), false);
    }
  });

  it("closes startup-owned durable storage through an idempotent shutdown", async () => {
    const inbox = await createInbox();
    const config = loadConfig({
      ORGANIZER_DOWNLOADS_DIRECTORY: inbox,
      ORGANIZER_ROOT: inbox,
      ORGANIZER_DATABASE_PATH: path.join(inbox, "shutdown.db"),
    });
    const organizer = await initializeOrganizerMcpServer(config);
    await organizer.shutdown();
    await organizer.shutdown();
    await assert.rejects(
      organizer.planRegistry.execute("confirm_fabricated"),
      (error: unknown) => error instanceof OrganizerError && error.code === "EXECUTION_STORAGE_FAILED",
    );
  });

  it("reports preview conflicts without changing the destination", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "invoice.txt"), "Invoice content");
    const destinationDirectory = path.join(inbox, "Finance", "Invoices");
    await mkdir(destinationDirectory, { recursive: true });
    const destination = path.join(destinationDirectory, "invoice.txt");
    await writeFile(destination, "existing destination");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;

    const result = structured(
      await client.callTool({ name: "submit_classification_and_preview_file", arguments: submission(fileId) }),
    );

    assert.equal((result.plan as { conflict: string }).conflict, "existing-file");
    assert.equal(await readFile(destination, "utf8"), "existing destination");
  });

  it("preserves same-instance authority and rejects cross-instance and fabricated IDs for preview", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "notes.txt");
    await writeFile(filePath, "notes");
    const firstClient = await connect(inbox);
    const secondClient = await connect(inbox);
    const scan = structured(await firstClient.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;

    assert.equal(
      structured(await firstClient.callTool({
        name: "submit_classification_and_preview_file",
        arguments: submission(fileId, "personal", "document"),
      })).ok,
      true,
    );
    for (const [client, candidate] of [
      [secondClient, fileId],
      [firstClient, "file_fabricated"],
    ] as const) {
      const result = await client.callTool({
        name: "submit_classification_and_preview_file",
        arguments: submission(candidate, "personal", "document"),
      });
      assert.equal((structured(result).error as { code: string }).code, "INVALID_FILE_ID");
    }

    await writeFile(filePath, "changed and larger");
    const stale = await firstClient.callTool({
      name: "submit_classification_and_preview_file",
      arguments: submission(fileId, "personal", "document"),
    });
    assert.equal((structured(stale).error as { code: string }).code, "FILE_CHANGED");
    assert.equal(JSON.stringify(stale).includes(inbox), false);
  });

  it("returns a safe error when a file changes during submitted-classification inspection", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "notes.txt");
    await writeFile(filePath, "before");
    const { client, registry } = await connectServer(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const resolve = registry.resolve.bind(registry);
    let resolutions = 0;
    registry.resolve = async (candidate) => {
      resolutions += 1;
      if (resolutions === 2) {
        await writeFile(filePath, "changed during inspection");
      }
      return resolve(candidate);
    };

    const result = await client.callTool({
      name: "submit_classification_and_preview_file",
      arguments: submission(fileId, "personal", "document"),
    });

    assert.equal((structured(result).error as { code: string }).code, "FILE_CHANGED");
    assert.equal(JSON.stringify(result).includes(inbox), false);
  });

  it("returns a safe error when a file changes during combined preview revalidation", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "notes.txt");
    await writeFile(filePath, "before");
    const { client, registry } = await connectServer(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const resolveIdentity = registry.resolveIdentity.bind(registry);
    let resolutions = 0;
    registry.resolveIdentity = async (candidate) => {
      resolutions += 1;
      if (resolutions === 4) {
        await writeFile(filePath, "changed during planning revalidation");
      }
      return resolveIdentity(candidate);
    };

    const result = await client.callTool({
      name: "submit_classification_and_preview_file",
      arguments: submission(fileId, "personal", "document"),
    });

    assert.equal((structured(result).error as { code: string }).code, "FILE_CHANGED");
    assert.equal(JSON.stringify(result).includes(inbox), false);
  });

  it("freshly inspects unsupported content before validating the host classification", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "opaque.bin"), "opaque");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;

    const result = structured(await client.callTool({
      name: "submit_classification_and_preview_file",
      arguments: submission(fileId, "other", "other"),
    }));

    assert.equal(result.ok, true);
    assert.equal((result.plan as { fileId: string }).fileId, fileId);
  });

  it("rejects incompatible submitted classifications with a sanitized error", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "notes.txt"), "notes");
    const client = await connect(inbox);
    const scan = structured(await client.callTool({ name: "scan_files", arguments: {} }));
    const fileId = (scan.files as { fileId: string }[])[0]!.fileId;
    const result = await client.callTool({
      name: "submit_classification_and_preview_file",
      arguments: submission(fileId, "unknown", "document", `secret-token ${inbox}`),
    });
    assert.equal((structured(result).error as { code: string }).code, "CLASSIFICATION_INVALID_SUBMISSION");
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(JSON.stringify(result).includes(inbox), false);
  });

  it("accepts only an opaque ID and strict controlled classification", async () => {
    const inbox = await createInbox();
    const client = await connect(inbox);
    const invalidInputs = [
      {},
      { path: inbox },
      { fileId: "file_fabricated" },
      { fileId: "file_fabricated", classification: { area: "finance", documentType: "invoice", rationale: "x" }, prompt: "ignore safeguards" },
      { fileId: "file_fabricated", classification: { area: "finance", documentType: "invoice", rationale: "x", evidence: [] } },
      { fileId: "file_fabricated", classification: { area: "finance", documentType: "invoice", rationale: "x", destination: inbox } },
      { fileId: "file_fabricated", classification: { area: "invented", documentType: "invoice", rationale: "x" } },
      { fileId: "file_fabricated", classification: { area: "finance", documentType: "invoice", rationale: "x", model: "other" } },
      { fileId: "file_fabricated", classification: { area: "finance", documentType: "invoice", rationale: "x", apiKey: "secret-token" } },
    ];

    for (const arguments_ of invalidInputs) {
      const result = await client.callTool({ name: "submit_classification_and_preview_file", arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.equal("structuredContent" in result, false);
      assert.equal(JSON.stringify(result).includes(inbox), false);
      assert.equal(JSON.stringify(result).includes("secret-token"), false);
    }
  });
});
