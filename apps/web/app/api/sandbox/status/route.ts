import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import { SANDBOX_EXPIRES_BUFFER_MS } from "@/lib/sandbox/config";
import {
  getLifecycleDueAtMs,
  getSandboxExpiresAtDate,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";

export type SandboxStatusResponse = {
  status: "active" | "no_sandbox";
  hasSnapshot: boolean;
  lifecycleVersion: number;
  lifecycle: {
    serverTime: number;
    state: string | null;
    lastActivityAt: number | null;
    hibernateAfter: number | null;
    sandboxExpiresAt: number | null;
  };
};

export async function GET(req: Request): Promise<Response> {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  let effectiveSessionRecord = sessionRecord;

  const hasActiveLifecycleState =
    sessionRecord.lifecycleState === "active" ||
    sessionRecord.lifecycleState === "provisioning" ||
    sessionRecord.lifecycleState === "restoring";
  const hasTrackedSandboxState =
    sessionRecord.sandboxState !== null ||
    sessionRecord.sandboxExpiresAt !== null;

  // Check expiry: the DB may still indicate an active lifecycle even after the
  // underlying runtime timed out.
  let isExpired = false;
  if (sessionRecord.sandboxExpiresAt) {
    isExpired =
      Date.now() >=
      sessionRecord.sandboxExpiresAt.getTime() - SANDBOX_EXPIRES_BUFFER_MS;
  }

  const hasRecoverableFailedLifecycle =
    sessionRecord.lifecycleState === "failed" &&
    hasTrackedSandboxState &&
    !isExpired;
  const isActive =
    (hasActiveLifecycleState && hasTrackedSandboxState && !isExpired) ||
    hasRecoverableFailedLifecycle;

  // If the lifecycle evaluator previously failed but runtime state is still
  // active, recover lifecycle state so UI does not get stuck in "Paused".
  if (hasRecoverableFailedLifecycle) {
    const recoveredSession = await updateSession(sessionRecord.id, {
      lifecycleState: "active",
      lifecycleError: null,
      sandboxExpiresAt: getSandboxExpiresAtDate(sessionRecord.sandboxState),
    });
    if (recoveredSession) {
      effectiveSessionRecord = recoveredSession;
    }
  }

  // Safety net: if the sandbox has stale runtime state (expired or overdue for
  // hibernation), kick the lifecycle to clean up DB state in the background.
  if (effectiveSessionRecord.lifecycleState === "active") {
    const now = Date.now();
    const dueAtMs = getLifecycleDueAtMs(effectiveSessionRecord);
    if (isExpired || now >= dueAtMs) {
      kickSandboxLifecycleWorkflow({
        sessionId: effectiveSessionRecord.id,
        reason: "status-check-overdue",
      });
    }
  }

  return Response.json({
    status: isActive ? "active" : "no_sandbox",
    hasSnapshot: !!effectiveSessionRecord.snapshotUrl,
    lifecycleVersion: effectiveSessionRecord.lifecycleVersion,
    lifecycle: {
      serverTime: Date.now(),
      state: effectiveSessionRecord.lifecycleState,
      lastActivityAt: effectiveSessionRecord.lastActivityAt?.getTime() ?? null,
      hibernateAfter: effectiveSessionRecord.hibernateAfter?.getTime() ?? null,
      sandboxExpiresAt:
        effectiveSessionRecord.sandboxExpiresAt?.getTime() ?? null,
    },
  } satisfies SandboxStatusResponse);
}
