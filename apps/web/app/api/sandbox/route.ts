import { connectVercelSandbox } from "@open-harness/sandbox";
import type { Sandbox } from "@open-harness/sandbox";
import { nanoid } from "nanoid";
import { getUserGitHubToken } from "@/lib/github/user-token";
import { getServerSession } from "@/lib/session/get-server-session";
import { getTaskById, updateTask } from "@/lib/db/tasks";
import { createTaskDiff, getLatestTaskDiff } from "@/lib/db/task-diffs";
import { captureSandboxState } from "@/lib/sandbox/capture-state";
import { restoreSandboxState } from "@/lib/sandbox/restore-state";

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  taskId?: string;
  sandboxId?: string; // Existing sandbox ID if any
}

async function captureAndStoreTaskDiff(sandbox: Sandbox, taskId: string) {
  try {
    const state = await captureSandboxState(sandbox);
    const hasChanges =
      state.diffContent.trim().length > 0 || state.untrackedFiles.length > 0;

    if (!hasChanges) {
      return;
    }

    const baseCommit = state.baseCommit.trim();
    await createTaskDiff({
      id: nanoid(),
      taskId,
      diffContent: state.diffContent,
      untrackedFiles: state.untrackedFiles,
      baseCommit: baseCommit.length > 0 ? baseCommit : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to capture sandbox state in beforeStop:", message);
  }
}

export async function POST(req: Request) {
  let body: CreateSandboxRequest;
  try {
    body = (await req.json()) as CreateSandboxRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    repoUrl,
    branch = "main",
    isNewBranch = false,
    taskId,
    sandboxId: providedSandboxId,
  } = body;

  // Get user's GitHub token
  const githubToken = await getUserGitHubToken();
  if (!githubToken) {
    return Response.json({ error: "GitHub not connected" }, { status: 401 });
  }

  // Get session for git user info
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let taskSandboxId = providedSandboxId;

  if (taskId) {
    const task = await getTaskById(taskId);
    if (!task) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.userId !== session.user.id) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (task.sandboxId) {
      if (providedSandboxId && task.sandboxId !== providedSandboxId) {
        return Response.json(
          { error: "Sandbox does not belong to this task" },
          { status: 403 },
        );
      }
      taskSandboxId = task.sandboxId;
    } else if (providedSandboxId) {
      return Response.json(
        { error: "Sandbox does not belong to this task" },
        { status: 403 },
      );
    }
  }

  // Determine if we should create a new branch
  // Only create new branch on first sandbox creation (no existing sandboxId)
  const shouldCreateNewBranch = isNewBranch && !taskSandboxId;

  // Build sandbox options - source is only included when repoUrl is provided
  const sandboxOptions: Parameters<typeof connectVercelSandbox>[0] = {
    timeout: DEFAULT_TIMEOUT,
    gitUser: {
      name: session.user.name ?? session.user.username,
      email:
        session.user.email ??
        `${session.user.username}@users.noreply.github.com`,
    },
    env: {
      GITHUB_TOKEN: githubToken,
    },
  };

  if (taskId) {
    sandboxOptions.hooks = {
      beforeStop: async (sandboxInstance) => {
        await captureAndStoreTaskDiff(sandboxInstance, taskId);
      },
    };
  }

  // Only add source when we have a repo to clone
  if (repoUrl) {
    sandboxOptions.source = {
      url: repoUrl,
      token: githubToken,
      // If creating new branch: don't specify branch (clone default), use newBranch
      // Otherwise: clone the specified branch
      ...(shouldCreateNewBranch ? { newBranch: branch } : { branch }),
    };
  }

  const sandbox = await connectVercelSandbox(sandboxOptions);

  // Restore workspace state if available
  let stateRestored: boolean | undefined;
  let stateRestoreError: string | undefined;
  if (taskId) {
    try {
      const latestDiff = await getLatestTaskDiff(taskId);
      if (latestDiff) {
        const restoreResult = await restoreSandboxState(sandbox, latestDiff);
        if (restoreResult.success) {
          stateRestored = true;
        } else {
          stateRestored = false;
          stateRestoreError = restoreResult.error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stateRestored = false;
      stateRestoreError = message;
      console.warn("Failed to restore sandbox state:", message);
    }
  }

  // Update task with latest sandboxId
  if (taskId && sandbox.id !== taskSandboxId) {
    await updateTask(taskId, { sandboxId: sandbox.id });
  }

  return Response.json({
    sandboxId: sandbox.id,
    createdAt: Date.now(),
    timeout: DEFAULT_TIMEOUT,
    currentBranch: sandbox.currentBranch,
    ...(stateRestored !== undefined && { stateRestored }),
    ...(stateRestoreError && { stateRestoreError }),
  });
}

export async function DELETE(req: Request) {
  // Validate session
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("sandboxId" in body) ||
    typeof (body as Record<string, unknown>).sandboxId !== "string" ||
    !("taskId" in body) ||
    typeof (body as Record<string, unknown>).taskId !== "string"
  ) {
    return Response.json(
      { error: "Missing sandboxId or taskId" },
      { status: 400 },
    );
  }

  const { sandboxId, taskId } = body as { sandboxId: string; taskId: string };

  const task = await getTaskById(taskId);
  if (!task) {
    return Response.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (task.sandboxId !== sandboxId) {
    return Response.json(
      { error: "Sandbox does not belong to this task" },
      { status: 403 },
    );
  }

  const sandbox = await connectVercelSandbox({
    sandboxId,
    hooks: {
      beforeStop: async (sandboxInstance) => {
        await captureAndStoreTaskDiff(sandboxInstance, taskId);
      },
    },
  });
  await sandbox.stop();

  return Response.json({ success: true });
}
