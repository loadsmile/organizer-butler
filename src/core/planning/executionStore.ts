import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { OrganizerError } from "../../domain/error.js";

export type ExecutionState = "ready" | "executing" | "completed" | "invalidated" | "expired";
export type ExecutionPhase = "prepared" | "destination-created" | "source-removed";

export type DurableExecutionRecord = {
  confirmationId: string;
  planId: string;
  fileId: string;
  sourcePath: string;
  sourceDevice: number;
  sourceInode: number;
  sourceSize: number;
  sourceModifiedAtMs: number;
  inboxRoot: string;
  inboxRootDevice: number;
  inboxRootInode: number;
  organizationRoot: string;
  organizationRootDevice: number;
  organizationRootInode: number;
  destinationPath: string;
  expiresAt: number;
  state: ExecutionState;
  phase: ExecutionPhase;
  recoveryOutcome: "none" | "completed" | "invalidated";
  terminalAt: number | null;
};

export type ExecutionRetentionPolicy = {
  invalidatedMs: number;
  expiredMs: number;
  completedMs: number;
};

export type DirectoryExecutionState = ExecutionState;
export type DirectoryExecutionPhase = "prepared" | "creating" | "directories-created" | "rolling-back";
export type DirectorySegmentState = "pending" | "creating" | "created" | "existing" | "removed" | "rollback-blocked";

export type DurableDirectorySegment = {
  ordinal: number;
  directoryPath: string;
  state: DirectorySegmentState;
  parentDevice: number | null;
  parentInode: number | null;
  parentUid: number | null;
  parentGid: number | null;
  directoryDevice: number | null;
  directoryInode: number | null;
  directoryUid: number | null;
  directoryGid: number | null;
  createdByOperation: boolean;
};

export type DurableDirectoryExecutionRecord = {
  confirmationId: string;
  planId: string;
  fileId: string;
  organizationRoot: string;
  organizationRootDevice: number;
  organizationRootInode: number;
  organizationRootUid: number;
  organizationRootGid: number;
  destinationPath: string;
  expiresAt: number;
  state: DirectoryExecutionState;
  phase: DirectoryExecutionPhase;
  recoveryOutcome: "none" | "completed" | "rolled-back" | "rollback-incomplete" | "invalidated";
  terminalAt: number | null;
  segments: DurableDirectorySegment[];
};

export interface DirectoryExecutionStore {
  createDirectory(record: DurableDirectoryExecutionRecord): void;
  getDirectory(confirmationId: string): DurableDirectoryExecutionRecord | undefined;
  claimDirectory(confirmationId: string, now: number): { record: DurableDirectoryExecutionRecord; claimed: boolean } | undefined;
  setDirectoryPhase(confirmationId: string, phase: DirectoryExecutionPhase): void;
  setDirectorySegment(confirmationId: string, segment: DurableDirectorySegment): void;
  completeDirectory(confirmationId: string, recovered: boolean, now: number): void;
  invalidateDirectory(confirmationId: string, expired: boolean, outcome: DurableDirectoryExecutionRecord["recoveryOutcome"], now: number): void;
  listExecutingDirectories(): DurableDirectoryExecutionRecord[];
  claimDirectoryRecovery(confirmationId: string, now: number): boolean;
  cleanupTerminalDirectories(now: number, policy: ExecutionRetentionPolicy): number;
}

export interface ExecutionStore {
  create(record: DurableExecutionRecord): void;
  get(confirmationId: string): DurableExecutionRecord | undefined;
  claim(confirmationId: string, now: number): { record: DurableExecutionRecord; claimed: boolean } | undefined;
  setPhase(confirmationId: string, phase: ExecutionPhase): void;
  complete(confirmationId: string, recovered: boolean, now: number): void;
  invalidate(confirmationId: string, expired: boolean, now: number): void;
  listExecuting(): DurableExecutionRecord[];
  claimRecovery(confirmationId: string, now: number): boolean;
  cleanupTerminal(now: number, policy: ExecutionRetentionPolicy): number;
}

export class InMemoryExecutionStore implements ExecutionStore, DirectoryExecutionStore {
  readonly #records = new Map<string, DurableExecutionRecord>();
  readonly #recoveryClaims = new Set<string>();
  readonly #directoryRecords = new Map<string, DurableDirectoryExecutionRecord>();
  readonly #directoryRecoveryClaims = new Set<string>();

