import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCodexClassifierForTest } from "../src/application/codexClassifier.js";
import {
  localClassifierLimits,
  localClassifierTaxonomy,
  type LocalClassifierInput,
} from "../src/application/localClassifier.js";

const input: LocalClassifierInput = {
  file: {
    filename: "hotel-booking.pdf",
    extension: ".pdf",
    mimeType: "application/pdf",
    size: 1200,
    modifiedAt: "2026-08-18T00:00:00.000Z",
  },
  extraction: {
    status: "extracted",
    format: "pdf",
    content: JSON.stringify({ pageCount: 2, metadata: [{ key: "title", value: "Hotel booking" }] }),
    truncated: false,
  },
  ruleEvidence: [],
  taxonomy: localClassifierTaxonomy(),
  limits: localClassifierLimits(),
};

describe("CodexClassifier", () => {
  it("uses structured output and applies the controlled confidence policy", async () => {
    let prompt = "";
    let schema: object | undefined;
    const classifier = createCodexClassifierForTest(async (nextPrompt, outputSchema) => {
      prompt = nextPrompt;
      schema = outputSchema;
      return {
        finalResponse: JSON.stringify({
          area: "travel",
          documentType: "reservation",
          confidence: 0.93,
          rationale: "The bounded title indicates a hotel reservation.",
        }),
        items: [{ type: "reasoning" }, { type: "agent_message" }],
      };
    });

    assert.deepEqual(await classifier.classify(input), {
      area: "travel",
      documentType: "reservation",
      confidence: 0.93,
      rationale: "The bounded title indicates a hotel reservation.",
      reviewRouting: "accepted",
    });
    assert.match(prompt, /Do not use tools/);
    assert.match(prompt, /hotel-booking\.pdf/);
    assert.equal(prompt.includes("fileId"), false);
    assert.equal((schema as { additionalProperties?: boolean }).additionalProperties, false);
  });

  it("rejects malformed output and any attempted tool use", async () => {
    const malformed = createCodexClassifierForTest(async () => ({
      finalResponse: JSON.stringify({ area: "invented" }),
      items: [{ type: "agent_message" }],
    }));
    await assert.rejects(() => malformed.classify(input));

    const toolUse = createCodexClassifierForTest(async () => ({
      finalResponse: JSON.stringify({
        area: "travel",
        documentType: "reservation",
        confidence: 0.9,
        rationale: "Reservation.",
      }),
      items: [{ type: "command_execution" }, { type: "agent_message" }],
    }));
    await assert.rejects(() => toolUse.classify(input), /disabled tool/);
  });
});
