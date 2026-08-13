import { z } from "zod";

export const areas = [
  "work",
  "coding",
  "finance",
  "health",
  "travel",
  "job-applications",
  "personal",
  "other",
  "unknown",
] as const;

export const areaSchema = z.enum(areas);
export type Area = z.infer<typeof areaSchema>;

export const areaDisplayNames: Record<Area, string> = {
  work: "Work",
  coding: "Coding",
  finance: "Finance",
  health: "Health",
  travel: "Travel",
  "job-applications": "Job Applications",
  personal: "Personal",
  other: "Other",
  unknown: "_Review",
};
