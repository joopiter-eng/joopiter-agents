import type {
  ChatRequestOptions,
  ChatTransport,
  PrepareReconnectToStreamRequest,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { WorkflowChatTransport } from "@workflow/ai";
import type { FetchFunction } from "@ai-sdk/provider-utils";

type SendMessagesOptions<UI_MESSAGE extends UIMessage> = {
  trigger: "submit-message" | "regenerate-message";
  chatId: string;
  messageId?: string;
  messages: UI_MESSAGE[];
  abortSignal?: AbortSignal;
} & ChatRequestOptions;

type ReconnectToStreamOptions = {
  chatId: string;
  abortSignal?: AbortSignal;
} & ChatRequestOptions;

type BodyFactory = () => Record<string, unknown>;

interface AbortableChatTransportOptions<UI_MESSAGE extends UIMessage> {
  api?: string;
  body?: BodyFactory;
  fetch?: FetchFunction;
  onChatEnd?: ({
    chatId,
    chunkIndex,
  }: {
    chatId: string;
    chunkIndex: number;
  }) => void | Promise<void>;
  onChatSendMessage?: (
    response: Response,
    options: SendMessagesOptions<UI_MESSAGE>,
  ) => void | Promise<void>;
  prepareReconnectToStreamRequest?: PrepareReconnectToStreamRequest;
}

export class AbortableChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private readonly baseTransport: WorkflowChatTransport<UI_MESSAGE>;
  private controller = new AbortController();

  constructor(options: AbortableChatTransportOptions<UI_MESSAGE> = {}) {
    const outerFetch = options.fetch ?? globalThis.fetch;
    const wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      outerFetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([this.controller.signal, init.signal])
          : this.controller.signal,
      })) as FetchFunction;

    this.baseTransport = new WorkflowChatTransport<UI_MESSAGE>({
      api: options.api ?? "/api/chat",
      fetch: wrappedFetch as typeof fetch,
      onChatEnd: options.onChatEnd,
      onChatSendMessage: options.onChatSendMessage,
      prepareSendMessagesRequest: async ({ messages, ...config }) => ({
        ...config,
        body: {
          ...options.body?.(),
          messages,
        },
      }),
      prepareReconnectToStreamRequest: options.prepareReconnectToStreamRequest,
    });
  }

  sendMessages(
    options: SendMessagesOptions<UI_MESSAGE>,
  ): Promise<ReadableStream<UIMessageChunk>> {
    return this.baseTransport.sendMessages(options);
  }

  reconnectToStream(
    options: ReconnectToStreamOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return this.baseTransport.reconnectToStream(options);
  }

  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }
}
