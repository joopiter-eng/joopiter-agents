import { getRun } from "workflow/api";
import {
  getChatById,
  getSessionById,
  updateChatWorkflowRuntime,
} from "@/lib/db/sessions";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { chatId } = await context.params;
  const chat = await getChatById(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord || sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!chat.workflowRunId) {
    return Response.json({ success: true });
  }

  try {
    const run = getRun(chat.workflowRunId);
    await run.cancel();
  } catch (error) {
    console.error(
      `[chat] Failed to cancel workflow run ${chat.workflowRunId}:`,
      error,
    );
  }

  await updateChatWorkflowRuntime(chatId, {
    workflowRunId: null,
    workflowState: "cancelled",
    workflowError: null,
    activeStreamId: null,
  });

  return Response.json({ success: true });
}
