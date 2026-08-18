import type { ScannedFile } from "../domain/file.js";
import type { ScanSkippedEntryCounts } from "../core/scanner/scanDownloads.js";

export type OrganizerApplicationState =
  | "created"
  | "initializing"
  | "ready"
  | "degraded"
  | "shutting-down"
  | "stopped";

export type OrganizerLifecycleEvent =
  | { type: "startup-started" }
  | { type: "recovery-started"; operation: "directories" | "moves" }
  | { type: "recovery-completed"; operation: "directories" | "moves" }
  | { type: "retention-cleanup-started" }
  | { type: "retention-cleanup-completed" }
  | { type: "startup-completed"; degraded: boolean }
  | { type: "session-invalidated" }
  | { type: "session-configured" }
  | { type: "scan-started" }
  | { type: "scan-completed"; discoveredFileCount: number; skippedEntryCount: number }
  | { type: "shutdown-started" }
  | { type: "shutdown-completed" };

export type OrganizerEventListener = (event: OrganizerLifecycleEvent) => void;

export type DesktopFolderKind = "inbox" | "destination";

export type PrivilegedDesktopFolderSelection = Readonly<{
  source: "native-dialog";
  kind: DesktopFolderKind;
  directoryPath: string;
}>;

export type DesktopFolderValidation = {
  displayPath: string;
  status: "valid" | "unavailable" | "not-directory" | "permission-denied";
  readable: boolean;
  writable: boolean;
};

export type DesktopSessionValidation = {
  inbox?: DesktopFolderValidation;
  destination?: DesktopFolderValidation;
  sameFilesystem: boolean | null;
  ready: boolean;
};

export type OrganizerApplicationStatus = {
  state: OrganizerApplicationState;
  mutationAvailable: boolean;
  session: DesktopSessionValidation;
};

export type OrganizerScanResult = ScannedFile[];

export type OrganizerDetailedScanResult = {
  files: ScannedFile[];
  skippedEntryCount: number;
  skipped: ScanSkippedEntryCounts;
};
