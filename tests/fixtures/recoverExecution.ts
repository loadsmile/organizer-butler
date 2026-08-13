import { SqliteExecutionStore } from "../../src/core/planning/executionStore.js";
import { OrganizationPlanRegistry } from "../../src/core/planning/previewOrganizationPlan.js";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Missing database path.");

const store = new SqliteExecutionStore(databasePath);
try {
  await new OrganizationPlanRegistry({ executionStore: store }).recover();
} finally {
  store.close();
}
