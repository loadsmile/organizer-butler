import { loadConfig } from "../config/config.js";
import { FileRegistry } from "../core/scanner/scanDownloads.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "scan";
  if (command !== "scan") {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const registry = new FileRegistry(config.downloadsDirectory);
  const files = await registry.scan();
  process.stdout.write(`${JSON.stringify({ files }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Organizer Butler failed: ${message}\n`);
  process.exitCode = 1;
});
