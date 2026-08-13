import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config/config.js";
import { createOrganizerMcpServer } from "../src/mcp/server.js";

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

async function connect(inbox: string): Promise<Client> {
  const { server } = createOrganizerMcpServer(loadConfig({ ORGANIZER_DOWNLOADS_DIRECTORY: inbox }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "organizer-butler-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, closeServer: () => server.close() });
  return client;
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok("structuredContent" in result);
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
}

describe("Organizer MCP server", () => {
  it("lists only the two read-only tools with narrow schemas", async () => {
    const client = await connect(await createInbox());

    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name), ["scan_files", "inspect_file"]);
    assert.equal(tools[0]!.inputSchema.type, "object");
    assert.deepEqual(tools[0]!.inputSchema.properties, {});
    assert.equal(tools[0]!.inputSchema.additionalProperties, false);
    assert.deepEqual(tools[1]!.inputSchema.required, ["fileId"]);
    assert.equal(tools[1]!.inputSchema.properties?.fileId !== undefined, true);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
    }
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
});
