const CHAT_STEP_PRE_TIMEOUT_MS = 730_000;

export function createChatStepAbortLifecycle(): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(new Error("Chat step timed out before platform limit."));
  }, CHAT_STEP_PRE_TIMEOUT_MS);

  let cleaned = false;

  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearTimeout(timeoutHandle);
    },
  };
}
