import "./styles.css";
import type {
  ClassifiedFile,
  DesktopBootstrap,
  DesktopScanResult,
  MovePreviewResult,
  OrganizerDesktopApi,
} from "../contracts.js";
import type { LocalClassifierOutput } from "../../application/localClassifier.js";
import type { Area } from "../../core/taxonomy/areas.js";
import type { DocumentType } from "../../core/taxonomy/documentTypes.js";
import type { FileInspection } from "../../domain/inspection.js";

declare global {
  interface Window { organizer: OrganizerDesktopApi }
}

type Selection = {
  file: ClassifiedFile;
  inspection?: FileInspection;
  area: Area;
  documentType: DocumentType;
  rationale: string;
  preview?: MovePreviewResult;
};

let bootstrap: DesktopBootstrap | undefined;
let scanResult: DesktopScanResult | undefined;
let selection: Selection | undefined;
let busy = false;
let notice = "Choose an inbox and destination to begin.";

const root = requireElement(document.querySelector<HTMLDivElement>("#app"));

void initialize();

async function initialize(): Promise<void> {
  const response = await window.organizer.bootstrap();
  if (!response.ok) {
    notice = response.error;
  } else {
    bootstrap = response.value;
  }
  render();
}

function render(): void {
  const status = bootstrap?.status;
  const files = scanResult?.files ?? [];
  root.innerHTML = `
    <header class="masthead">
      <div>
        <p class="eyebrow">Local file desk</p>
        <h1>Organizer <i>Butler</i></h1>
      </div>
      <div class="status-mark ${status?.state === "ready" ? "is-ready" : ""}">
        <span></span>${escapeHtml(status?.state ?? "starting")}
      </div>
    </header>
    <section class="folder-strip">
      ${folderCard("inbox", "01", "Inbox", status?.session.inbox?.displayPath)}
      <div class="folder-arrow">→</div>
      ${folderCard("destination", "02", "Destination", status?.session.destination?.displayPath)}
      <button class="scan-button" data-action="scan" ${!status?.session.ready || busy ? "disabled" : ""}>
        <span>${busy ? "Working" : "Scan & classify"}</span>
        <small>Non-recursive</small>
      </button>
    </section>
    <div class="workspace">
      <aside class="rail">
        <nav>
          ${step("1", "Scan", files.length ? `${files.length} found` : "Choose folders", Boolean(scanResult))}
          ${step("2", "Categorize", classifiedCount(files) ? `${classifiedCount(files)} suggested` : "Awaiting scan", classifiedCount(files) > 0)}
          ${step("3", "Review & move", selection?.preview ? "Preview ready" : "Select a file", Boolean(selection?.preview))}
        </nav>
        <section class="ai-card">
          <div class="ai-heading"><span>AI</span><strong>Codex classifier</strong></div>
          <p>Sends filename metadata and a bounded inspection preview. Never sends paths or move authority.</p>
          <label class="consent-row">
            <input type="checkbox" data-action="consent" ${bootstrap?.settings.consent ? "checked" : ""} />
            <span>Classify automatically after scans</span>
          </label>
          <button class="text-button" data-action="auth" ${busy ? "disabled" : ""}>
            ${bootstrap?.codex.signedIn ? "Sign out of Codex" : "Sign in with ChatGPT"}
          </button>
          <small class="auth-state"><span class="dot ${bootstrap?.codex.signedIn ? "online" : ""}"></span>${bootstrap?.codex.signedIn ? "ChatGPT connected" : "Not connected"}</small>
        </section>
      </aside>
      <main class="file-desk">
        <div class="desk-heading">
          <div><p class="eyebrow">Current intake</p><h2>Files on the desk</h2></div>
          <p>${escapeHtml(notice)}</p>
        </div>
        ${fileTable(files)}
      </main>
      <aside class="details">${detailsPanel()}</aside>
    </div>
  `;
  bindEvents();
}

function folderCard(kind: "inbox" | "destination", number: string, label: string, value?: string): string {
  return `<button class="folder-card" data-folder="${kind}">
    <span class="folder-number">${number}</span>
    <span><small>${label}</small><strong>${escapeHtml(value ?? `Choose ${label.toLowerCase()}`)}</strong></span>
    <b>Browse</b>
  </button>`;
}

function step(number: string, title: string, detail: string, active: boolean): string {
  return `<div class="step ${active ? "active" : ""}"><b>${number}</b><span><strong>${title}</strong><small>${detail}</small></span></div>`;
}

