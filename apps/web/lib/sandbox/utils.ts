import type { SandboxState } from "@open-harness/sandbox";
import { SANDBOX_EXPIRES_BUFFER_MS } from "./config";

const PERSISTENT_SANDBOX_NAME_PREFIX = "session_";

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getSandboxId(state: unknown): string | undefined {
  if (!state || typeof state !== "object") {
    return undefined;
  }

  const sandboxId = (state as { sandboxId?: unknown }).sandboxId;
  return hasNonEmptyString(sandboxId) ? sandboxId : undefined;
}

function getExpiresAt(state: unknown): number | undefined {
  if (!state || typeof state !== "object") {
    return undefined;
  }

  const expiresAt = (state as { expiresAt?: unknown }).expiresAt;
  return typeof expiresAt === "number" ? expiresAt : undefined;
}

export function hasSandboxIdentity(state: unknown): boolean {
  return getSandboxId(state) !== undefined;
}

export function hasPersistentSandboxState(state: unknown): boolean {
  const sandboxId = getSandboxId(state);
  return (
    sandboxId !== undefined &&
    sandboxId.startsWith(PERSISTENT_SANDBOX_NAME_PREFIX)
  );
}

/**
 * Type guard to check if a sandbox is active and ready to accept operations.
 */
export function isSandboxActive(
  state: SandboxState | null | undefined,
): state is SandboxState {
  if (!state) return false;

  const expiresAt = getExpiresAt(state);
  if (expiresAt !== undefined) {
    if (Date.now() >= expiresAt - SANDBOX_EXPIRES_BUFFER_MS) {
      return false;
    }
  }

  return hasRuntimeState(state);
}

/**
 * Check if we can perform operations on a sandbox (snapshot, stop, etc.).
 */
export function canOperateOnSandbox(
  state: SandboxState | null | undefined,
): state is SandboxState {
  if (!state) return false;
  return hasRuntimeState(state);
}

/**
 * Check if an unknown value represents sandbox state with an active runtime.
 */
export function hasRuntimeSandboxState(state: unknown): boolean {
  if (!hasSandboxIdentity(state)) {
    return false;
  }

  return getExpiresAt(state) !== undefined;
}

export function canResumeSandbox(
  state: SandboxState | null | undefined,
  snapshotUrl?: string | null,
): boolean {
  return (
    hasSandboxIdentity(state) ||
    (typeof snapshotUrl === "string" && snapshotUrl.length > 0)
  );
}

/**
 * Check if an error message indicates the sandbox VM is permanently unavailable.
 */
export function isSandboxUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("expected a stream of command data") ||
    normalized.includes("status code 410") ||
    normalized.includes("status code 404") ||
    normalized.includes("sandbox is stopped") ||
    normalized.includes("sandbox not found") ||
    normalized.includes("sandbox probe failed") ||
    normalized.includes("session is stopped")
  );
}

function hasRuntimeState(state: SandboxState): boolean {
  return hasRuntimeSandboxState(state);
}

/**
 * Clear active runtime state while preserving persistent sandbox identity when available.
 */
export function clearSandboxState(
  state: SandboxState | null | undefined,
): SandboxState | null {
  if (!state) return null;

  if (hasPersistentSandboxState(state)) {
    return {
      type: state.type,
      sandboxId: getSandboxId(state),
    } as SandboxState;
  }

  return { type: state.type } as SandboxState;
}
