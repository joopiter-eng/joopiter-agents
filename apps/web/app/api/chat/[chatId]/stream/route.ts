import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return new Response("Not authenticated", { status: 401 });
  }

  const { chatId } = await context.params;
  const chat = await getChatById(chatId);
  if (!chat) {
    return new Response("Chat not found", { status: 404 });
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord || sessionRecord.userId !== session.user.id) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!chat.workflowRunId || !chat.activeStreamId) {
    return new Response(null, { status: 204 });
  }

  const { searchParams } = new URL(request.url);
  const startIndexParam = searchParams.get("startIndex");
  const startIndex = startIndexParam
    ? Number.parseInt(startIndexParam, 10)
    : undefined;

  const run = getRun(chat.workflowRunId);
  const stream = run.getReadable<UIMessageChunk>({
    namespace: chat.activeStreamId,
    startIndex,
  });

  return createUIMessageStreamResponse({ stream });
}
