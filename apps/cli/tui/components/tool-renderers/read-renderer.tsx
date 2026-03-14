import React from "react";
import { useChatContext } from "../../chat-context";
import type { ToolRendererProps } from "../../lib/render-tool";
import { ToolLayout, toRelativePath } from "./shared";

export function ReadRenderer({ part, state }: ToolRendererProps<"tool-read">) {
  const { state: chatState } = useChatContext();
  const cwd = chatState.workingDirectory ?? process.cwd();
  const isInputReady = part.state !== "input-streaming";
  const rawFilePath = isInputReady ? (part.input?.filePath ?? "...") : "...";
  const filePath =
    rawFilePath === "..." ? rawFilePath : toRelativePath(rawFilePath, cwd);
  const output = part.state === "output-available" ? part.output : undefined;
  const totalLines = output?.totalLines;
  const startLine = output?.startLine;
  const endLine = output?.endLine;
  const isPartialRead =
    startLine !== undefined &&
    endLine !== undefined &&
    totalLines !== undefined &&
    (startLine > 1 || endLine < totalLines);

  const meta = isPartialRead
    ? `lines ${startLine}–${endLine}`
    : totalLines !== undefined
      ? `${totalLines} lines`
      : undefined;

  return (
    <ToolLayout
      name="Read"
      summary={filePath}
      output={meta && <text fg="white">{meta}</text>}
      state={state}
    />
  );
}
