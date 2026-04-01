"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionGitStatus } from "@/hooks/use-session-git-status";
import type { SessionPostTurnPhase } from "@/lib/session/post-turn-phase";

const POST_TURN_REFRESH_DELAYS_MS = [1500, 4000, 8000] as const;
const POST_TURN_OPTIMISTIC_TIMEOUT_MS = 30_000;

type UseAutoCommitStatusParams = {
  autoCommitEnabled: boolean;
  autoCreatePrEnabled: boolean;
  sessionPostTurnPhase: SessionPostTurnPhase | null | undefined;
  gitStatus: SessionGitStatus | null;
  hasExistingPr: boolean;
  refresh: () => void;
};

/**
 * Tracks the navbar's post-stream git automation state.
 *
 * The server now persists a durable `session.postTurnPhase`, but we still keep
 * a local optimistic phase so the current tab can render "Committing..."
 * immediately when the assistant stream closes.
 */
export function useAutoCommitStatus({
  autoCommitEnabled,
  autoCreatePrEnabled,
  sessionPostTurnPhase,
  gitStatus,
  hasExistingPr,
  refresh,
}: UseAutoCommitStatusParams) {
  const [optimisticPhase, setOptimisticPhase] =
    useState<SessionPostTurnPhase | null>(null);
  const serverPhaseSeenRef = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const markAutoCommitStarted = useCallback(() => {
    if (!autoCommitEnabled) {
      return;
    }

    serverPhaseSeenRef.current = false;
    setOptimisticPhase("auto_commit");
  }, [autoCommitEnabled]);

  const activePhase = sessionPostTurnPhase ?? optimisticPhase;
  const hasUncommittedChanges = gitStatus?.hasUncommittedChanges ?? false;
  const hasUnpushedCommits = gitStatus?.hasUnpushedCommits ?? false;

  useEffect(() => {
    if (!sessionPostTurnPhase) {
      if (optimisticPhase && serverPhaseSeenRef.current) {
        serverPhaseSeenRef.current = false;
        setOptimisticPhase(null);
      }
      return;
    }

    serverPhaseSeenRef.current = true;
  }, [sessionPostTurnPhase, optimisticPhase]);

  useEffect(() => {
    if (!autoCommitEnabled && optimisticPhase) {
      serverPhaseSeenRef.current = false;
      setOptimisticPhase(null);
    }
  }, [autoCommitEnabled, optimisticPhase]);

  useEffect(() => {
    if (sessionPostTurnPhase || !optimisticPhase) {
      return;
    }

    if (optimisticPhase === "auto_pr") {
      if (hasExistingPr || (!hasUncommittedChanges && !hasUnpushedCommits)) {
        serverPhaseSeenRef.current = false;
        setOptimisticPhase(null);
      }
      return;
    }

    if (
      optimisticPhase === "auto_commit" &&
      !autoCreatePrEnabled &&
      !hasUncommittedChanges &&
      !hasUnpushedCommits
    ) {
      serverPhaseSeenRef.current = false;
      setOptimisticPhase(null);
    }
  }, [
    sessionPostTurnPhase,
    optimisticPhase,
    hasExistingPr,
    hasUncommittedChanges,
    hasUnpushedCommits,
    autoCreatePrEnabled,
  ]);

  useEffect(() => {
    if (!activePhase) {
      return;
    }

    const refreshTimeouts = POST_TURN_REFRESH_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        refreshRef.current();
      }, delay),
    );

    const fallbackTimeout = setTimeout(() => {
      if (!sessionPostTurnPhase) {
        serverPhaseSeenRef.current = false;
        setOptimisticPhase(null);
      }
    }, POST_TURN_OPTIMISTIC_TIMEOUT_MS);

    return () => {
      for (const timeout of refreshTimeouts) {
        clearTimeout(timeout);
      }
      clearTimeout(fallbackTimeout);
    };
  }, [activePhase, sessionPostTurnPhase]);

  return {
    postTurnPhase: activePhase,
    isAutoCommitting: activePhase === "auto_commit",
    isAutoCreatingPr: activePhase === "auto_pr",
    markAutoCommitStarted,
  } as const;
}