function fileTable(files: ClassifiedFile[]): string {
  if (!scanResult) return `<div class="empty-state"><span>OB</span><h3>Nothing opened yet</h3><p>The organizer reads only the top level of the inbox you choose.</p></div>`;
  if (files.length === 0) return `<div class="empty-state"><span>0</span><h3>No regular files found</h3><p>${scanResult.skippedEntryCount} entries were safely skipped.</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>File</th><th>Type</th><th>Suggested home</th><th>Confidence</th><th>Status</th></tr></thead><tbody>
    ${files.map((file) => `<tr data-file="${escapeHtml(file.fileId)}" class="${selection?.file.fileId === file.fileId ? "selected" : ""}">
      <td><strong>${escapeHtml(file.filename)}</strong><small>${formatSize(file.size)} · ${formatDate(file.modifiedAt)}</small></td>
      <td>${escapeHtml(file.extension || "file")}</td>
      <td>${file.classification ? `${label(file.classification.area)} / ${label(file.classification.documentType)}` : "—"}</td>
      <td>${file.classification ? `${Math.round(file.classification.confidence * 100)}%` : "—"}</td>
      <td><span class="pill ${file.aiStatus}">${aiStatus(file)}</span></td>
    </tr>`).join("")}
  </tbody></table></div>`;
}

function detailsPanel(): string {
  if (!selection || !bootstrap) return `<div class="details-empty"><p class="eyebrow">File notes</p><h2>Select a file</h2><p>Inspection evidence, the suggested category, and exact destination will appear here.</p></div>`;
  const { file, inspection, preview } = selection;
  const missing = preview?.directories.directories.filter((directory) => directory.status === "missing") ?? [];
  return `<div class="details-content">
    <p class="eyebrow">File notes</p>
    <h2>${escapeHtml(file.filename)}</h2>
    <div class="detail-rule"></div>
    <label>Area<select data-field="area">${options(bootstrap.taxonomy.areas, selection.area)}</select></label>
    <label>Document type<select data-field="documentType">${options(bootstrap.taxonomy.documentTypes, selection.documentType)}</select></label>
    <label>Rationale<textarea data-field="rationale" maxlength="1000">${escapeHtml(selection.rationale)}</textarea></label>
    <button class="primary" data-action="preview" ${busy ? "disabled" : ""}>Review destination</button>
    ${preview ? `<section class="move-preview">
      <small>Exact relative destination</small>
      <strong>${escapeHtml(`${preview.plan.destination.areaDirectory}/${preview.plan.destination.documentTypeDirectory}/${preview.plan.destination.filename}`)}</strong>
      <p>Conflict: ${escapeHtml(preview.plan.conflict)}</p>
      ${missing.length ? `<button class="warning" data-action="directories" ${busy ? "disabled" : ""}>Create ${missing.length} ${missing.length === 1 ? "folder" : "folders"}</button>` : ""}
      ${!missing.length && preview.plan.conflict === "none" ? `<button class="danger" data-action="move" ${busy ? "disabled" : ""}>Move this file</button>` : ""}
    </section>` : ""}
    <details ${inspection ? "" : "class=loading"}><summary>Bounded inspection</summary><pre>${escapeHtml(inspection ? JSON.stringify(inspection.extraction, null, 2) : "Loading…")}</pre></details>
  </div>`;
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>("[data-folder]").forEach((element) => {
    element.addEventListener("click", () => void chooseFolder(element.dataset.folder as "inbox" | "destination"));
  });
  document.querySelector<HTMLElement>("[data-action=scan]")?.addEventListener("click", () => void scan());
  document.querySelector<HTMLInputElement>("[data-action=consent]")?.addEventListener("change", (event) =>
    void setConsent((event.currentTarget as HTMLInputElement).checked));
  document.querySelector<HTMLElement>("[data-action=auth]")?.addEventListener("click", () => void toggleAuth());
  document.querySelectorAll<HTMLTableRowElement>("[data-file]").forEach((row) => {
    row.addEventListener("click", () => void selectFile(row.dataset.file ?? ""));
  });
  document.querySelector<HTMLSelectElement>("[data-field=area]")?.addEventListener("change", updateSelection);
  document.querySelector<HTMLSelectElement>("[data-field=documentType]")?.addEventListener("change", updateSelection);
  document.querySelector<HTMLTextAreaElement>("[data-field=rationale]")?.addEventListener("input", updateSelection);
  document.querySelector<HTMLElement>("[data-action=preview]")?.addEventListener("click", () => void previewMove());
  document.querySelector<HTMLElement>("[data-action=directories]")?.addEventListener("click", () => void createDirectories());
  document.querySelector<HTMLElement>("[data-action=move]")?.addEventListener("click", () => void executeMove());
}

async function chooseFolder(kind: "inbox" | "destination"): Promise<void> {
  await withBusy(async () => {
    const response = await window.organizer.chooseFolder(kind);
    if (!response.ok) return fail(response.error);
    if (bootstrap) bootstrap.status = response.value;
    scanResult = undefined;
    selection = undefined;
    notice = response.value.session.ready ? "Folders validated on the same filesystem." : "Choose both folders on the same filesystem.";
  });
}

