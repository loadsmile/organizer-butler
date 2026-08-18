import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifierInputFromInspection,
  localClassifierInputSchema,
  localClassifierLimits,
  localClassifierOutputSchema,
  localClassifierPolicy,
  localClassifierTaxonomy,
  routeLocalClassifierCandidate,
  type LocalClassifierInput,
} from "../src/application/localClassifier.js";
import { validateSubmittedClassification } from "../src/core/classification/validateSubmittedClassification.js";
import { isValidatedClassification } from "../src/core/classification/classificationCapability.js";
import type { FileInspection } from "../src/domain/inspection.js";
import { DeterministicFakeLocalClassifier } from "./fakes/localClassifier.js";

const input: LocalClassifierInput = {
  file: {
    filename: "invoice.txt",
    extension: ".txt",
    mimeType: "text/plain",
    size: 7,
    modifiedAt: "2026-08-13T00:00:00.000Z",
  },
  extraction: {
    status: "extracted",
    format: "text",
    content: "invoice",
    truncated: false,
  },
  ruleEvidence: [{
    ruleId: "filename.invoice",
    source: "filename",
    matchedValue: "invoice",
    areaSignal: "finance",
    documentTypeSignal: "invoice",
  }],
  taxonomy: localClassifierTaxonomy(),
  limits: localClassifierLimits(),
};

