export type ScannedFile = {
  fileId: string;
  filename: string;
  extension: string;
  mimeType: string;
  size: number;
  modifiedAt: string;
};

export type ResolvedFile = ScannedFile & {
  path: string;
};
