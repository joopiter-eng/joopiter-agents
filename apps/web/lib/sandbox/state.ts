interface SandboxSourceLike {
  repo: string;
  branch?: string;
  token?: string;
  newBranch?: string;
}

interface SandboxFileEntryLike {
  type: "file" | "directory" | "symlink";
  content?: string;
  encoding?: "base64";
  mode?: number;
  target?: string;
}

type SandboxPendingOperationLike =
  | { type: "writeFile"; path: string; content: string }
  | { type: "mkdir"; path: string; recursive: boolean };

export type SandboxStateLike =
  | {
      type: "just-bash";
      source?: SandboxSourceLike;
      files?: Record<string, SandboxFileEntryLike>;
      workingDirectory?: string;
      env?: Record<string, string>;
    }
  | {
      type: "vercel";
      source?: SandboxSourceLike;
      sandboxId?: string;
      snapshotId?: string;
      expiresAt?: number;
    }
  | {
      type: "hybrid";
      files?: Record<string, SandboxFileEntryLike>;
      workingDirectory?: string;
      env?: Record<string, string>;
      source?: SandboxSourceLike;
      sandboxId?: string;
      snapshotId?: string;
      pendingOperations?: SandboxPendingOperationLike[];
      expiresAt?: number;
    };