const inspection: FileInspection = {
  file: { fileId: "file_test", ...input.file },
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

describe("LocalClassifier boundary", () => {
  it("accepts only the path-free controlled input contract", () => {
    assert.deepEqual(localClassifierInputSchema.parse(input), input);

    const forbiddenFields = [
      ["path", "/Users/test/invoice.txt"],
      ["canonicalPath", "/private/Users/test/invoice.txt"],
      ["device", 1],
      ["inode", 2],
      ["fileId", "file_test"],
      ["planId", "plan_test"],
      ["confirmationId", "confirmation_test"],
      ["payload", {}],
      ["readFile", () => undefined],
    ] as const;

    for (const [field, value] of forbiddenFields) {
      assert.equal(localClassifierInputSchema.safeParse({ ...input, [field]: value }).success, false);
    }
  });

  it("projects a fresh inspection into bounded path-free model input", () => {
    const projected = classifierInputFromInspection(inspection);
    assert.deepEqual(projected, input);
    assert.equal("fileId" in projected.file, false);
    assert.equal(JSON.stringify(projected).includes("/tmp/"), false);
  });

  it("rejects extra fields at every nested input level", () => {
    const invalid = [
      { ...input, extra: true },
      { ...input, file: { ...input.file, path: "/tmp/invoice.txt" } },
      { ...input, extraction: { ...input.extraction, parserError: "details" } },
      { ...input, ruleEvidence: [{ ...input.ruleEvidence[0], extra: true }] },
      { ...input, taxonomy: { ...input.taxonomy, extra: true } },
      { ...input, limits: { ...input.limits, providerOptions: {} } },
    ];

    for (const value of invalid) {
      assert.equal(localClassifierInputSchema.safeParse(value).success, false);
    }
  });

  it("rejects altered taxonomies, limits, paths disguised as filenames, and unbounded values", () => {
    const invalid = [
      { ...input, file: { ...input.file, filename: "/tmp/invoice.txt" } },
      { ...input, extraction: { ...input.extraction, content: "x".repeat(localClassifierPolicy.maxExtractionLength + 1) } },
      { ...input, taxonomy: { ...input.taxonomy, areas: [...input.taxonomy.areas].reverse() } },
      { ...input, limits: { ...input.limits, confidenceThreshold: 0.5 } },
    ];

    for (const value of invalid) {
      assert.equal(localClassifierInputSchema.safeParse(value).success, false);
    }
  });

  it("accepts a valid controlled high-confidence result", () => {
    assert.deepEqual(routeLocalClassifierCandidate({
      area: "finance",
      documentType: "invoice",
      confidence: 0.9,
      rationale: "The bounded content and filename evidence indicate an invoice.",
    }), {
      area: "finance",
      documentType: "invoice",
      confidence: 0.9,
      rationale: "The bounded content and filename evidence indicate an invoice.",
      reviewRouting: "accepted",
    });
  });

  it("rejects malformed model candidates and strict output violations", () => {
    const invalidCandidates: unknown[] = [
      { area: "finance", documentType: "invoice", confidence: 0.9 },
      { area: "finance", documentType: "invoice", confidence: 0.9, rationale: "Invoice.", path: "/tmp/a" },
      { area: "invented", documentType: "invoice", confidence: 0.9, rationale: "Invoice." },
      { area: "finance", documentType: "invented", confidence: 0.9, rationale: "Invoice." },
      { area: "unknown", documentType: "invoice", confidence: 0.9, rationale: "Invoice." },
      { area: "finance", documentType: "unknown", confidence: 0.9, rationale: "Invoice." },
      { area: "finance", documentType: "invoice", confidence: -0.1, rationale: "Invoice." },
      { area: "finance", documentType: "invoice", confidence: 1.1, rationale: "Invoice." },
      { area: "finance", documentType: "invoice", confidence: Number.NaN, rationale: "Invoice." },
      { area: "finance", documentType: "invoice", confidence: Number.POSITIVE_INFINITY, rationale: "Invoice." },
      { area: "finance", documentType: "invoice", confidence: Number.NEGATIVE_INFINITY, rationale: "Invoice." },
      { area: "finance", documentType: "invoice", confidence: 0.9, rationale: "x".repeat(localClassifierPolicy.maxRationaleLength + 1) },
      { area: "finance", documentType: "invoice", confidence: 0.9, rationale: 1 },
    ];

    for (const value of invalidCandidates) {
      assert.throws(() => routeLocalClassifierCandidate(value));
    }

    assert.equal(localClassifierOutputSchema.safeParse({
      area: "finance",
      documentType: "invoice",
      confidence: 0.9,
      rationale: "Invoice.",
      reviewRouting: "malformed",
    }).success, false);
    assert.equal(localClassifierOutputSchema.safeParse({
      area: "finance",
      documentType: "invoice",
      confidence: 0.5,
      rationale: "Invoice.",
      reviewRouting: "accepted",
    }).success, false);
  });

  it("routes low-confidence output to review without losing its rationale", () => {
    const result = routeLocalClassifierCandidate({
      area: "finance",
      documentType: "invoice",
      confidence: localClassifierPolicy.confidenceThreshold - 0.01,
      rationale: "Some evidence suggests an invoice, but it is ambiguous.",
    });

    assert.deepEqual(result, {
      area: "unknown",
      documentType: "unknown",
      confidence: 0.74,
      rationale: "Some evidence suggests an invoice, but it is ambiguous.",
      reviewRouting: "review-required",
    });
  });

  it("uses a deterministic fake that validates inputs and applies policy", async () => {
    const classifier = new DeterministicFakeLocalClassifier({
      area: "finance",
      documentType: "invoice",
      confidence: 0.9,
      rationale: "Invoice evidence.",
    });

    assert.deepEqual(await classifier.classify(input), await classifier.classify(input));
    await assert.rejects(() => classifier.classify({ ...input, fileId: "file_test" } as never));
  });

  it("cannot bypass the existing classification capability boundary", () => {
    const classifierOutput = routeLocalClassifierCandidate({
      area: "finance",
      documentType: "invoice",
      confidence: 0.9,
      rationale: "Invoice evidence.",
    });

    assert.throws(() => validateSubmittedClassification(inspection, classifierOutput as never));
    const validated = validateSubmittedClassification(inspection, {
      area: classifierOutput.area,
      documentType: classifierOutput.documentType,
      rationale: classifierOutput.rationale,
    });
    assert.equal(isValidatedClassification(validated), true);
  });
});
