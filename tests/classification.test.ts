import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSubmittedClassification } from "../src/core/classification/validateSubmittedClassification.js";
import { areas } from "../src/core/taxonomy/areas.js";
import { isCompatibleClassification } from "../src/core/taxonomy/classificationCompatibility.js";
import { documentTypes } from "../src/core/taxonomy/documentTypes.js";
import { OrganizerError } from "../src/domain/error.js";
import type { FileInspection } from "../src/domain/inspection.js";

const inspection: FileInspection = {
  file: {
    fileId: "file_test",
    filename: "invoice.txt",
    extension: ".txt",
    mimeType: "text/plain",
    size: 7,
    modifiedAt: "2026-08-13T00:00:00.000Z",
  },
  extraction: {
    status: "extracted",
    format: "text",
    excerpt: "invoice",
    extractedTextLength: 7,
    truncated: false,
  },
  ruleEvidence: [{
    ruleId: "filename.invoice",
    source: "filename",
    matchedValue: "invoice",
    areaSignal: "finance",
    documentTypeSignal: "invoice",
  }],
};

describe("submitted classification validation", () => {
  it("accepts controlled compatible taxonomy values and copies trusted inspection context", () => {
    const result = validateSubmittedClassification(inspection, {
      area: "finance",
      documentType: "invoice",
      rationale: "The inspected content is an invoice.",
    });

    assert.deepEqual(result, {
      fileId: "file_test",
      proposal: {
        area: "finance",
        documentType: "invoice",
        rationale: "The inspected content is an invoice.",
      },
      ruleEvidence: inspection.ruleEvidence,
    });
    assert.notEqual(result.ruleEvidence, inspection.ruleEvidence);
    assert.notEqual(result.ruleEvidence[0], inspection.ruleEvidence[0]);
  });

  it("rejects malformed, extra, invented, incompatible, and overlong submissions", () => {
    const invalid: unknown[] = [
      "finance",
      { area: "finance", documentType: "invoice" },
      { area: "finance", documentType: "invoice", rationale: "Invoice.", confidence: 1 },
      { area: "invented", documentType: "invoice", rationale: "Invalid." },
      { area: "finance", documentType: "invented", rationale: "Invalid." },
      { area: "unknown", documentType: "document", rationale: "Invalid." },
      { area: "work", documentType: "unknown", rationale: "Invalid." },
      { area: "work", documentType: "document", rationale: "x".repeat(1_001) },
    ];

    for (const submission of invalid) {
      assert.throws(
        () => validateSubmittedClassification(inspection, submission as never),
        (error: unknown) =>
          error instanceof OrganizerError && error.code === "CLASSIFICATION_INVALID_SUBMISSION",
      );
    }
  });

  it("defines compatibility for every controlled taxonomy identifier", () => {
    for (const area of areas) {
      assert.equal(isCompatibleClassification(area, area === "unknown" ? "unknown" : "document"), true);
    }
    for (const documentType of documentTypes) {
      assert.equal(isCompatibleClassification(documentType === "unknown" ? "unknown" : "other", documentType), true);
    }
    assert.equal(isCompatibleClassification("unknown", "document"), false);
    assert.equal(isCompatibleClassification("work", "unknown"), false);
  });
});
