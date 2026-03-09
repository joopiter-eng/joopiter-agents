import { Chat } from "@ai-sdk/react";
import type { WebAgentUIMessage } from "@/app/types";

type ChatInstanceInit = ConstructorParameters<
  typeof Chat<WebAgentUIMessage>
>[0];

type ManagedChatInstance = {
  instance: Chat<WebAgentUIMessage>;
};

// Instances are scoped to an active chat route and removed on route teardown.
// This avoids accumulating background streams/message buffers when users switch
// between multiple chats quickly.
const chatInstances = new Map<string, ManagedChatInstance>();

export function getOrCreateChatInstance(
  chatId: string,
  init: ChatInstanceInit,
): {
  instance: Chat<WebAgentUIMessage>;
  alreadyExisted: boolean;
} {
  const existing = chatInstances.get(chatId);
  if (existing) {
    return {
      instance: existing.instance,
      alreadyExisted: true,
    };
  }

  const instance = new Chat<WebAgentUIMessage>(init);
  const managed = {
    instance,
  };
  chatInstances.set(chatId, managed);

  return {
    instance,
    alreadyExisted: false,
  };
}

export function abortChatInstanceTransport(chatId: string): void {
  const managed = chatInstances.get(chatId);
  if (!managed) {
    return;
  }

  void managed.instance.stop();
}

export function removeChatInstance(chatId: string): void {
  chatInstances.delete(chatId);
}
