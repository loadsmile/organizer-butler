import { z } from "zod";
import { areaSchema, type Area } from "../core/taxonomy/areas.js";
import { documentTypeSchema, type DocumentType } from "../core/taxonomy/documentTypes.js";
import type {
  OrganizerApplicationStatus,
  OrganizerDetailedScanResult,
} from "../application/contracts.js";
import type { LocalClassifierOutput } from "../application/localClassifier.js";
import type { FileInspection } from "../domain/inspection.js";
import type { DirectoryPlanPreview } from "../domain/directoryPlan.js";
import type { OrganizationPlanPreview } from "../domain/organizationPlan.js";

export const desktopChannels = {
  bootstrap: "organizer:bootstrap",
  chooseFolder: "organizer:choose-folder",
  setAiConsent: "organizer:set-ai-consent",
  codexLogin: "organizer:codex-login",
  codexLogout: "organizer:codex-logout",
  scan: "organizer:scan",
  inspect: "organizer:inspect",
  classify: "organizer:classify",
  previewMove: "organizer:preview-move",
  createDirectories: "organizer:create-directories",
  executeMove: "organizer:execute-move",
} as const;

export const folderKindSchema = z.enum(["inbox", "destination"]);
export const fileIdInputSchema = z.object({ fileId: z.string().min(1).max(128) }).strict();
export const aiConsentInputSchema = z.object({ enabled: z.boolean() }).strict();
export const classificationInputSchema = z.object({
  fileId: z.string().min(1).max(128),
  classification: z.object({
    area: areaSchema,
    documentType: documentTypeSchema,
    rationale: z.string().max(1_000),
  }).strict(),
}).strict();
export const createDirectoriesInputSchema = z.object({
  directoryPlanId: z.string().min(1).max(128),
  fileId: z.string().min(1).max(128),
  classification: classificationInputSchema.shape.classification,
}).strict();
export const planIdInputSchema = z.object({ planId: z.string().min(1).max(128) }).strict();

export type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type AiSettings = { consent: boolean };
export type CodexAuthStatus = { signedIn: boolean };
export type DesktopBootstrap = {
  status: OrganizerApplicationStatus;
  settings: AiSettings;
  codex: CodexAuthStatus;
  taxonomy: { areas: readonly Area[]; documentTypes: readonly DocumentType[] };
};
export type ClassifiedFile = OrganizerDetailedScanResult["files"][number] & {
  classification?: LocalClassifierOutput;
  aiStatus: "disabled" | "signed-out" | "classified" | "failed";
};
export type DesktopScanResult = Omit<OrganizerDetailedScanResult, "files"> & {
  files: ClassifiedFile[];
};
export type MovePreviewResult = {
  plan: OrganizationPlanPreview;
  directories: DirectoryPlanPreview;
};

export type OrganizerDesktopApi = {
  bootstrap(): Promise<DesktopResult<DesktopBootstrap>>;
  chooseFolder(kind: "inbox" | "destination"): Promise<DesktopResult<OrganizerApplicationStatus>>;
  setAiConsent(enabled: boolean): Promise<DesktopResult<AiSettings>>;
  codexLogin(): Promise<DesktopResult<CodexAuthStatus>>;
  codexLogout(): Promise<DesktopResult<CodexAuthStatus>>;
  scan(): Promise<DesktopResult<DesktopScanResult>>;
  inspect(fileId: string): Promise<DesktopResult<FileInspection>>;
  classify(fileId: string): Promise<DesktopResult<LocalClassifierOutput>>;
  previewMove(input: z.infer<typeof classificationInputSchema>): Promise<DesktopResult<MovePreviewResult>>;
  createDirectories(input: z.infer<typeof createDirectoriesInputSchema>): Promise<DesktopResult<OrganizationPlanPreview>>;
  executeMove(planId: string): Promise<DesktopResult<{ status: "completed" }>>;
};
