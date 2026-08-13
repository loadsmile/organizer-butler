import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateRules } from "../src/core/rules/rulesEngine.js";

describe("rules engine", () => {
  it("returns deterministic evidence without choosing a classification", () => {
    const first = evaluateRules({ filename: "Flight_Boarding-Pass.zip", extension: ".zip" });
    const second = evaluateRules({ filename: "Flight_Boarding-Pass.zip", extension: ".zip" });

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((item) => ({ ruleId: item.ruleId, area: item.areaSignal, type: item.documentTypeSignal })),
      [
        { ruleId: "filename.boarding-pass", area: "travel", type: "ticket" },
        { ruleId: "extension.archive", area: undefined, type: "archive" },
      ],
    );
    assert.equal("classification" in first, false);
  });

  it("matches strong filename and extension indicators case-insensitively", () => {
    assert.deepEqual(
      evaluateRules({ filename: "2026_INVOICE.XLSX" }).map((item) => item.ruleId),
      ["filename.invoice", "extension.spreadsheet"],
    );
    assert.deepEqual(
      evaluateRules({ filename: "family-photo.JPEG" }).map((item) => item.ruleId),
      ["extension.image"],
    );
    assert.deepEqual(
      evaluateRules({ filename: "setup.PKG" }).map((item) => item.ruleId),
      ["extension.installer"],
    );
    assert.deepEqual(
      evaluateRules({ filename: "deck.PPTX" }).map((item) => item.ruleId),
      ["extension.presentation"],
    );
  });
});