async function setConsent(enabled: boolean): Promise<void> {
  const response = await window.organizer.setAiConsent(enabled);
  if (!response.ok) return fail(response.error);
  if (bootstrap) bootstrap.settings = response.value;
  notice = enabled ? "AI classification enabled. Bounded previews will be sent after scans." : "AI classification disabled.";
  render();
}

async function toggleAuth(): Promise<void> {
  await withBusy(async () => {
    const response = bootstrap?.codex.signedIn
      ? await window.organizer.codexLogout()
      : await window.organizer.codexLogin();
    if (!response.ok) return fail(response.error);
    if (bootstrap) bootstrap.codex = response.value;
    notice = response.value.signedIn ? "Connected through the official ChatGPT sign-in." : "Codex signed out.";
  });
}

async function scan(): Promise<void> {
  await withBusy(async () => {
    notice = bootstrap?.settings.consent && bootstrap.codex.signedIn
      ? "Scanning locally, then classifying files one at a time…"
      : "Scanning locally…";
    render();
    const response = await window.organizer.scan();
    if (!response.ok) return fail(response.error);
    scanResult = response.value;
    selection = undefined;
    notice = `${response.value.files.length} files found; ${response.value.skippedEntryCount} entries skipped.`;
  });
}

async function selectFile(fileId: string): Promise<void> {
  const file = scanResult?.files.find((candidate) => candidate.fileId === fileId);
  if (!file) return;
  const classification = file.classification ?? reviewClassification();
  selection = {
    file,
    area: classification.area,
    documentType: classification.documentType,
    rationale: classification.rationale,
  };
  render();
  const response = await window.organizer.inspect(fileId);
  if (response.ok && selection?.file.fileId === fileId) {
    selection.inspection = response.value;
    render();
  }
}

function updateSelection(): void {
  if (!selection) return;
  selection.area = document.querySelector<HTMLSelectElement>("[data-field=area]")?.value as Area;
  selection.documentType = document.querySelector<HTMLSelectElement>("[data-field=documentType]")?.value as DocumentType;
  selection.rationale = document.querySelector<HTMLTextAreaElement>("[data-field=rationale]")?.value ?? "";
  delete selection.preview;
}

async function previewMove(): Promise<void> {
  if (!selection) return;
  updateSelection();
  await withBusy(async () => {
    if (!selection) return;
    const response = await window.organizer.previewMove({
      fileId: selection.file.fileId,
      classification: classificationFromSelection(selection),
    });
    if (!response.ok) return fail(response.error);
    selection.preview = response.value;
    notice = "Review the exact destination before creating folders or moving the file.";
  });
}

async function createDirectories(): Promise<void> {
  if (!selection?.preview) return;
  await withBusy(async () => {
    if (!selection?.preview) return;
    const response = await window.organizer.createDirectories({
      directoryPlanId: selection.preview.directories.directoryPlanId,
      fileId: selection.file.fileId,
      classification: classificationFromSelection(selection),
    });
    if (!response.ok) return fail(response.error);
    selection.preview = {
      plan: response.value,
      directories: {
        ...selection.preview.directories,
        directories: selection.preview.directories.directories.map((directory) => ({ ...directory, status: "existing" })),
      },
    };
    notice = "Controlled folders created. The move was freshly re-planned.";
  });
}

async function executeMove(): Promise<void> {
  if (!selection?.preview) return;
  await withBusy(async () => {
    if (!selection?.preview) return;
    const movedId = selection.file.fileId;
    const response = await window.organizer.executeMove(selection.preview.plan.planId);
    if (!response.ok) return fail(response.error);
    if (scanResult) scanResult.files = scanResult.files.filter((file) => file.fileId !== movedId);
    selection = undefined;
    notice = "File moved to the reviewed destination.";
  });
}

async function withBusy(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try { await operation(); } finally { busy = false; render(); }
}

function fail(message: string): void { notice = message; }
function classificationFromSelection(value: Selection) {
  return { area: value.area, documentType: value.documentType, rationale: value.rationale };
}
function reviewClassification(): LocalClassifierOutput {
  return { area: "unknown", documentType: "unknown", confidence: 0, rationale: "Manual review required.", reviewRouting: "review-required" };
}
function options(values: readonly string[], selected: string): string {
  return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${label(value)}</option>`).join("");
}
function classifiedCount(files: ClassifiedFile[]): number { return files.filter((file) => file.classification).length; }
function aiStatus(file: ClassifiedFile): string {
  if (file.aiStatus === "classified") return file.classification?.reviewRouting === "accepted" ? "Suggested" : "Review";
  if (file.aiStatus === "signed-out") return "Sign in needed";
  if (file.aiStatus === "disabled") return "Manual";
  return "AI unavailable";
}
function label(value: string): string { return value === "unknown" ? "Review" : value.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "); }
function formatSize(bytes: number): string { return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1_000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character); }
function requireElement<T extends Element>(element: T | null): T {
  if (!element) throw new Error("Renderer root is missing.");
  return element;
}