  create(record: DurableExecutionRecord): void {
    if (this.#records.has(record.confirmationId)) throw storageError();
    this.#records.set(record.confirmationId, { ...record });
  }

  get(confirmationId: string): DurableExecutionRecord | undefined {
    const record = this.#records.get(confirmationId);
    return record ? { ...record } : undefined;
  }

  claim(confirmationId: string, now: number): { record: DurableExecutionRecord; claimed: boolean } | undefined {
    const record = this.#records.get(confirmationId);
    if (!record) return undefined;
    let claimed = false;
    if (record.state === "ready" && now >= record.expiresAt) {
      record.state = "expired";
      record.recoveryOutcome = "invalidated";
      record.terminalAt = now;
    } else if (record.state === "ready") {
      record.state = "executing";
      record.phase = "prepared";
      claimed = true;
    }
    return { record: { ...record }, claimed };
  }

  setPhase(confirmationId: string, phase: ExecutionPhase): void {
    const record = this.#records.get(confirmationId);
    if (!record || record.state !== "executing") throw storageError();
    record.phase = phase;
  }

  complete(confirmationId: string, recovered: boolean, now: number): void {
    const record = this.#records.get(confirmationId);
    if (!record || record.state !== "executing") throw storageError();
    record.state = "completed";
    record.recoveryOutcome = recovered ? "completed" : "none";
    record.terminalAt = now;
  }

  invalidate(confirmationId: string, expired: boolean, now: number): void {
    const record = this.#records.get(confirmationId);
    if (!record || !["ready", "executing"].includes(record.state)) return;
    record.state = expired ? "expired" : "invalidated";
    record.recoveryOutcome = "invalidated";
    record.terminalAt = now;
  }

  listExecuting(): DurableExecutionRecord[] {
    return [...this.#records.values()].filter(({ state }) => state === "executing").map((record) => ({ ...record }));
  }

  claimRecovery(confirmationId: string): boolean {
    if (this.#recoveryClaims.has(confirmationId)) return false;
    const record = this.#records.get(confirmationId);
    if (!record || record.state !== "executing") return false;
    this.#recoveryClaims.add(confirmationId);
    return true;
  }

  cleanupTerminal(now: number, policy: ExecutionRetentionPolicy): number {
    let deleted = 0;
    for (const [id, record] of this.#records) {
      const retention = retentionFor(record.state, policy);
      if (retention !== undefined && record.terminalAt !== null && now - record.terminalAt >= retention) {
        this.#records.delete(id);
        this.#recoveryClaims.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  createDirectory(record: DurableDirectoryExecutionRecord): void {
    if (this.#directoryRecords.has(record.confirmationId)) throw storageError();
    this.#directoryRecords.set(record.confirmationId, cloneDirectoryRecord(record));
  }

  getDirectory(confirmationId: string): DurableDirectoryExecutionRecord | undefined {
    const record = this.#directoryRecords.get(confirmationId);
    return record ? cloneDirectoryRecord(record) : undefined;
  }

  claimDirectory(confirmationId: string, now: number): { record: DurableDirectoryExecutionRecord; claimed: boolean } | undefined {
    const record = this.#directoryRecords.get(confirmationId);
    if (!record) return undefined;
    let claimed = false;
    if (record.state === "ready" && now >= record.expiresAt) {
      record.state = "expired";
      record.recoveryOutcome = "invalidated";
      record.terminalAt = now;
    } else if (record.state === "ready") {
      record.state = "executing";
      record.phase = "prepared";
      claimed = true;
    }
    return { record: cloneDirectoryRecord(record), claimed };
  }

  setDirectoryPhase(confirmationId: string, phase: DirectoryExecutionPhase): void {
    const record = this.#directoryRecords.get(confirmationId);
    if (!record || record.state !== "executing") throw storageError();
    record.phase = phase;
  }

  setDirectorySegment(confirmationId: string, segment: DurableDirectorySegment): void {
    const record = this.#directoryRecords.get(confirmationId);
    if (!record || record.state !== "executing" || !record.segments[segment.ordinal]) throw storageError();
    record.segments[segment.ordinal] = { ...segment };
  }

  completeDirectory(confirmationId: string, recovered: boolean, now: number): void {
    const record = this.#directoryRecords.get(confirmationId);
    if (!record || record.state !== "executing") throw storageError();
    record.state = "completed";
    record.phase = "directories-created";
    record.recoveryOutcome = recovered ? "completed" : "none";
    record.terminalAt = now;
  }

  invalidateDirectory(
    confirmationId: string,
    expired: boolean,
    outcome: DurableDirectoryExecutionRecord["recoveryOutcome"],
    now: number,
  ): void {
    const record = this.#directoryRecords.get(confirmationId);
    if (!record || !["ready", "executing"].includes(record.state)) return;
    record.state = expired ? "expired" : "invalidated";
    record.recoveryOutcome = outcome;
    record.terminalAt = now;
  }

  listExecutingDirectories(): DurableDirectoryExecutionRecord[] {
    return [...this.#directoryRecords.values()]
      .filter(({ state }) => state === "executing")
      .map(cloneDirectoryRecord);
  }

  claimDirectoryRecovery(confirmationId: string): boolean {
    if (this.#directoryRecoveryClaims.has(confirmationId)) return false;
    const record = this.#directoryRecords.get(confirmationId);
    if (!record || record.state !== "executing") return false;
    this.#directoryRecoveryClaims.add(confirmationId);
    return true;
  }

  cleanupTerminalDirectories(now: number, policy: ExecutionRetentionPolicy): number {
    let deleted = 0;
    for (const [id, record] of this.#directoryRecords) {
      const retention = retentionFor(record.state, policy);
      if (retention !== undefined && record.terminalAt !== null && now - record.terminalAt >= retention) {
        this.#directoryRecords.delete(id);
        this.#directoryRecoveryClaims.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class SqliteExecutionStore implements ExecutionStore, DirectoryExecutionStore {
  readonly #database: DatabaseSync;
  readonly #recoveryOwner = randomUUID();
  readonly #recoveryLeaseMs: number;

  constructor(databasePath: string, options: { recoveryLeaseMs?: number; now?: () => number } = {}) {
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      database = new DatabaseSync(databasePath);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      migrate(database, options.now?.() ?? Date.now());
      this.#recoveryLeaseMs = options.recoveryLeaseMs ?? 30_000;
      this.#database = database;
    } catch {
      try {
        database?.close();
      } catch {}
      throw storageError();
    }
  }

  close(): void {
    try {
      this.#database.close();
    } catch {
      throw storageError();
    }
  }

  create(record: DurableExecutionRecord): void {
    try {
      this.#database
        .prepare(`INSERT INTO organization_executions VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`)
        .run(...recordValues(record));
    } catch {
      throw storageError();
    }
  }

  get(confirmationId: string): DurableExecutionRecord | undefined {
    try {
      const row = this.#database
        .prepare("SELECT * FROM organization_executions WHERE confirmation_id = ?")
        .get(confirmationId) as ExecutionRow | undefined;
      return row ? rowToRecord(row) : undefined;
    } catch {
      throw storageError();
    }
  }

  claim(confirmationId: string, now: number): { record: DurableExecutionRecord; claimed: boolean } | undefined {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database
        .prepare("SELECT * FROM organization_executions WHERE confirmation_id = ?")
        .get(confirmationId) as ExecutionRow | undefined;
      let claimed = false;
      if (row?.state === "ready" && now >= row.expires_at) {
        this.#database
          .prepare("UPDATE organization_executions SET state = 'expired', recovery_outcome = 'invalidated', terminal_at = ? WHERE confirmation_id = ? AND state = 'ready'")
          .run(now, confirmationId);
      } else if (row?.state === "ready") {
        const result = this.#database
          .prepare("UPDATE organization_executions SET state = 'executing', phase = 'prepared' WHERE confirmation_id = ? AND state = 'ready'")
          .run(confirmationId);
        claimed = result.changes === 1;
      }
      this.#database.exec("COMMIT");
      const record = this.get(confirmationId);
      return record ? { record, claimed } : undefined;
    } catch {
      rollback(this.#database);
      throw storageError();
    }
  }

  setPhase(confirmationId: string, phase: ExecutionPhase): void {
    this.#updateExecuting("phase = ?", [phase, confirmationId]);
  }

  complete(confirmationId: string, recovered: boolean, now: number): void {
    this.#updateExecuting("state = 'completed', recovery_outcome = ?, terminal_at = ?", [recovered ? "completed" : "none", now, confirmationId]);
  }

  invalidate(confirmationId: string, expired: boolean, now: number): void {
    try {
      this.#database
        .prepare(`UPDATE organization_executions SET state = ?, recovery_outcome = 'invalidated', terminal_at = ?
          WHERE confirmation_id = ? AND state IN ('ready', 'executing')`)
        .run(expired ? "expired" : "invalidated", now, confirmationId);
    } catch {
      throw storageError();
    }
  }

  listExecuting(): DurableExecutionRecord[] {
    try {
      const rows = this.#database.prepare("SELECT * FROM organization_executions WHERE state = 'executing'").all() as ExecutionRow[];
      return rows.map(rowToRecord);
    } catch {
      throw storageError();
    }
  }

  claimRecovery(confirmationId: string, now: number): boolean {
    try {
      const expiresAt = now + this.#recoveryLeaseMs;
      const result = this.#database
        .prepare(`INSERT INTO organization_execution_recovery_claims (confirmation_id, owner_id, expires_at)
          SELECT confirmation_id, ?, ? FROM organization_executions
          WHERE confirmation_id = ? AND state = 'executing'
          ON CONFLICT(confirmation_id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at
          WHERE organization_execution_recovery_claims.expires_at <= ?`)
        .run(this.#recoveryOwner, expiresAt, confirmationId, now);
      return result.changes === 1;
    } catch {
      throw storageError();
    }
  }

  cleanupTerminal(now: number, policy: ExecutionRetentionPolicy): number {
    try {
      const result = this.#database.prepare(`DELETE FROM organization_executions
        WHERE terminal_at IS NOT NULL AND (
          (state = 'invalidated' AND terminal_at <= ?) OR
          (state = 'expired' AND terminal_at <= ?) OR
          (state = 'completed' AND terminal_at <= ?)
        )`).run(now - policy.invalidatedMs, now - policy.expiredMs, now - policy.completedMs);
      return Number(result.changes);
    } catch {
      throw storageError();
    }
  }

  createDirectory(record: DurableDirectoryExecutionRecord): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#database.prepare(`INSERT INTO organization_directory_executions (
        confirmation_id, plan_id, file_id, organization_root, organization_root_device,
        organization_root_inode, organization_root_uid, organization_root_gid, destination_path,
        expires_at, state, phase, recovery_outcome, terminal_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...directoryRecordValues(record));
      const insertSegment = this.#database.prepare(`INSERT INTO organization_directory_execution_segments (
        confirmation_id, ordinal, directory_path, state, parent_device, parent_inode, parent_uid, parent_gid,
        directory_device, directory_inode, directory_uid, directory_gid, created_by_operation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const segment of record.segments) insertSegment.run(...directorySegmentValues(record.confirmationId, segment));
      this.#database.exec("COMMIT");
    } catch {
      rollback(this.#database);
      throw storageError();
    }
  }

  getDirectory(confirmationId: string): DurableDirectoryExecutionRecord | undefined {
    try {
      const row = this.#database.prepare("SELECT * FROM organization_directory_executions WHERE confirmation_id = ?")
        .get(confirmationId) as DirectoryExecutionRow | undefined;
      if (!row) return undefined;
      const segments = this.#database.prepare(
        "SELECT * FROM organization_directory_execution_segments WHERE confirmation_id = ? ORDER BY ordinal",
      ).all(confirmationId) as DirectorySegmentRow[];
      return directoryRowToRecord(row, segments);
    } catch {
      throw storageError();
    }
  }

  claimDirectory(confirmationId: string, now: number): { record: DurableDirectoryExecutionRecord; claimed: boolean } | undefined {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database.prepare("SELECT state, expires_at FROM organization_directory_executions WHERE confirmation_id = ?")
        .get(confirmationId) as { state: DirectoryExecutionState; expires_at: number } | undefined;
      let claimed = false;
      if (row?.state === "ready" && now >= row.expires_at) {
        this.#database.prepare(`UPDATE organization_directory_executions
          SET state = 'expired', recovery_outcome = 'invalidated', terminal_at = ?
          WHERE confirmation_id = ? AND state = 'ready'`).run(now, confirmationId);
      } else if (row?.state === "ready") {
        claimed = this.#database.prepare(`UPDATE organization_directory_executions
          SET state = 'executing', phase = 'prepared' WHERE confirmation_id = ? AND state = 'ready'`)
          .run(confirmationId).changes === 1;
      }
      this.#database.exec("COMMIT");
      const record = this.getDirectory(confirmationId);
      return record ? { record, claimed } : undefined;
    } catch {
      rollback(this.#database);
      throw storageError();
    }
  }

  setDirectoryPhase(confirmationId: string, phase: DirectoryExecutionPhase): void {
    this.#updateDirectoryExecuting("phase = ?", [phase, confirmationId]);
  }

  setDirectorySegment(confirmationId: string, segment: DurableDirectorySegment): void {
    try {
      const result = this.#database.prepare(`UPDATE organization_directory_execution_segments SET
        state = ?, parent_device = ?, parent_inode = ?, parent_uid = ?, parent_gid = ?,
        directory_device = ?, directory_inode = ?, directory_uid = ?, directory_gid = ?, created_by_operation = ?
        WHERE confirmation_id = ? AND ordinal = ? AND EXISTS (
          SELECT 1 FROM organization_directory_executions
          WHERE confirmation_id = ? AND state = 'executing'
        )`).run(
          segment.state, segment.parentDevice, segment.parentInode, segment.parentUid, segment.parentGid,
          segment.directoryDevice, segment.directoryInode, segment.directoryUid, segment.directoryGid,
          segment.createdByOperation ? 1 : 0, confirmationId, segment.ordinal, confirmationId,
        );
      if (result.changes !== 1) throw new Error();
    } catch {
      throw storageError();
    }
  }

  completeDirectory(confirmationId: string, recovered: boolean, now: number): void {
    this.#updateDirectoryExecuting("state = 'completed', phase = 'directories-created', recovery_outcome = ?, terminal_at = ?", [
      recovered ? "completed" : "none", now, confirmationId,
    ]);
  }

  invalidateDirectory(
    confirmationId: string,
    expired: boolean,
    outcome: DurableDirectoryExecutionRecord["recoveryOutcome"],
    now: number,
  ): void {
    try {
      this.#database.prepare(`UPDATE organization_directory_executions SET state = ?, recovery_outcome = ?, terminal_at = ?
        WHERE confirmation_id = ? AND state IN ('ready', 'executing')`)
        .run(expired ? "expired" : "invalidated", outcome, now, confirmationId);
    } catch {
      throw storageError();
    }
  }

  listExecutingDirectories(): DurableDirectoryExecutionRecord[] {
    try {
      const rows = this.#database.prepare("SELECT confirmation_id FROM organization_directory_executions WHERE state = 'executing'")
        .all() as Array<{ confirmation_id: string }>;
      return rows.map(({ confirmation_id }) => this.getDirectory(confirmation_id))
        .filter((record): record is DurableDirectoryExecutionRecord => Boolean(record));
    } catch {
      throw storageError();
    }
  }

  claimDirectoryRecovery(confirmationId: string, now: number): boolean {
    try {
      const expiresAt = now + this.#recoveryLeaseMs;
      const result = this.#database.prepare(`INSERT INTO organization_directory_execution_recovery_claims
        (confirmation_id, owner_id, expires_at)
        SELECT confirmation_id, ?, ? FROM organization_directory_executions
        WHERE confirmation_id = ? AND state = 'executing'
        ON CONFLICT(confirmation_id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at
        WHERE organization_directory_execution_recovery_claims.expires_at <= ?`)
        .run(this.#recoveryOwner, expiresAt, confirmationId, now);
      return result.changes === 1;
    } catch {
      throw storageError();
    }
  }

  cleanupTerminalDirectories(now: number, policy: ExecutionRetentionPolicy): number {
    try {
      const result = this.#database.prepare(`DELETE FROM organization_directory_executions
        WHERE terminal_at IS NOT NULL AND (
          (state = 'invalidated' AND terminal_at <= ?) OR
          (state = 'expired' AND terminal_at <= ?) OR
          (state = 'completed' AND terminal_at <= ?)
        )`).run(now - policy.invalidatedMs, now - policy.expiredMs, now - policy.completedMs);
      return Number(result.changes);
    } catch {
      throw storageError();
    }
  }

  #updateExecuting(setClause: string, values: Array<string | number>): void {
    try {
      const result = this.#database
        .prepare(`UPDATE organization_executions SET ${setClause} WHERE confirmation_id = ? AND state = 'executing'`)
        .run(...values);
      if (result.changes !== 1) throw new Error();
    } catch {
      throw storageError();
    }
  }

  #updateDirectoryExecuting(setClause: string, values: Array<string | number>): void {
    try {
      const result = this.#database.prepare(
        `UPDATE organization_directory_executions SET ${setClause} WHERE confirmation_id = ? AND state = 'executing'`,
      ).run(...values);
      if (result.changes !== 1) throw new Error();
    } catch {
      throw storageError();
    }
  }
}

function migrate(database: DatabaseSync, now: number): void {
  const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > 2) throw new Error("Unsupported schema version.");
  if (version === 2) {
    validateSchema(database);
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const hasExecutions = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'organization_executions'").get());
    if (version === 0 && !hasExecutions) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS organization_executions (
          confirmation_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_device INTEGER NOT NULL,
          source_inode INTEGER NOT NULL,
          source_size INTEGER NOT NULL,
          source_modified_at_ms REAL NOT NULL,
          inbox_root TEXT NOT NULL,
          inbox_root_device INTEGER NOT NULL,
          inbox_root_inode INTEGER NOT NULL,
          organization_root TEXT NOT NULL,
          organization_root_device INTEGER NOT NULL,
          organization_root_inode INTEGER NOT NULL,
          destination_path TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('ready', 'executing', 'completed', 'invalidated', 'expired')),
          phase TEXT NOT NULL CHECK (phase IN ('prepared', 'destination-created', 'source-removed')),
          recovery_outcome TEXT NOT NULL CHECK (recovery_outcome IN ('none', 'completed', 'invalidated')),
          terminal_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS organization_execution_recovery_claims (
          confirmation_id TEXT PRIMARY KEY REFERENCES organization_executions(confirmation_id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
      `);
    } else if (version === 0) {
      validateLegacySchema(database);
      database.exec("ALTER TABLE organization_executions ADD COLUMN terminal_at INTEGER");
      database.prepare("UPDATE organization_executions SET terminal_at = ? WHERE state IN ('completed', 'invalidated', 'expired')").run(now);
    } else {
      validateMoveSchema(database);
    }
    if (version === 0) database.exec("PRAGMA user_version = 1");
    database.exec(`
      CREATE TABLE organization_directory_executions (
        confirmation_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        organization_root TEXT NOT NULL,
        organization_root_device INTEGER NOT NULL,
        organization_root_inode INTEGER NOT NULL,
        organization_root_uid INTEGER NOT NULL,
        organization_root_gid INTEGER NOT NULL,
        destination_path TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ready', 'executing', 'completed', 'invalidated', 'expired')),
        phase TEXT NOT NULL CHECK (phase IN ('prepared', 'creating', 'directories-created', 'rolling-back')),
        recovery_outcome TEXT NOT NULL CHECK (recovery_outcome IN ('none', 'completed', 'rolled-back', 'rollback-incomplete', 'invalidated')),
        terminal_at INTEGER
      ) STRICT;
      CREATE TABLE organization_directory_execution_segments (
        confirmation_id TEXT NOT NULL REFERENCES organization_directory_executions(confirmation_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        directory_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'creating', 'created', 'existing', 'removed', 'rollback-blocked')),
        parent_device INTEGER,
        parent_inode INTEGER,
        parent_uid INTEGER,
        parent_gid INTEGER,
        directory_device INTEGER,
        directory_inode INTEGER,
        directory_uid INTEGER,
        directory_gid INTEGER,
        created_by_operation INTEGER NOT NULL CHECK (created_by_operation IN (0, 1)),
        PRIMARY KEY (confirmation_id, ordinal),
        UNIQUE (confirmation_id, directory_path)
      ) STRICT;
      CREATE TABLE organization_directory_execution_recovery_claims (
        confirmation_id TEXT PRIMARY KEY REFERENCES organization_directory_executions(confirmation_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
      COMMIT;
    `);
    validateSchema(database);
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function validateLegacySchema(database: DatabaseSync): void {
  const executionColumns = (database.prepare("PRAGMA table_info(organization_executions)").all() as Array<{ name: string }>).map(({ name }) => name);
  const expectedExecutionColumns = [
    "confirmation_id", "plan_id", "file_id", "source_path", "source_device", "source_inode", "source_size",
    "source_modified_at_ms", "inbox_root", "inbox_root_device", "inbox_root_inode", "organization_root",
    "organization_root_device", "organization_root_inode", "destination_path", "expires_at", "state", "phase",
    "recovery_outcome",
  ];
  const claimColumns = (database.prepare("PRAGMA table_info(organization_execution_recovery_claims)").all() as Array<{ name: string }>).map(({ name }) => name);
  if (
    executionColumns.length !== expectedExecutionColumns.length ||
    executionColumns.some((name, index) => name !== expectedExecutionColumns[index]) ||
    claimColumns.length !== 3 ||
    claimColumns.some((name, index) => name !== ["confirmation_id", "owner_id", "expires_at"][index])
  ) {
    throw new Error();
  }
}

function validateSchema(database: DatabaseSync): void {
  const expected = {
    organization_executions: [
      "confirmation_id", "plan_id", "file_id", "source_path", "source_device", "source_inode", "source_size",
      "source_modified_at_ms", "inbox_root", "inbox_root_device", "inbox_root_inode", "organization_root",
      "organization_root_device", "organization_root_inode", "destination_path", "expires_at", "state", "phase",
      "recovery_outcome", "terminal_at",
    ],
    organization_execution_recovery_claims: ["confirmation_id", "owner_id", "expires_at"],
    organization_directory_executions: [
      "confirmation_id", "plan_id", "file_id", "organization_root", "organization_root_device",
      "organization_root_inode", "organization_root_uid", "organization_root_gid", "destination_path",
      "expires_at", "state", "phase", "recovery_outcome", "terminal_at",
    ],
    organization_directory_execution_segments: [
      "confirmation_id", "ordinal", "directory_path", "state", "parent_device", "parent_inode", "parent_uid",
      "parent_gid", "directory_device", "directory_inode", "directory_uid", "directory_gid", "created_by_operation",
    ],
    organization_directory_execution_recovery_claims: ["confirmation_id", "owner_id", "expires_at"],
  } as const;
  for (const [table, columns] of Object.entries(expected)) {
    const actual = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    if (actual.length !== columns.length || actual.some((name, index) => name !== columns[index])) throw new Error();
  }
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length !== 0) throw new Error();
}

function validateMoveSchema(database: DatabaseSync): void {
  const expected = {
    organization_executions: [
      "confirmation_id", "plan_id", "file_id", "source_path", "source_device", "source_inode", "source_size",
      "source_modified_at_ms", "inbox_root", "inbox_root_device", "inbox_root_inode", "organization_root",
      "organization_root_device", "organization_root_inode", "destination_path", "expires_at", "state", "phase",
      "recovery_outcome", "terminal_at",
    ],
    organization_execution_recovery_claims: ["confirmation_id", "owner_id", "expires_at"],
  } as const;
  for (const [table, columns] of Object.entries(expected)) {
    const actual = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    if (actual.length !== columns.length || actual.some((name, index) => name !== columns[index])) throw new Error();
  }
  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length !== 0) throw new Error();
}

type ExecutionRow = {
  confirmation_id: string;
  plan_id: string;
  file_id: string;
  source_path: string;
  source_device: number;
  source_inode: number;
  source_size: number;
  source_modified_at_ms: number;
  inbox_root: string;
  inbox_root_device: number;
  inbox_root_inode: number;
  organization_root: string;
  organization_root_device: number;
  organization_root_inode: number;
  destination_path: string;
  expires_at: number;
  state: ExecutionState;
  phase: ExecutionPhase;
  recovery_outcome: DurableExecutionRecord["recoveryOutcome"];
  terminal_at: number | null;
};

type DirectoryExecutionRow = {
  confirmation_id: string;
  plan_id: string;
  file_id: string;
  organization_root: string;
  organization_root_device: number;
  organization_root_inode: number;
  organization_root_uid: number;
  organization_root_gid: number;
  destination_path: string;
  expires_at: number;
  state: DirectoryExecutionState;
  phase: DirectoryExecutionPhase;
  recovery_outcome: DurableDirectoryExecutionRecord["recoveryOutcome"];
  terminal_at: number | null;
};

type DirectorySegmentRow = {
  ordinal: number;
  directory_path: string;
  state: DirectorySegmentState;
  parent_device: number | null;
  parent_inode: number | null;
  parent_uid: number | null;
  parent_gid: number | null;
  directory_device: number | null;
  directory_inode: number | null;
  directory_uid: number | null;
  directory_gid: number | null;
  created_by_operation: number;
};

function recordValues(record: DurableExecutionRecord): Array<string | number | null> {
  return [
    record.confirmationId,
    record.planId,
    record.fileId,
    record.sourcePath,
    record.sourceDevice,
    record.sourceInode,
    record.sourceSize,
    record.sourceModifiedAtMs,
    record.inboxRoot,
    record.inboxRootDevice,
    record.inboxRootInode,
    record.organizationRoot,
    record.organizationRootDevice,
    record.organizationRootInode,
    record.destinationPath,
    record.expiresAt,
    record.state,
    record.phase,
    record.recoveryOutcome,
    record.terminalAt,
  ];
}

function rowToRecord(row: ExecutionRow): DurableExecutionRecord {
  return {
    confirmationId: row.confirmation_id,
    planId: row.plan_id,
    fileId: row.file_id,
    sourcePath: row.source_path,
    sourceDevice: row.source_device,
    sourceInode: row.source_inode,
    sourceSize: row.source_size,
    sourceModifiedAtMs: row.source_modified_at_ms,
    inboxRoot: row.inbox_root,
    inboxRootDevice: row.inbox_root_device,
    inboxRootInode: row.inbox_root_inode,
    organizationRoot: row.organization_root,
    organizationRootDevice: row.organization_root_device,
    organizationRootInode: row.organization_root_inode,
    destinationPath: row.destination_path,
    expiresAt: row.expires_at,
    state: row.state,
    phase: row.phase,
    recoveryOutcome: row.recovery_outcome,
    terminalAt: row.terminal_at,
  };
}

function directoryRecordValues(record: DurableDirectoryExecutionRecord): Array<string | number | null> {
  return [
    record.confirmationId, record.planId, record.fileId, record.organizationRoot, record.organizationRootDevice,
    record.organizationRootInode, record.organizationRootUid, record.organizationRootGid, record.destinationPath,
    record.expiresAt, record.state, record.phase, record.recoveryOutcome, record.terminalAt,
  ];
}

function directorySegmentValues(confirmationId: string, segment: DurableDirectorySegment): Array<string | number | null> {
  return [
    confirmationId, segment.ordinal, segment.directoryPath, segment.state, segment.parentDevice, segment.parentInode,
    segment.parentUid, segment.parentGid, segment.directoryDevice, segment.directoryInode, segment.directoryUid,
    segment.directoryGid, segment.createdByOperation ? 1 : 0,
  ];
}

function directoryRowToRecord(row: DirectoryExecutionRow, segments: DirectorySegmentRow[]): DurableDirectoryExecutionRecord {
  return {
    confirmationId: row.confirmation_id,
    planId: row.plan_id,
    fileId: row.file_id,
    organizationRoot: row.organization_root,
    organizationRootDevice: row.organization_root_device,
    organizationRootInode: row.organization_root_inode,
    organizationRootUid: row.organization_root_uid,
    organizationRootGid: row.organization_root_gid,
    destinationPath: row.destination_path,
    expiresAt: row.expires_at,
    state: row.state,
    phase: row.phase,
    recoveryOutcome: row.recovery_outcome,
    terminalAt: row.terminal_at,
    segments: segments.map((segment) => ({
      ordinal: segment.ordinal,
      directoryPath: segment.directory_path,
      state: segment.state,
      parentDevice: segment.parent_device,
      parentInode: segment.parent_inode,
      parentUid: segment.parent_uid,
      parentGid: segment.parent_gid,
      directoryDevice: segment.directory_device,
      directoryInode: segment.directory_inode,
      directoryUid: segment.directory_uid,
      directoryGid: segment.directory_gid,
      createdByOperation: segment.created_by_operation === 1,
    })),
  };
}

function cloneDirectoryRecord(record: DurableDirectoryExecutionRecord): DurableDirectoryExecutionRecord {
  return { ...record, segments: record.segments.map((segment) => ({ ...segment })) };
}

function retentionFor(state: ExecutionState, policy: ExecutionRetentionPolicy): number | undefined {
  if (state === "invalidated") return policy.invalidatedMs;
  if (state === "expired") return policy.expiredMs;
  if (state === "completed") return policy.completedMs;
  return undefined;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {}
}

function storageError(): OrganizerError {
  return new OrganizerError("EXECUTION_STORAGE_FAILED", "The organization operation state could not be stored safely.");
}
