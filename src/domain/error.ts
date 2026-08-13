export type OrganizerErrorCode =
  | "INVALID_FILE_ID"
  | "FILE_NOT_FOUND"
  | "FILE_CHANGED"
  | "UNSAFE_PATH"
  | "INSPECTION_FAILED";

export class OrganizerError extends Error {
  override readonly name = "OrganizerError";

  constructor(
    readonly code: OrganizerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
