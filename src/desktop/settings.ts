import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

const settingsSchema = z.object({ aiConsent: z.boolean() }).strict();
type Settings = z.infer<typeof settingsSchema>;

export class DesktopSettingsStore {
  #settings: Settings = { aiConsent: false };

  constructor(
    readonly path: string,
    readonly temporaryPath: string = `${path}.tmp`,
  ) {}

  async load(): Promise<void> {
    try {
      this.#settings = settingsSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      this.#settings = { aiConsent: false };
    }
  }

  get aiConsent(): boolean {
    return this.#settings.aiConsent;
  }

  async setAiConsent(enabled: boolean): Promise<void> {
    const next = settingsSchema.parse({ aiConsent: enabled });
    await writeFile(this.temporaryPath, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    await rename(this.temporaryPath, this.path);
    this.#settings = next;
  }
}
