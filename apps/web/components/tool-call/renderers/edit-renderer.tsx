"use client";

import { toRelativePath } from "@open-harness/shared/lib/tool-state";
import { MultiFileDiff } from "@pierre/diffs/react";
import { Loader2 } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { defaultDiffOptions } from "@/lib/diffs-config";
import { cn } from "@/lib/utils";
import { ApprovalButtons } from "../approval-buttons";

export function EditRenderer({
  part,
  state,
  cwd = "",
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-edit">) {
  const [isExpanded, setIsExpanded] = useState(false);
  const input = part.input;
  const rawFilePath = input?.filePath ?? "...";
  const filePath =
    rawFilePath === "..." ? rawFilePath : toRelativePath(rawFilePath, cwd);
  const oldString = input?.oldString ?? "";
  const newString = input?.newString ?? "";

  const output = part.state === "output-available" ? part.output : undefined;
  const outputError =
    output?.success === false ? (output?.error ?? "Edit failed") : undefined;

  const mergedState = outputError
    ? { ...state, error: state.error ?? outputError }
    : state;

  const showDiff =
    mergedState.approvalRequested ||
    (!mergedState.running && !mergedState.error && !mergedState.denied);

  const dotColor = mergedState.denied
    ? "bg-red-500"
    : mergedState.approvalRequested
      ? "bg-yellow-500"
      : mergedState.running
        ? "bg-yellow-500"
        : mergedState.error
          ? "bg-red-500"
          : "bg-green-500";

  const hasExpandableContent = oldString.length > 200 || newString.length > 200;

  const handleClick = () => {
    if (hasExpandableContent) {
      setIsExpanded((current) => !current);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Enter" || e.key === " ") && hasExpandableContent) {
      e.preventDefault();
      setIsExpanded((current) => !current);
    }
  };

  const headerInteractionProps = hasExpandableContent
    ? {
        onClick: handleClick,
        onKeyDown: handleKeyDown,
        role: "button" as const,
        tabIndex: 0,
        "aria-expanded": isExpanded,
      }
    : {};

  return (
    <div className="my-2 rounded-lg border border-border bg-card p-3">
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          hasExpandableContent && "cursor-pointer",
        )}
        {...headerInteractionProps}
      >
        {mergedState.interrupted ? (
          <span className="inline-block h-2 w-2 rounded-full border border-yellow-500" />
        ) : mergedState.running ? (
          <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
        ) : (
          <span className={cn("inline-block h-2 w-2 rounded-full", dotColor)} />
        )}
        <span className="font-medium text-foreground">Update</span>
        <span className="text-muted-foreground">(</span>
        <span className="truncate text-sm text-foreground">{filePath}</span>
        <span className="text-muted-foreground">)</span>
      </div>

      {mergedState.approvalRequested && mergedState.isActiveApproval && (
        <div className="mt-2 pl-5 text-sm text-muted-foreground">
          Running...
        </div>
      )}

      {mergedState.approvalRequested &&
        !mergedState.isActiveApproval &&
        mergedState.approvalId && (
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <ApprovalButtons
              approvalId={mergedState.approvalId}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          </div>
        )}

      {showDiff && !mergedState.approvalRequested && !mergedState.denied && (
        <div
          className={cn(
            "ml-5 mt-2",
            isExpanded ? "max-h-96 overflow-auto" : "max-h-40 overflow-hidden",
          )}
        >
          <MultiFileDiff
            oldFile={{ name: rawFilePath, contents: oldString }}
            newFile={{ name: rawFilePath, contents: newString }}
            options={defaultDiffOptions}
          />
        </div>
      )}

      {mergedState.denied && (
        <div className="mt-2 pl-5 text-sm text-red-500">
          Denied
          {mergedState.denialReason ? `: ${mergedState.denialReason}` : ""}
        </div>
      )}

      {mergedState.error && !mergedState.denied && (
        <div className="mt-2 pl-5 text-sm text-red-500">
          Error: {mergedState.error.slice(0, 80)}
        </div>
      )}

      {mergedState.interrupted && (
        <div className="mt-2 pl-5 text-sm text-yellow-500">Interrupted</div>
      )}
    </div>
  );
}
