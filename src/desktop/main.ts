import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { CodexClassifier } from "../application/codexClassifier.js";
import { OrganizerApplication } from "../application/organizerApplication.js";
import { folderSelectionFromNativeDialog } from "../application/desktopSession.js";
import { loadConfig } from "../config/config.js";
import { areas } from "../core/taxonomy/areas.js";
import { documentTypes } from "../core/taxonomy/documentTypes.js";
import { OrganizerError } from "../domain/error.js";
import {
  aiConsentInputSchema,
  classificationInputSchema,
  createDirectoriesInputSchema,
  desktopChannels,
  fileIdInputSchema,
  folderKindSchema,
  planIdInputSchema,
  type DesktopResult,
  type DesktopScanResult,
} from "./contracts.js";
import { codexAuthStatus, codexLogin, codexLogout, resolveCodexBinary } from "./codexRuntime.js";
import { DesktopSettingsStore } from "./settings.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let organizer: OrganizerApplication;
let settings: DesktopSettingsStore;
let codexBinary: string;
let codexHome: string;
const mainDirectory = path.dirname(fileURLToPath(import.meta.url));
const smokeTest = process.argv.includes("--smoke-test");

async function initializeBackend(): Promise<void> {
  const userData = app.getPath("userData");
  codexHome = path.join(userData, "codex");
  const classifierDirectory = path.join(userData, "classifier-workspace");
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(classifierDirectory, { recursive: true })]);
  settings = new DesktopSettingsStore(path.join(userData, "settings.json"));
  await settings.load();
  codexBinary = resolveCodexBinary();
  const config = loadConfig({
    ...process.env,
    ORGANIZER_DATABASE_PATH: path.join(userData, "actions.db"),
  });
  organizer = OrganizerApplication.createDurable(config, {
    deferFolders: true,
    classifier: new CodexClassifier({
      workingDirectory: classifierDirectory,
      codexHome,
      codexPath: codexBinary,
    }),
  });
  await organizer.initialize();
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f3efe6",
    title: "Organizer Butler",
    webPreferences: {
      preload: path.join(mainDirectory, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(mainDirectory, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  if (smokeTest) {
    window.webContents.once("did-finish-load", () => {
      console.log("Organizer Butler packaged smoke test passed.");
      void organizer.shutdown().finally(() => app.exit(0));
    });
    window.webContents.once("did-fail-load", () => {
      void organizer.shutdown().finally(() => app.exit(1));
    });
  }
}

function registerHandlers(): void {
  ipcMain.handle(desktopChannels.bootstrap, () => result(async () => ({
    status: organizer.status,
    settings: { consent: settings.aiConsent },
    codex: { signedIn: await codexAuthStatus(codexBinary, codexHome) },
    taxonomy: { areas, documentTypes },
  })));

  ipcMain.handle(desktopChannels.chooseFolder, (_event, rawKind: unknown) => result(async () => {
    const kind = folderKindSchema.parse(rawKind);
    const selection = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    const selectedPath = selection.filePaths[0];
    if (!selection.canceled && selectedPath) {
      await organizer.selectDesktopFolder(folderSelectionFromNativeDialog(kind, selectedPath));
    }
    return organizer.status;
  }));

  ipcMain.handle(desktopChannels.setAiConsent, (_event, raw: unknown) => result(async () => {
    const { enabled } = aiConsentInputSchema.parse(raw);
    await settings.setAiConsent(enabled);
    return { consent: settings.aiConsent };
  }));

  ipcMain.handle(desktopChannels.codexLogin, () => result(async () => ({
    signedIn: await codexLogin(codexBinary, codexHome),
  })));
  ipcMain.handle(desktopChannels.codexLogout, () => result(async () => {
    await codexLogout(codexBinary, codexHome);
    return { signedIn: false };
  }));

  ipcMain.handle(desktopChannels.scan, () => result(async (): Promise<DesktopScanResult> => {
    const scanned = await organizer.scanDetailed();
    const signedIn = settings.aiConsent && await codexAuthStatus(codexBinary, codexHome);
    const files: DesktopScanResult["files"] = [];
    for (const file of scanned.files) {
      if (!settings.aiConsent) {
        files.push({ ...file, aiStatus: "disabled" });
      } else if (!signedIn) {
        files.push({ ...file, aiStatus: "signed-out" });
      } else {
        try {
          files.push({ ...file, classification: await organizer.classify(file.fileId), aiStatus: "classified" });
        } catch {
          files.push({ ...file, aiStatus: "failed" });
        }
      }
    }
    return { ...scanned, files };
  }));

  ipcMain.handle(desktopChannels.inspect, (_event, raw: unknown) => result(async () => {
    const { fileId } = fileIdInputSchema.parse(raw);
    return organizer.inspect(fileId);
  }));
  ipcMain.handle(desktopChannels.classify, (_event, raw: unknown) => result(async () => {
    const { fileId } = fileIdInputSchema.parse(raw);
    if (!settings.aiConsent) throw new Error("Enable AI classification before sending bounded content to Codex.");
    return organizer.classify(fileId);
  }));
  ipcMain.handle(desktopChannels.previewMove, (_event, raw: unknown) => result(async () => {
    const input = classificationInputSchema.parse(raw);
    const plan = await organizer.submitClassificationAndPreview(input.fileId, input.classification);
    const directories = await organizer.previewDirectories(plan.planId);
    return { plan, directories };
  }));
  ipcMain.handle(desktopChannels.createDirectories, (_event, raw: unknown) => result(async () => {
    const input = createDirectoriesInputSchema.parse(raw);
    const confirmation = await organizer.confirmDirectories(input.directoryPlanId);
    await organizer.executeDirectories(confirmation.directoryConfirmationId);
    return organizer.submitClassificationAndPreview(input.fileId, input.classification);
  }));
  ipcMain.handle(desktopChannels.executeMove, (_event, raw: unknown) => result(async () => {
    const { planId } = planIdInputSchema.parse(raw);
    const confirmation = await organizer.confirmMove(planId);
    await organizer.executeMove(confirmation.confirmationId);
    return { status: "completed" as const };
  }));
}

async function result<T>(operation: () => Promise<T>): Promise<DesktopResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

function safeError(error: unknown): string {
  if (error instanceof OrganizerError) return error.message;
  if (error instanceof Error && [
    "Enable AI classification before sending bounded content to Codex.",
    "Codex is not packaged for this platform.",
  ].includes(error.message)) return error.message;
  return "The operation could not be completed safely.";
}

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await initializeBackend();
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Desktop startup failed.");
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!organizer || organizer.status.state === "stopped") return;
  event.preventDefault();
  void organizer.shutdown().finally(() => app.exit());
});
