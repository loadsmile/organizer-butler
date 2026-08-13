import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { areaSchema } from "../src/core/taxonomy/areas.js";
import { documentTypeSchema } from "../src/core/taxonomy/documentTypes.js";
import { getTaxonomy } from "../src/core/taxonomy/taxonomy.js";

describe("taxonomy", () => {
  it("accepts controlled identifiers and rejects invented values", () => {
    assert.equal(areaSchema.parse("finance"), "finance");
    assert.equal(documentTypeSchema.parse("invoice"), "invoice");
    assert.equal(areaSchema.safeParse("taxes-2026").success, false);
    assert.equal(documentTypeSchema.safeParse("memoir").success, false);
  });

  it("keeps identifiers separate from display names", () => {
    const taxonomy = getTaxonomy();
    assert.deepEqual(taxonomy.areas.find((area) => area.id === "job-applications"), {
      id: "job-applications",
      displayName: "Job Applications",
    });
  });
});
