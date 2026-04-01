import { connectSandbox } from "@open-harness/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  requireOwnedSessionWithSandboxGuard,
} from "@/app/api/sessions/_lib/session-context";
import { buildSessionSandboxName, updateSession } from "@/lib/db/sessions";
import {
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  buildHibernatedLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  canOperateOnSandbox,
  clearSandboxState,
  hasPersistentSandboxState,
  hasRuntimeSandboxState,
  isSandboxUnavailableError,
} from "@/lib/sandbox/utils";

interface CreateSnapshotRequest {
  sessionId: string;
}

interface RestoreSnapshotRequest {
  sessionId: string;
}

/**
 * POST - Create a snapshot of the sandbox filesystem.
 * IMPORTANT: This automatically stops the sandbox after snapshot creation.
 */
export async function POST(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: CreateSnapshotRequest;
  try {
    body = (await req.json()) as CreateSnapshotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    userId: authResult.userId,
    sessionId,
    sandboxGuard: canOperateOnSandbox,
    sandboxErrorMessage: "Sandbox not initialized",
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  try {
    const sandbox = await connectSandbox(sandboxState);

    if (!sandbox.snapshot) {
      return Response.json(
        { error: "Snapshot not supported by this sandbox type" },
        { status: 400 },
      );
    }

    // Create snapshot (automatically stops the sandbox)
    const result = await sandbox.snapshot();

    // Update session with snapshot info (now stores snapshotId instead of downloadUrl)
    // Also clear sandbox state but preserve the type for future restoration
    const clearedState = clearSandboxState(sessionRecord.sandboxState);

    await updateSession(sessionId, {
      snapshotUrl: result.snapshotId,
      snapshotCreatedAt: new Date(),
      sandboxState: clearedState,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildHibernatedLifecycleUpdate(),
    });

    return Response.json({
      snapshotId: result.snapshotId,
      createdAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Failed to create snapshot: ${message}` },
      { status: 500 },
    );
  }
}

/**
 * PUT - Restore a snapshot by creating a new sandbox from it.
 */
export async function PUT(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: RestoreSnapshotRequest;
  try {
    body = (await req.json()) as RestoreSnapshotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

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

  if (!sessionRecord.sandboxState) {
    console.error(
      `[Snapshot Restore] session=${sessionId} error=no_sandbox_state hasSnapshot=${!!sessionRecord.snapshotUrl}`,
    );
    return Response.json(
      { error: "No sandbox state available for restoration" },
      { status: 400 },
    );
  }

  if (sessionRecord.sandboxState.type !== "vercel") {
    return Response.json(
      {
        error:
          "Snapshot restoration is only supported for the current cloud sandbox provider",
      },
      { status: 400 },
    );
  }

  const sandboxState = sessionRecord.sandboxState;
  const sandboxType = sandboxState.type;
  const sandboxName =
    typeof sandboxState.sandboxId === "string" &&
    sandboxState.sandboxId.length > 0
      ? sandboxState.sandboxId
      : buildSessionSandboxName(sessionId);
  const hasLegacySnapshot = Boolean(sessionRecord.snapshotUrl);
  const canResumeNamedSandbox = hasPersistentSandboxState(sandboxState);

  if (
    !hasLegacySnapshot &&
    !canResumeNamedSandbox &&
    hasRuntimeSandboxState(sandboxState)
  ) {
    console.warn(
      `[Snapshot Restore] session=${sessionId} pending=true sandboxType=${sandboxType}`,
    );
    return Response.json(
      {
        error:
          "Sandbox state is still being updated. Please wait a few seconds and try again.",
      },
      { status: 409 },
    );
  }

  if (!hasLegacySnapshot && !canResumeNamedSandbox) {
    console.error(
      `[Snapshot Restore] session=${sessionId} error=no_resume_source sandboxType=${sandboxType}`,
    );
    return Response.json(
      { error: "No resumable sandbox available for this session" },
      { status: 404 },
    );
  }

  if (canOperateOnSandbox(sandboxState)) {
    console.log(
      `[Snapshot Restore] session=${sessionId} already_running=true sandboxType=${sandboxType}`,
    );
    return Response.json({
      success: true,
      alreadyRunning: true,
      restoredFrom: hasLegacySnapshot ? sessionRecord.snapshotUrl : sandboxName,
    });
  }

  const resumeNamedSandbox = async () =>
    connectSandbox({
      state: { type: sandboxType, sandboxId: sandboxName },
      options: {
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        ports: DEFAULT_SANDBOX_PORTS,
        resume: true,
      },
    });

  const restoreLegacySnapshot = async () => {
    if (!sessionRecord.snapshotUrl) {
      throw new Error("No legacy snapshot available for restoration");
    }

    return connectSandbox({
      state: {
        type: sandboxType,
        sandboxId: sandboxName,
        snapshotId: sessionRecord.snapshotUrl,
      },
      options: {
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        ports: DEFAULT_SANDBOX_PORTS,
        restoreSnapshot: true,
      },
    });
  };

  try {
    let sandbox: Awaited<ReturnType<typeof connectSandbox>>;
    let restoredFrom = sandboxName;

    if (canResumeNamedSandbox) {
      try {
        sandbox = await resumeNamedSandbox();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!hasLegacySnapshot || !isSandboxUnavailableError(message)) {
          throw error;
        }

        sandbox = await restoreLegacySnapshot();
        restoredFrom = sessionRecord.snapshotUrl ?? sandboxName;
      }
    } else {
      sandbox = await restoreLegacySnapshot();
      restoredFrom = sessionRecord.snapshotUrl ?? sandboxName;
    }

    const newState = sandbox.getState?.();
    const restoredState = (newState ?? {
      type: sandboxType,
      sandboxId: sandboxName,
    }) as Parameters<typeof updateSession>[1]["sandboxState"];

    await updateSession(sessionId, {
      sandboxState: restoredState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildActiveLifecycleUpdate(restoredState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "snapshot-restored",
    });

    console.log(
      `[Snapshot Restore] session=${sessionId} success=true sandboxType=${sandboxType} sandboxId=${"id" in sandbox ? sandbox.id : "n/a"} restoredFrom=${restoredFrom}`,
    );

    return Response.json({
      success: true,
      restoredFrom,
      sandboxId: "id" in sandbox ? sandbox.id : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[Snapshot Restore] session=${sessionId} success=false error=${message}`,
    );
    return Response.json(
      { error: `Failed to restore snapshot: ${message}` },
      { status: 500 },
    );
  }
}
