import assert from "node:assert/strict";
import { lstat, link, mkdtemp, mkdir, readdir, realpath, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

  it("reports detailed non-recursive skip counts without exposing paths", async () => {
    const inbox = await createInbox();
    const outside = await createInbox();
    await Promise.all([
      writeFile(path.join(inbox, "visible.txt"), "ok"),
      writeFile(path.join(inbox, ".hidden.txt"), "hidden"),
      writeFile(path.join(inbox, "pending.download"), "pending"),
      writeFile(path.join(outside, "target.txt"), "target"),
      mkdir(path.join(inbox, "nested")),
      mkdir(path.join(inbox, "Example.app")),
    ]);
    await Promise.all([
      writeFile(path.join(inbox, "nested", "not-enumerated.txt"), "nested"),
      writeFile(path.join(inbox, "Example.app", "not-enumerated.txt"), "bundle"),
      symlink(path.join(outside, "target.txt"), path.join(inbox, "linked.txt")),
    ]);

    const result = await new FileRegistry(inbox).scanDetailed();

    assert.deepEqual(result.files.map((file) => file.filename), ["visible.txt"]);
    assert.equal(JSON.stringify(result).includes(inbox), false);
    assert.deepEqual(result, {
      files: result.files,
      skippedEntryCount: 5,
      skipped: {
        hiddenFiles: 1,
        temporaryDownloads: 1,
        symbolicLinks: 1,
        directories: 1,
        applicationBundles: 1,
        nonRegularEntries: 0,
        disappearedEntries: 0,
        unreadableEntries: 0,
        nestedEntriesNotEnumerated: 2,
      },
    });
  });

  it("reports entries that disappear or cannot be read during metadata lookup", async () => {
    const inbox = await createInbox();
    await Promise.all([
      writeFile(path.join(inbox, "disappeared.txt"), "gone"),
      writeFile(path.join(inbox, "unreadable.txt"), "blocked"),
    ]);
    const registry = new FileRegistry(inbox, {
      async readdir(directoryPath) {
        return readdir(directoryPath, { withFileTypes: true });
      },
      realpath,
      async lstat(entryPath) {
        if (path.basename(entryPath) === "disappeared.txt") {
          throw Object.assign(new Error("private missing path"), { code: "ENOENT" });
        }
        if (path.basename(entryPath) === "unreadable.txt") {
          throw Object.assign(new Error("private permission detail"), { code: "EACCES" });
        }
        return lstat(entryPath);
      },
    });

    const result = await registry.scanDetailed();

    assert.deepEqual(result.files, []);
    assert.equal(result.skippedEntryCount, 2);
    assert.equal(result.skipped.disappearedEntries, 1);
    assert.equal(result.skipped.unreadableEntries, 1);
    assert.equal(JSON.stringify(result).includes("private"), false);
  });

  it("reports Unix domain sockets as non-regular entries", { skip: process.platform === "win32" }, async () => {
    const inbox = await createInbox();
    const socketPath = path.join(inbox, "service.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const result = await new FileRegistry(inbox).scanDetailed();
      assert.equal(result.skippedEntryCount, 1);
      assert.equal(result.skipped.nonRegularEntries, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
    assert.equal(resolved.path, path.join(await realpath(inbox), "document.txt"));

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

  it("rejects a replacement even when size and modification time are preserved", async () => {
    const inbox = await createInbox();
    const filePath = path.join(inbox, "document.txt");
    await writeFile(filePath, "original");
    const originalStats = await stat(filePath);
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();

    await unlink(filePath);
    await writeFile(filePath, "replaced");
    await utimes(filePath, originalStats.atime, originalStats.mtime);

    await assert.rejects(
      registry.resolve(file!.fileId),
      (error: unknown) => error instanceof FileIdentityError && error.code === "FILE_CHANGED",
    );
  });

  it("rejects an inbox root replaced by a symlink even when the same inode is reachable", async () => {
    const base = await createInbox();
    const inbox = path.join(base, "inbox");
    const outside = path.join(base, "outside");
    await mkdir(inbox);
    await mkdir(outside);
    const sourcePath = path.join(inbox, "document.txt");
    await writeFile(sourcePath, "content");
    const registry = new FileRegistry(inbox);
    const [file] = await registry.scan();
    await link(sourcePath, path.join(outside, "document.txt"));
    await rm(inbox, { recursive: true });
    await symlink(outside, inbox);

    await assert.rejects(
      registry.resolve(file!.fileId),
      (error: unknown) => error instanceof FileIdentityError && error.code === "UNSAFE_PATH",
    );
  });
});
