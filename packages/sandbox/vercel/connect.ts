import type { Sandbox, SandboxHooks } from "../interface";
import { VercelSandbox } from "./sandbox";
import type { VercelState } from "./state";

interface ConnectOptions {
  env?: Record<string, string>;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  ports?: number[];
  baseSnapshotId?: string;
  sandboxName?: string;
  resume?: boolean;
  restoreSnapshot?: boolean;
}

function getRemainingTimeout(
  expiresAt: number | undefined,
): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const remaining = expiresAt - Date.now();
  return remaining > 10_000 ? remaining : undefined;
}

/**
 * Connect to the Vercel-backed cloud sandbox based on the provided state.
 *
 * - If `restoreSnapshot` is enabled with `snapshotId`, creates a new sandbox from the legacy snapshot
 * - If `sandboxId` is present, reconnects to the persistent named sandbox
 * - If `snapshotId` is present (without sandboxId), restores a legacy sandbox from snapshot
 * - If `source` is present, creates a new sandbox
 * - Otherwise, creates an empty sandbox
 */
export async function connectVercel(
  state: VercelState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  if (state.snapshotId && options?.restoreSnapshot) {
    return VercelSandbox.create({
      name: state.sandboxId,
      env: options.env,
      gitUser: options.gitUser,
      hooks: options.hooks,
      timeout: options.timeout,
      ports: options.ports,
      baseSnapshotId: state.snapshotId,
    });
  }

  if (state.sandboxId) {
    const remainingTimeout = getRemainingTimeout(state.expiresAt);

    return VercelSandbox.connect(state.sandboxId, {
      env: options?.env,
      hooks: options?.hooks,
      remainingTimeout,
      ports: options?.ports,
      resume: options?.resume,
    });
  }

  if (state.snapshotId) {
    return VercelSandbox.create({
      name: options?.sandboxName,
      env: options?.env,
      gitUser: options?.gitUser,
      hooks: options?.hooks,
      timeout: options?.timeout,
      ports: options?.ports,
      baseSnapshotId: state.snapshotId,
    });
  }

  if (state.source) {
    return VercelSandbox.create({
      name: options?.sandboxName,
      source: {
        url: state.source.repo,
        branch: state.source.branch,
        token: state.source.token,
        newBranch: state.source.newBranch,
      },
      env: options?.env,
      gitUser: options?.gitUser,
      hooks: options?.hooks,
      timeout: options?.timeout,
      ports: options?.ports,
      baseSnapshotId: options?.baseSnapshotId,
    });
  }

  return VercelSandbox.create({
    name: options?.sandboxName,
    env: options?.env,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    timeout: options?.timeout,
    ports: options?.ports,
    baseSnapshotId: options?.baseSnapshotId,
  });
}
