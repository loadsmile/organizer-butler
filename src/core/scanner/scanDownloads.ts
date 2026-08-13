import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { OrganizerError } from "../../domain/error.js";
import type { ResolvedFile, ScannedFile } from "../../domain/file.js";
import { assertPathInside } from "../security/paths.js";
import { inferMimeType } from "./mimeTypes.js";

const ignoredSuffixes = [".crdownload", ".part", ".download", ".tmp"];

type FileRecord = ScannedFile & {
  path: string;
  modifiedAtMs: number;
};

export class FileIdentityError extends OrganizerError {
  constructor(
    code: "INVALID_FILE_ID" | "FILE_NOT_FOUND" | "FILE_CHANGED" | "UNSAFE_PATH",
    message: string,
  ) {
    super(code, message);
  }
}

export class FileRegistry {
  readonly #files = new Map<string, FileRecord>();

  constructor(readonly inboxRoot: string) {}

  async scan(): Promise<ScannedFile[]> {
    const entries = await readdir(this.inboxRoot, { withFileTypes: true });
    const files: ScannedFile[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || shouldIgnore(entry.name)) {
        continue;
      }

      const filePath = path.join(this.inboxRoot, entry.name);
      assertPathInside(this.inboxRoot, filePath);
      const stats = await lstat(filePath);

      if (!stats.isFile() || stats.isSymbolicLink()) {
        continue;
      }

      const file: ScannedFile = {
        fileId: `file_${randomUUID()}`,
        filename: entry.name,
        extension: path.extname(entry.name).toLowerCase(),
        mimeType: inferMimeType(entry.name),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };

      this.#files.set(file.fileId, { ...file, path: filePath, modifiedAtMs: stats.mtimeMs });
      files.push(file);
    }

    return files.sort((left, right) => left.filename.localeCompare(right.filename));
  }

  async resolve(fileId: string): Promise<ResolvedFile> {
    const record = this.#files.get(fileId);
    if (!record) {
      throw new FileIdentityError("INVALID_FILE_ID", "The file ID was not produced by this server process.");
    }

    try {
      assertPathInside(this.inboxRoot, record.path);
    } catch {
      throw new FileIdentityError("UNSAFE_PATH", "The recorded file path is outside the inbox.");
    }

    let stats;
    try {
      stats = await lstat(record.path);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new FileIdentityError("FILE_NOT_FOUND", "The scanned file no longer exists.");
      }
      throw error;
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new FileIdentityError("FILE_CHANGED", "The scanned path is no longer a regular file.");
    }

    if (stats.size !== record.size || stats.mtimeMs !== record.modifiedAtMs) {
      throw new FileIdentityError("FILE_CHANGED", "The file changed after it was scanned.");
    }

    const { modifiedAtMs: _modifiedAtMs, ...resolved } = record;
    return resolved;
  }
}

function shouldIgnore(filename: string): boolean {
  const lowerName = filename.toLowerCase();
  return filename.startsWith(".") || ignoredSuffixes.some((suffix) => lowerName.endsWith(suffix));
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
