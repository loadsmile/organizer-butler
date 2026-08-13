import path from "node:path";
import type { RuleEvidence } from "../../domain/inspection.js";
import { rules } from "./rules.js";

export type RulesInput = {
  filename: string;
  extension?: string;
};

export function evaluateRules(input: RulesInput): RuleEvidence[] {
  const extension = (input.extension ?? path.extname(input.filename)).toLowerCase();
  const evidence: RuleEvidence[] = [];

  for (const rule of rules) {
    if (rule.source === "filename") {
      const match = rule.pattern.exec(input.filename);
      if (!match) {
        continue;
      }

      evidence.push({
        ruleId: rule.id,
        source: rule.source,
        matchedValue: match[0].trim(),
        ...(rule.areaSignal === undefined ? {} : { areaSignal: rule.areaSignal }),
        documentTypeSignal: rule.documentTypeSignal,
      });
      continue;
    }

    if (rule.extensions.includes(extension)) {
      evidence.push({
        ruleId: rule.id,
        source: rule.source,
        matchedValue: extension,
        ...(rule.areaSignal === undefined ? {} : { areaSignal: rule.areaSignal }),
        documentTypeSignal: rule.documentTypeSignal,
      });
    }
  }

  return evidence;
}
