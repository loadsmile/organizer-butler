import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { FileIdentityError, FileRegistry } from "../src/core/scanner/scanDownloads.js";
import { OrganizerError } from "../src/domain/error.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInbox(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "organizer-butler-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("FileRegistry", () => {
  it("scans regular files without exposing paths", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "invoice.pdf"), "invoice");

    const files = await new FileRegistry(inbox).scan();

    assert.equal(files.length, 1);
    assert.match(files[0]!.fileId, /^file_[0-9a-f-]+$/);
    assert.deepEqual(
      {
        filename: files[0]!.filename,
        extension: files[0]!.extension,
        mimeType: files[0]!.mimeType,
        size: files[0]!.size,
      },
      { filename: "invoice.pdf", extension: ".pdf", mimeType: "application/pdf", size: 7 },
    );
    assert.equal("path" in files[0]!, false);
  });

  it("ignores temporary files, hidden files, directories, and nested files", async () => {
    const inbox = await createInbox();
    await Promise.all([
      writeFile(path.join(inbox, "visible.txt"), "ok"),
      writeFile(path.join(inbox, ".hidden.txt"), "hidden"),
      writeFile(path.join(inbox, "pending.CRDOWNLOAD"), "pending"),
      writeFile(path.join(inbox, "partial.part"), "partial"),
    ]);
    await mkdir(path.join(inbox, "nested"));
    await writeFile(path.join(inbox, "nested", "not-scanned.txt"), "nested");

    const files = await new FileRegistry(inbox).scan();

    assert.deepEqual(files.map((file) => file.filename), ["visible.txt"]);
  });

  it("rejects symlinks even when they target a regular file", async () => {
    const inbox = await createInbox();
    const outside = await createInbox();
    await writeFile(path.join(outside, "private.txt"), "private");
    await symlink(path.join(outside, "private.txt"), path.join(inbox, "linked.txt"));

    const files = await new FileRegistry(inbox).scan();

    assert.deepEqual(files, []);
  });

  it("resolves only IDs issued by the same registry", async () => {
    const inbox = await createInbox();
    await writeFile(path.join(inbox, "document.txt"), "content");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    const resolved = await registry.resolve(file!.fileId);
    assert.equal(resolved.path, path.join(inbox, "document.txt"));

    await assert.rejects(
      registry.resolve("file_fabricated"),
      (error: unknown) =>
        error instanceof OrganizerError &&
        error instanceof FileIdentityError &&
        error.code === "INVALID_FILE_ID",
    );
  });

  it("fails safely when a scanned file becomes stale", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "document.txt");
    await writeFile(filePath, "content");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await unlink(filePath);

    await assert.rejects(
      registry.resolve(file!.fileId),
      (error: unknown) => error instanceof FileIdentityError && error.code === "FILE_NOT_FOUND",
    );
  });
});
