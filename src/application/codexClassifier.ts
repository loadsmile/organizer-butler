import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { areas } from "../core/taxonomy/areas.js";
import { documentTypes } from "../core/taxonomy/documentTypes.js";
import {
  localClassifierCandidateSchema,
  localClassifierInputSchema,
  routeLocalClassifierCandidate,
  type LocalClassifier,
  type LocalClassifierInput,
  type LocalClassifierOutput,
} from "./localClassifier.js";

export type CodexClassifierOptions = {
  workingDirectory: string;
  codexHome: string;
  codexPath?: string;
};

type CodexTurnRunner = (prompt: string, outputSchema: object) => Promise<{
  finalResponse: string;
  items: Array<{ type: string }>;
}>;

const candidateOutputSchema = {
  type: "object",
  properties: {
    area: { type: "string", enum: [...areas] },
    documentType: { type: "string", enum: [...documentTypes] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", maxLength: 1_000 },
  },
  required: ["area", "documentType", "confidence", "rationale"],
  additionalProperties: false,
} as const;

export class CodexClassifier implements LocalClassifier {
  readonly #run: CodexTurnRunner;

  constructor(options: CodexClassifierOptions) {
    const codexOptions: CodexOptions = {
      ...(options.codexPath ? { codexPathOverride: options.codexPath } : {}),
      env: codexEnvironment(options.codexHome),
      config: {
        check_for_update_on_startup: false,
        approval_policy: "never",
        sandbox_mode: "read-only",
        web_search: "disabled",
        history: { persistence: "none" },
        apps: { _default: { enabled: false } },
        agents: { enabled: false },
        memories: { generate_memories: false, use_memories: false },
        features: {
          apps: false,
          hooks: false,
          shell_tool: false,
          multi_agent: false,
          memories: false,
          remote_plugin: false,
        },
      },
    };
    const codex = new Codex(codexOptions);
    this.#run = async (prompt, outputSchema) => codex.startThread({
      workingDirectory: options.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      modelReasoningEffort: "low",
      webSearchMode: "disabled",
      networkAccessEnabled: false,
    }).run(prompt, { outputSchema });
  }

  async classify(input: LocalClassifierInput): Promise<LocalClassifierOutput> {
    const safeInput = localClassifierInputSchema.parse(input);
    const result = await this.#run(classifierPrompt(safeInput), candidateOutputSchema);
    if (result.items.some((item) => !["agent_message", "reasoning"].includes(item.type))) {
      throw new Error("Codex attempted to use a disabled tool during classification.");
    }
    const candidate = localClassifierCandidateSchema.parse(JSON.parse(result.finalResponse));
    return routeLocalClassifierCandidate(candidate);
  }
}

export function createCodexClassifierForTest(run: CodexTurnRunner): LocalClassifier {
  return {
    async classify(input) {
      const safeInput = localClassifierInputSchema.parse(input);
      const result = await run(classifierPrompt(safeInput), candidateOutputSchema);
      if (result.items.some((item) => !["agent_message", "reasoning"].includes(item.type))) {
        throw new Error("Codex attempted to use a disabled tool during classification.");
      }
      return routeLocalClassifierCandidate(
        localClassifierCandidateSchema.parse(JSON.parse(result.finalResponse)),
      );
    },
  };
}

export function codexEnvironment(codexHome: string): Record<string, string> {
  const allowed = [
    "HOME", "USERPROFILE", "PATH", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR",
    "LANG", "LC_ALL", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE",
  ];
  const environment: Record<string, string> = { CODEX_HOME: codexHome };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function classifierPrompt(input: LocalClassifierInput): string {
  return [
    "Classify one file into the exact controlled taxonomy in the JSON payload.",
    "Return only the requested JSON object. Do not use tools, commands, files, apps, plugins, MCP, or web search.",
    "Use unknown for both area and documentType when evidence is insufficient.",
    "Never invent categories. Confidence must reflect the supplied bounded evidence.",
    "The rationale must be concise and must not claim access to content outside the payload.",
    JSON.stringify(input),
  ].join("\n\n");
}
