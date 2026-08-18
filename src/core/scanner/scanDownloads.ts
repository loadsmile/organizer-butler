import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { OrganizerError } from "../../domain/error.js";
import type { ResolvedFile, ScannedFile } from "../../domain/file.js";
import { assertPathInside } from "../security/paths.js";
import { inferMimeType } from "./mimeTypes.js";

const ignoredSuffixes = [".crdownload", ".part", ".download", ".tmp"];

type FileRecord = ScannedFile & {
  path: string;
  modifiedAtMs: number;
  device: number;
  inode: number;
};

export type ScanSkippedEntryCounts = {
  hiddenFiles: number;
  temporaryDownloads: number;
  symbolicLinks: number;
  directories: number;
  applicationBundles: number;
  nonRegularEntries: number;
  disappearedEntries: number;
  unreadableEntries: number;
  nestedEntriesNotEnumerated: number;
};

export type DetailedScanResult = {
  files: ScannedFile[];
  skippedEntryCount: number;
  skipped: ScanSkippedEntryCounts;
};

type FileRegistryOperations = {
  readdir(directoryPath: string): Promise<Dirent[]>;
  lstat(entryPath: string): Promise<Stats>;
  realpath(directoryPath: string): Promise<string>;
};

const defaultOperations: FileRegistryOperations = {
  async readdir(directoryPath) {
    return readdir(directoryPath, { withFileTypes: true });
  },
  lstat,
  realpath,
};

export type ResolvedFileIdentity = ResolvedFile & {
  device: number;
  inode: number;
  modifiedAtMs: number;
  inboxRoot: string;
  inboxRootDevice: number;
  inboxRootInode: number;
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
  #canonicalInboxRoot: string | undefined;
  #inboxRootDevice: number | undefined;
  #inboxRootInode: number | undefined;

  constructor(
    readonly inboxRoot: string,
    private readonly operations: FileRegistryOperations = defaultOperations,
  ) {}

  async scan(): Promise<ScannedFile[]> {
    return (await this.scanDetailed()).files;
  }

  async scanDetailed(): Promise<DetailedScanResult> {
    const canonicalInboxRoot = await this.resolveCanonicalInboxRoot();
    const entries = await this.operations.readdir(canonicalInboxRoot);
    const files: ScannedFile[] = [];
    const skipped = emptySkippedEntryCounts();
    let skippedEntryCount = 0;

    for (const entry of entries) {
      const skippedKind = classifyDirectoryEntry(entry);
      if (skippedKind) {
        skipped[skippedKind] += 1;
        skippedEntryCount += 1;
        if (entry.isDirectory()) skipped.nestedEntriesNotEnumerated += 1;
        continue;
      }

      const filePath = path.join(canonicalInboxRoot, entry.name);
      assertPathInside(canonicalInboxRoot, filePath);
      let stats: Stats;
      try {
        stats = await this.operations.lstat(filePath);
      } catch (error) {
        skipped[isMissingFileError(error) ? "disappearedEntries" : "unreadableEntries"] += 1;
        skippedEntryCount += 1;
        continue;
      }

      const changedKind = classifyStats(entry.name, stats);
      if (changedKind) {
        skipped[changedKind] += 1;
        skippedEntryCount += 1;
        if (stats.isDirectory()) skipped.nestedEntriesNotEnumerated += 1;
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

      this.#files.set(file.fileId, {
        ...file,
        path: filePath,
        modifiedAtMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino,
      });
      files.push(file);
    }

    return {
      files: files.sort((left, right) => left.filename.localeCompare(right.filename)),
      skippedEntryCount,
      skipped,
    };
  }

  async resolve(fileId: string): Promise<ResolvedFile> {
    const {
      device: _device,
      inode: _inode,
      modifiedAtMs: _modifiedAtMs,
      inboxRoot: _inboxRoot,
      inboxRootDevice: _inboxRootDevice,
      inboxRootInode: _inboxRootInode,
      ...resolved
    } = await this.resolveIdentity(fileId);
    return resolved;
  }

  async resolveIdentity(fileId: string): Promise<ResolvedFileIdentity> {
    const record = this.#files.get(fileId);
    if (!record) {
      throw new FileIdentityError("INVALID_FILE_ID", "The file ID was not produced by this server process.");
    }

    const canonicalInboxRoot = await this.resolveCanonicalInboxRoot();
    try {
      assertPathInside(canonicalInboxRoot, record.path);
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

    if (
      stats.dev !== record.device ||
      stats.ino !== record.inode ||
      stats.size !== record.size ||
      stats.mtimeMs !== record.modifiedAtMs
    ) {
      throw new FileIdentityError("FILE_CHANGED", "The file changed after it was scanned.");
    }

    return {
      ...record,
      inboxRoot: canonicalInboxRoot,
      inboxRootDevice: this.#inboxRootDevice!,
      inboxRootInode: this.#inboxRootInode!,
    };
  }

  private async resolveCanonicalInboxRoot(): Promise<string> {
    try {
      const canonical = await this.operations.realpath(this.inboxRoot);
      const stats = await this.operations.lstat(canonical);
      if (
        !stats.isDirectory() ||
        (this.#canonicalInboxRoot !== undefined &&
          (canonical !== this.#canonicalInboxRoot ||
            stats.dev !== this.#inboxRootDevice ||
            stats.ino !== this.#inboxRootInode))
      ) {
        throw new Error();
      }
      this.#canonicalInboxRoot = canonical;
      this.#inboxRootDevice = stats.dev;
      this.#inboxRootInode = stats.ino;
      return canonical;
    } catch {
      throw new FileIdentityError("UNSAFE_PATH", "The inbox directory could not be validated.");
    }
  }
}

function classifyDirectoryEntry(entry: Dirent): keyof ScanSkippedEntryCounts | undefined {
  if (entry.isSymbolicLink()) return "symbolicLinks";
  if (entry.isDirectory()) return isApplicationBundle(entry.name) ? "applicationBundles" : "directories";
  if (!entry.isFile()) return "nonRegularEntries";
  return classifyIgnoredName(entry.name);
}

function classifyStats(filename: string, stats: Stats): keyof ScanSkippedEntryCounts | undefined {
  if (stats.isSymbolicLink()) return "symbolicLinks";
  if (stats.isDirectory()) return isApplicationBundle(filename) ? "applicationBundles" : "directories";
  if (!stats.isFile()) return "nonRegularEntries";
  return undefined;
}

function classifyIgnoredName(filename: string): "hiddenFiles" | "temporaryDownloads" | undefined {
  const lowerName = filename.toLowerCase();
  if (filename.startsWith(".")) return "hiddenFiles";
  if (ignoredSuffixes.some((suffix) => lowerName.endsWith(suffix))) return "temporaryDownloads";
  return undefined;
}

function isApplicationBundle(filename: string): boolean {
  return filename.toLowerCase().endsWith(".app");
}

function emptySkippedEntryCounts(): ScanSkippedEntryCounts {
  return {
    hiddenFiles: 0,
    temporaryDownloads: 0,
    symbolicLinks: 0,
    directories: 0,
    applicationBundles: 0,
    nonRegularEntries: 0,
    disappearedEntries: 0,
    unreadableEntries: 0,
    nestedEntriesNotEnumerated: 0,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
