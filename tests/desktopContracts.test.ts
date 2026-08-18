import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiConsentInputSchema,
  classificationInputSchema,
  fileIdInputSchema,
  folderKindSchema,
} from "../src/desktop/contracts.js";

describe("desktop IPC contracts", () => {
  it("accepts only narrow path-free renderer commands", () => {
    assert.equal(folderKindSchema.safeParse("inbox").success, true);
    assert.equal(folderKindSchema.safeParse("/Users/test/Downloads").success, false);
    assert.equal(aiConsentInputSchema.safeParse({ enabled: true }).success, true);
    assert.equal(aiConsentInputSchema.safeParse({ enabled: true, token: "secret" }).success, false);
    assert.equal(fileIdInputSchema.safeParse({ fileId: "file_test", path: "/tmp/a" }).success, false);
    assert.equal(classificationInputSchema.safeParse({
      fileId: "file_test",
      classification: {
        area: "finance",
        documentType: "invoice",
        rationale: "Bounded evidence indicates an invoice.",
      },
    }).success, true);
  });
});
