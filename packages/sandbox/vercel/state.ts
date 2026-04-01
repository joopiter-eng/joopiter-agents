import type { Source } from "../types";

/**
 * State configuration for creating, reconnecting, or restoring the current cloud sandbox provider.
 * Used with the unified `connectSandbox()` API.
 */
export interface VercelState {
  /** Where to clone from (omit for empty sandbox or when reconnecting/restoring) */
  source?: Source;
  /**
   * Stable sandbox name for persistent Vercel sandboxes.
   * During migration this field replaces the old ephemeral sandbox ID semantics.
   */
  sandboxId?: string;
  /** Snapshot ID kept only for legacy restore and migration flows */
  snapshotId?: string;
  /** Timestamp (ms) when the active sandbox session expires */
  expiresAt?: number;
}
