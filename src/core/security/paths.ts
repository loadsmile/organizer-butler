import path from "node:path";
import { OrganizerError } from "../../domain/error.js";

export class UnsafePathError extends OrganizerError {
  constructor(message: string) {
    super("UNSAFE_PATH", message);
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertPathInside(root: string, candidate: string): void {
  if (!isPathInside(root, candidate)) {
    throw new UnsafePathError("Path is outside the allowed root.");
  }
}
