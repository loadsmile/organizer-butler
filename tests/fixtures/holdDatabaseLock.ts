import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
const holdMs = Number(process.argv[3]);
if (!databasePath || !Number.isSafeInteger(holdMs) || holdMs <= 0) throw new Error("Invalid arguments.");

const database = new DatabaseSync(databasePath);
database.exec("BEGIN EXCLUSIVE");
process.stdout.write("locked\n");
await new Promise((resolve) => setTimeout(resolve, holdMs));
database.exec("COMMIT");
database.close();
