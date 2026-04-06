"use client";

import { useState, useMemo } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  XCircle,
  ArrowUpDown,
  List,
} from "lucide-react";
import type {
  PullRequestCheckRun,
  PullRequestCheckState,
} from "@/lib/github/client";
import { cn } from "@/lib/utils";

type GroupMode = "status" | "flat";

const stateOrder: Record<PullRequestCheckState, number> = {
  failed: 0,
  pending: 1,
  passed: 2,
};

const stateLabels: Record<PullRequestCheckState, string> = {
  failed: "Failing",
  pending: "Running",
  passed: "Passed",
};

function StateIcon({
  state,
  className,
}: {
  state: PullRequestCheckState;
  className?: string;
}) {
  if (state === "passed") {
    return (
      <CheckCircle2
        className={cn(
          "h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500",
          className,
        )}
      />
    );
  }
  if (state === "pending") {
    return (
      <Clock3
        className={cn(
          "h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500",
          className,
        )}
      />
    );
  }
  return <XCircle className={cn("h-4 w-4 shrink-0 text-destructive", className)} />;
}

function CheckRunRow({ checkRun }: { checkRun: PullRequestCheckRun }) {
  const inner = (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      <StateIcon state={checkRun.state} />
      <span
        className={cn(
          "truncate text-sm text-foreground",
          checkRun.detailsUrl &&
            "group-hover/check:underline group-hover/check:underline-offset-2",
        )}
      >
        {checkRun.name}
      </span>
    </div>
  );

  if (checkRun.detailsUrl) {
    return (
      /* oxlint-disable-next-line nextjs/no-html-link-for-pages */
      <a
        href={checkRun.detailsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group/check block"
        aria-label={`Open details for ${checkRun.name}`}
      >
        {inner}
      </a>
    );
  }

  return inner;
}

function GroupSection({
  state,
  checkRuns,
  defaultOpen,
}: {
  state: PullRequestCheckState;
  checkRuns: PullRequestCheckRun[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <StateIcon state={state} className="h-3.5 w-3.5" />
        <span>
          {stateLabels[state]} ({checkRuns.length})
        </span>
      </button>
      {open && (
        <ul className="ml-5 space-y-0.5">
          {checkRuns.map((cr, i) => (
            <li key={`${cr.name}-${cr.detailsUrl ?? "no-url"}-${i}`}>
              <CheckRunRow checkRun={cr} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CheckRunsListProps {
  checkRuns: PullRequestCheckRun[];
  checks?: {
    passed: number;
    pending: number;
    failed: number;
  };
}

export function CheckRunsList({ checkRuns, checks }: CheckRunsListProps) {
  const passed = checks?.passed ?? checkRuns.filter((c) => c.state === "passed").length;
  const pending =
    checks?.pending ?? checkRuns.filter((c) => c.state === "pending").length;
  const failed = checks?.failed ?? checkRuns.filter((c) => c.state === "failed").length;

  const allPassing = failed === 0 && pending === 0;

  const [groupMode, setGroupMode] = useState<GroupMode>("status");
  const [detailsOpen, setDetailsOpen] = useState(!allPassing);

  const sorted = useMemo(
    () =>
      [...checkRuns].sort(
        (a, b) => stateOrder[a.state] - stateOrder[b.state],
      ),
    [checkRuns],
  );

  const grouped = useMemo(() => {
    const groups: Partial<Record<PullRequestCheckState, PullRequestCheckRun[]>> = {};
    for (const cr of sorted) {
      (groups[cr.state] ??= []).push(cr);
    }
    return groups;
  }, [sorted]);

  const groupOrder: PullRequestCheckState[] = ["failed", "pending", "passed"];

  if (checkRuns.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      {/* Header row: title + summary + toggle */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setDetailsOpen(!detailsOpen)}
          className="flex min-w-0 items-center gap-2"
        >
          {allPassing ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-500" />
          ) : detailsOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">Checks</span>
          <span className="text-xs text-muted-foreground">
            {passed} passed
            {pending > 0 && `, ${pending} pending`}
            {failed > 0 && `, ${failed} failing`}
          </span>
        </button>

        {/* Group toggle */}
        <button
          type="button"
          onClick={() =>
            setGroupMode(groupMode === "status" ? "flat" : "status")
          }
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={
            groupMode === "status"
              ? "Switch to flat list"
              : "Switch to grouped by status"
          }
          title={
            groupMode === "status" ? "Flat list" : "Group by status"
          }
        >
          {groupMode === "status" ? (
            <List className="h-3.5 w-3.5" />
          ) : (
            <ArrowUpDown className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Details */}
      {detailsOpen && (
        <div className="mt-2 max-h-48 overflow-y-auto">
          {groupMode === "status" ? (
            <div className="space-y-1">
              {groupOrder.map((state) => {
                const runs = grouped[state];
                if (!runs || runs.length === 0) return null;
                return (
                  <GroupSection
                    key={state}
                    state={state}
                    checkRuns={runs}
                    defaultOpen={state !== "passed" || allPassing}
                  />
                );
              })}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {sorted.map((cr, i) => (
                <li key={`${cr.name}-${cr.detailsUrl ?? "no-url"}-${i}`}>
                  <CheckRunRow checkRun={cr} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
