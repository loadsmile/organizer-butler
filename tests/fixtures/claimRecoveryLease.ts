import { SqliteExecutionStore } from "../../src/core/planning/executionStore.js";

const databasePath = process.argv[2];
const confirmationId = process.argv[3];
const leaseMs = Number(process.argv[4]);
if (!databasePath || !confirmationId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
  throw new Error("Invalid arguments.");
}

const store = new SqliteExecutionStore(databasePath, { recoveryLeaseMs: leaseMs });
if (!store.claimRecovery(confirmationId, Date.now())) throw new Error("Recovery claim failed.");
process.stdout.write("claimed\n");
setInterval(() => {}, 60_000);
