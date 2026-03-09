import "server-only";

import { getSessionById, updateSession } from "@/lib/db/sessions";
import { canOperateOnSandbox, clearSandboxState } from "./utils";
import {
  buildActiveLifecycleUpdate,
  buildHibernatedLifecycleUpdate,
  getNextLifecycleVersion,
  getLifecycleDueAtMs,
  getSandboxExpiresAtDate,
  getSandboxExpiresAtMs,
  type SandboxLifecycleEvaluationResult,
  type SandboxLifecycleReason,
} from "./lifecycle-state";

function extractSnapshotConflictDetails(error: unknown): string {
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (typeof error === "string") {
    parts.push(error);
  }
  if (error && typeof error === "object") {
    const withText = error as { text?: unknown; json?: unknown };
    if (typeof withText.text === "string") {
      parts.push(withText.text);
    }
    if (withText.json !== undefined) {
      parts.push(JSON.stringify(withText.json));
    }
  }

  return parts.join(" ");
}

function isSnapshotAlreadyInProgressError(error: unknown): boolean {
  const details = extractSnapshotConflictDetails(error).toLowerCase();
  return (
    details.includes("sandbox_snapshotting") ||
    details.includes("creating a snapshot and will be stopped shortly")
  );
}

/**
 * One-shot lifecycle evaluator for workflow orchestration.
 *
 * This performs a single evaluation pass and exits.
 * The durable workflow loops and calls this when it wakes.
 */
export async function evaluateSandboxLifecycle(
  sessionId: string,
  reason: SandboxLifecycleReason,
): Promise<SandboxLifecycleEvaluationResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return { action: "skipped", reason: "session-not-found" };
  }

  if (session.status === "archived" || session.lifecycleState === "archived") {
    return { action: "skipped", reason: "session-archived" };
  }

  const sandboxState = session.sandboxState;
  if (!canOperateOnSandbox(sandboxState)) {
    return { action: "skipped", reason: "sandbox-not-operable" };
  }
  if (sandboxState.type === "just-bash") {
    return { action: "skipped", reason: "just-bash" };
  }

  const nowMs = Date.now();
  const dueAtMs = getLifecycleDueAtMs(session);
  const isInactive = nowMs >= dueAtMs;

  if (!isInactive) {
    return { action: "skipped", reason: "not-due-yet" };
  }

  try {
    await updateSession(sessionId, {
      lifecycleState: "hibernating",
      lifecycleError: null,
    });

    const { connectSandbox } = await import("@open-harness/sandbox");
    const sandbox = await connectSandbox(
      sandboxState as Parameters<typeof connectSandbox>[0],
    );
    if (!sandbox.snapshot) {
      await updateSession(sessionId, {
        ...buildActiveLifecycleUpdate(sandboxState),
      });
      return { action: "skipped", reason: "snapshot-not-supported" };
    }

    let snapshot: { snapshotId: string };
    try {
      snapshot = await sandbox.snapshot();
    } catch (snapshotError) {
      if (isSnapshotAlreadyInProgressError(snapshotError)) {
        const refreshedSession = await getSessionById(sessionId);
        if (
          refreshedSession?.sandboxState &&
          canOperateOnSandbox(refreshedSession.sandboxState)
        ) {
          await updateSession(sessionId, {
            ...buildActiveLifecycleUpdate(refreshedSession.sandboxState),
          });
        } else {
          await updateSession(sessionId, {
            ...buildHibernatedLifecycleUpdate(),
          });
        }
        console.log(
          `[Lifecycle] Snapshot already in progress for session ${sessionId}; treating as idempotent.`,
        );
        return { action: "skipped", reason: "snapshot-already-in-progress" };
      }
      throw snapshotError;
    }

    const snapshotCreatedAt = new Date();

    await updateSession(sessionId, {
      snapshotUrl: snapshot.snapshotId,
      snapshotCreatedAt,
      sandboxState: clearSandboxState(sandboxState),
      ...buildHibernatedLifecycleUpdate(),
    });
    console.log(
      `[Lifecycle] Hibernated sandbox for session ${sessionId} (reason=${reason}, snapshotId=${snapshot.snapshotId}).`,
    );
    return { action: "hibernated" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleRunId: null,
      lifecycleError: message,
    });
    console.error(
      `[Lifecycle] Failed to evaluate sandbox lifecycle for session ${sessionId}:`,
      error,
    );
    return { action: "failed", reason: message };
  }
}

export {
  buildActiveLifecycleUpdate,
  buildHibernatedLifecycleUpdate,
  getNextLifecycleVersion,
  getLifecycleDueAtMs,
  getSandboxExpiresAtDate,
  getSandboxExpiresAtMs,
};
export type { SandboxLifecycleEvaluationResult, SandboxLifecycleReason };
