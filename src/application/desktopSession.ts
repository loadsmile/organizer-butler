import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  DesktopFolderKind,
  DesktopFolderValidation,
  PrivilegedDesktopFolderSelection,
} from "./contracts.js";

export type ValidatedDesktopDirectory = {
  canonicalPath: string;
  displayPath: string;
  device: number;
  inode: number;
  validation: DesktopFolderValidation;
};

export function folderSelectionFromNativeDialog(
  kind: DesktopFolderKind,
  directoryPath: string,
): PrivilegedDesktopFolderSelection {
  return Object.freeze({ source: "native-dialog", kind, directoryPath });
}

export async function validateDesktopDirectory(
  selection: PrivilegedDesktopFolderSelection,
): Promise<{ directory?: ValidatedDesktopDirectory; validation: DesktopFolderValidation }> {
  const displayPath = path.resolve(selection.directoryPath);
  let canonicalPath: string;
  let stats;
  try {
    canonicalPath = await realpath(displayPath);
    stats = await lstat(canonicalPath);
  } catch {
    return { validation: invalidValidation(displayPath, "unavailable") };
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { validation: invalidValidation(displayPath, "not-directory") };
  }

  const readable = await canAccess(canonicalPath, constants.R_OK);
  const writable = await canAccess(canonicalPath, constants.W_OK);
  const permitted = readable && writable;
  const validation: DesktopFolderValidation = {
    displayPath,
    status: permitted ? "valid" : "permission-denied",
    readable,
    writable,
  };
  if (!permitted) return { validation };

  return {
    directory: {
      canonicalPath,
      displayPath,
      device: Number(stats.dev),
      inode: Number(stats.ino),
      validation,
    },
    validation,
  };
}

export async function isDesktopDirectoryIdentityCurrent(
  directory: ValidatedDesktopDirectory,
): Promise<boolean> {
  try {
    const stats = await lstat(directory.canonicalPath);
    return stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      Number(stats.dev) === directory.device &&
      Number(stats.ino) === directory.inode &&
      await canAccess(directory.canonicalPath, constants.R_OK) &&
      await canAccess(directory.canonicalPath, constants.W_OK);
  } catch {
    return false;
  }
}

async function canAccess(directoryPath: string, mode: number): Promise<boolean> {
  try {
    await access(directoryPath, mode);
    return true;
  } catch {
    return false;
  }
}

function invalidValidation(
  displayPath: string,
  status: "unavailable" | "not-directory",
): DesktopFolderValidation {
  return { displayPath, status, readable: false, writable: false };
}
