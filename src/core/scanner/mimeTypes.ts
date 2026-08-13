import path from "node:path";

const mimeTypes: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".dmg": "application/x-apple-diskimage",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".pkg": "application/vnd.apple.installer+xml",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

export function inferMimeType(filename: string): string {
  return mimeTypes[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}
