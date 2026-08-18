import {
  localClassifierInputSchema,
  routeLocalClassifierCandidate,
  type LocalClassifier,
  type LocalClassifierCandidate,
  type LocalClassifierInput,
  type LocalClassifierOutput,
} from "../../src/application/localClassifier.js";

export class DeterministicFakeLocalClassifier implements LocalClassifier {
  readonly #candidate: LocalClassifierCandidate;

  constructor(candidate: LocalClassifierCandidate) {
    this.#candidate = candidate;
  }

  async classify(input: LocalClassifierInput): Promise<LocalClassifierOutput> {
    localClassifierInputSchema.parse(input);
    return routeLocalClassifierCandidate(this.#candidate);
  }
}
