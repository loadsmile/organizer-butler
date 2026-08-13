export type ControlledDirectoryStatus = "existing" | "missing";

export type DirectoryPlanPreview = {
  directoryPlanId: string;
  fileId: string;
  expiresAt: string;
  directories: Array<{
    name: string;
    status: ControlledDirectoryStatus;
  }>;
};

export type DirectoryPlanConfirmation = {
  directoryConfirmationId: string;
  directoryPlanId: string;
  fileId: string;
  expiresAt: string;
};

export type DirectoryExecutionResult = {
  directoryConfirmationId: string;
  directoryPlanId: string;
  fileId: string;
  status: "completed";
};
