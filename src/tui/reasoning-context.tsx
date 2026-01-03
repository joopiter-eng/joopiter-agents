import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

type ReasoningDuration = {
  startTime: number;
  endTime?: number;
};

type ReasoningContextValue = {
  isExpanded: boolean;
  toggleExpanded: () => void;
  startReasoning: (messageId: string) => void;
  endReasoning: (messageId: string) => void;
  getReasoningDuration: (messageId: string) => number;
};

const ReasoningContext = createContext<ReasoningContextValue | undefined>(
  undefined
);

export function ReasoningProvider({ children }: { children: ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const durationsRef = useRef<Map<string, ReasoningDuration>>(new Map());

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const startReasoning = useCallback((messageId: string) => {
    if (!durationsRef.current.has(messageId)) {
      durationsRef.current.set(messageId, { startTime: Date.now() });
    }
  }, []);

  const endReasoning = useCallback((messageId: string) => {
    const duration = durationsRef.current.get(messageId);
    if (duration && !duration.endTime) {
      duration.endTime = Date.now();
    }
  }, []);

  const getReasoningDuration = useCallback((messageId: string): number => {
    const duration = durationsRef.current.get(messageId);
    if (!duration) return 0;
    const endTime = duration.endTime ?? Date.now();
    return Math.max(1, Math.round((endTime - duration.startTime) / 1000));
  }, []);

  return (
    <ReasoningContext.Provider
      value={{
        isExpanded,
        toggleExpanded,
        startReasoning,
        endReasoning,
        getReasoningDuration,
      }}
    >
      {children}
    </ReasoningContext.Provider>
  );
}

export function useReasoningContext() {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error(
      "useReasoningContext must be used within a ReasoningProvider"
    );
  }
  return context;
}
