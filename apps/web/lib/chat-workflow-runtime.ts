import "server-only";

import { getRun } from "workflow/api";
import { getChatById, updateChatWorkflowRuntime } from "@/lib/db/sessions";

export async function cancelChatWorkflowRun(
  workflowRunId: string | null | undefined,
): Promise<void> {
  if (!workflowRunId) {
    return;
  }

  try {
    await getRun(workflowRunId).cancel();
  } catch (error) {
    console.warn(
      `[chat-workflow] Failed to cancel workflow run ${workflowRunId}:`,
      error,
    );
  }
}

export async function resetChatWorkflowRuntime(chatId: string): Promise<void> {
  const chat = await getChatById(chatId);
  if (!chat) {
    return;
  }

  await cancelChatWorkflowRun(chat.workflowRunId);
  await updateChatWorkflowRuntime(chatId, {
    workflowRunId: null,
    workflowState: "idle",
    workflowError: null,
    activeStreamId: null,
  });
}
