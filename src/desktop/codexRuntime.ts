import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { codexEnvironment } from "../application/codexClassifier.js";

const platformPackages: Record<string, string> = {
  "darwin-arm64": "@openai/codex-darwin-arm64",
  "darwin-x64": "@openai/codex-darwin-x64",
  "win32-arm64": "@openai/codex-win32-arm64",
  "win32-x64": "@openai/codex-win32-x64",
};

const targetTriples: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export function resolveCodexBinary(): string {
  const target = `${process.platform}-${process.arch}`;
  const packageName = platformPackages[target];
  const triple = targetTriples[target];
  if (!packageName || !triple) throw new Error("Codex is not packaged for this platform.");

  const packagedExecutable = path.join(
    process.resourcesPath,
    `codex-${process.platform}-${process.arch}`,
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (existsSync(packagedExecutable)) return packagedExecutable;

  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(`${packageName}/package.json`);
  const executable = path.join(
    path.dirname(packageJson),
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  return executable.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

export async function codexAuthStatus(binary: string, codexHome: string): Promise<boolean> {
  return (await runCodex(binary, codexHome, ["login", "status"])).code === 0;
}

export async function codexLogin(binary: string, codexHome: string): Promise<boolean> {
  const result = await runCodex(binary, codexHome, ["login"]);
  return result.code === 0 && codexAuthStatus(binary, codexHome);
}

export async function codexLogout(binary: string, codexHome: string): Promise<void> {
  await runCodex(binary, codexHome, ["logout"]);
}

async function runCodex(
  binary: string,
  codexHome: string,
  command: string[],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      "--config", 'cli_auth_credentials_store="keyring"',
      "--config", "check_for_update_on_startup=false",
      ...command,
    ], {
      env: codexEnvironment(codexHome),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
