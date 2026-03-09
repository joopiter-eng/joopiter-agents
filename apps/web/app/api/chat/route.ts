import { createUIMessageStreamResponse } from "ai";
import type { SkillPromptMetadata } from "@open-harness/durable-agent";
import { start } from "workflow/api";
import type { WebAgentUIMessage } from "@/app/types";
import {
  chatWorkflow,
  INITIAL_TURN_STREAM_NAMESPACE,
} from "@/app/workflows/chat";
import {
  createChatMessageIfNotExists,
  getChatById,
  getSessionById,
  isFirstChatMessage,
  touchChat,
  updateChat,
  updateChatWorkflowRuntime,
  updateSession,
} from "@/lib/db/sessions";
import { buildActiveLifecycleUpdate } from "@/lib/sandbox/lifecycle-state";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

interface ChatCompactionContextPayload {
  contextLimit?: number;
}

interface ChatRequestBody {
  messages: WebAgentUIMessage[];
  sessionId?: string;
  chatId?: string;
  context?: ChatCompactionContextPayload;
  skillSuggestions?: SkillPromptMetadata[];
}

function getLatestUserMessage(
  messages: WebAgentUIMessage[],
): WebAgentUIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message;
    }
  }

  return null;
}

async function persistLatestUserMessage(
  chatId: string,
  message: WebAgentUIMessage,
): Promise<void> {
  const created = await createChatMessageIfNotExists({
    id: message.id,
    chatId,
    role: "user",
    parts: message,
  });

  if (created) {
    await touchChat(chatId);
  }

  const shouldSetTitle =
    created !== undefined && (await isFirstChatMessage(chatId, created.id));
  if (!shouldSetTitle) {
    return;
  }

  const title = message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join(" ")
    .trim();

  if (title.length === 0) {
    return;
  }

  await updateChat(chatId, {
    title: title.length > 30 ? `${title.slice(0, 30)}...` : title,
  });
}

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, sessionId, chatId, context, skillSuggestions } = body;
  if (!sessionId || !chatId) {
    return Response.json(
      { error: "sessionId and chatId are required" },
      { status: 400 },
    );
  }

  const [sessionRecord, chat] = await Promise.all([
    getSessionById(sessionId),
    getChatById(chatId),
  ]);

  if (!sessionRecord) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!chat || chat.sessionId !== sessionId) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  const latestUserMessage = getLatestUserMessage(messages);
  if (!latestUserMessage) {
    return Response.json(
      { error: "A user message is required to continue the chat" },
      { status: 400 },
    );
  }

  await Promise.all([
    persistLatestUserMessage(chatId, latestUserMessage),
    updateSession(sessionId, {
      ...buildActiveLifecycleUpdate(sessionRecord.sandboxState, {
        activityAt: new Date(),
      }),
    }),
  ]);

  if (chat.activeStreamId) {
    return Response.json(
      { error: "A response is already streaming for this chat" },
      { status: 409 },
    );
  }

  const run = await start(chatWorkflow, [
    {
      chatId,
      runtime: {
        sessionId: sessionRecord.id,
        userId: sessionRecord.userId,
        sandboxState: sessionRecord.sandboxState,
        branch: sessionRecord.branch,
        modelId: chat.modelId,
        repoOwner: sessionRecord.repoOwner,
      },
      ...(context ? { context } : {}),
      ...(skillSuggestions ? { skillSuggestions } : {}),
    },
  ]);
  const workflowRunId = run.runId;

  await updateChatWorkflowRuntime(chatId, {
    workflowRunId,
    workflowState: "running",
    workflowError: null,
    activeStreamId: INITIAL_TURN_STREAM_NAMESPACE,
  });

  const stream = run.getReadable({
    namespace: INITIAL_TURN_STREAM_NAMESPACE,
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      "x-workflow-run-id": workflowRunId,
    },
  });
}
