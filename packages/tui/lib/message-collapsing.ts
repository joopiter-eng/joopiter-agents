/**
 * Message collapsing utilities for grouping consecutive read/search tool calls.
 * This reduces visual clutter and improves performance for completed messages.
 */
import type { TUIAgentUIMessagePart, TUIAgentUIToolPart } from "../types";
import { isToolUIPart } from "ai";

/** Tool types that can be collapsed when consecutive */
export type CollapsibleToolType = "tool-read" | "tool-glob" | "tool-grep";

/** A group of collapsed consecutive tool calls */
export type CollapsedGroup = {
  type: "collapsed-group";
  toolType: CollapsibleToolType;
  count: number;
  summary: string;
  parts: TUIAgentUIToolPart[];
};

/** Either a regular part or a collapsed group */
export type CollapsiblePart = TUIAgentUIMessagePart | CollapsedGroup;

/** Check if a tool type can be collapsed */
function isCollapsibleToolType(type: string): type is CollapsibleToolType {
  return type === "tool-read" || type === "tool-glob" || type === "tool-grep";
}

/** Check if a tool part is complete (has output) */
function isToolComplete(part: TUIAgentUIToolPart): boolean {
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied"
  );
}

/**
 * Generate a summary string for a collapsed group.
 */
export function generateCollapsedSummary(
  toolType: CollapsibleToolType,
  parts: TUIAgentUIToolPart[],
): string {
  const count = parts.length;

  switch (toolType) {
    case "tool-read": {
      // Extract file names
      const files = parts
        .map((p) => {
          const input = p.input as { filePath?: string } | undefined;
          const filePath = input?.filePath;
          if (!filePath) return null;
          // Get basename
          return filePath.split("/").pop();
        })
        .filter(Boolean);

      if (files.length === 1) {
        return `Read ${files[0]}`;
      }
      if (files.length === 2) {
        return `Read ${files[0]} and ${files[1]}`;
      }
      if (files.length === 3) {
        return `Read ${files[0]}, ${files[1]}, and ${files[2]}`;
      }
      return `Read ${count} files`;
    }

    case "tool-glob": {
      if (count === 1) {
        const input = parts[0]?.input as { pattern?: string } | undefined;
        return `Glob "${input?.pattern ?? "..."}"`;
      }
      return `${count} glob searches`;
    }

    case "tool-grep": {
      if (count === 1) {
        const input = parts[0]?.input as { pattern?: string } | undefined;
        return `Grep "${input?.pattern ?? "..."}"`;
      }
      return `${count} grep searches`;
    }
  }
}

/**
 * Collapse consecutive completed tool calls of the same collapsible type.
 * Only collapses groups of 2 or more consecutive tools.
 */
export function collapseConsecutiveTools(
  parts: TUIAgentUIMessagePart[],
  isMessageComplete: boolean,
): CollapsiblePart[] {
  // Don't collapse if message is still streaming
  if (!isMessageComplete) {
    return parts;
  }

  const result: CollapsiblePart[] = [];
  let currentGroup: TUIAgentUIToolPart[] = [];
  let currentGroupType: CollapsibleToolType | null = null;

  function flushGroup() {
    if (currentGroup.length === 0) return;

    if (currentGroup.length >= 2 && currentGroupType !== null) {
      // Create collapsed group
      result.push({
        type: "collapsed-group",
        toolType: currentGroupType,
        count: currentGroup.length,
        summary: generateCollapsedSummary(currentGroupType, currentGroup),
        parts: currentGroup,
      });
    } else {
      // Not enough to collapse, add individually
      for (const part of currentGroup) {
        result.push(part);
      }
    }

    currentGroup = [];
    currentGroupType = null;
  }

  for (const part of parts) {
    if (
      isToolUIPart(part) &&
      isCollapsibleToolType(part.type) &&
      isToolComplete(part)
    ) {
      // Check if this continues the current group or starts a new one
      if (currentGroupType === part.type) {
        currentGroup.push(part);
      } else {
        // Flush previous group and start new one
        flushGroup();
        currentGroup = [part];
        currentGroupType = part.type;
      }
    } else {
      // Non-collapsible part, flush any pending group
      flushGroup();
      result.push(part);
    }
  }

  // Flush any remaining group
  flushGroup();

  return result;
}

/**
 * Type guard to check if a part is a collapsed group.
 */
export function isCollapsedGroup(
  part: CollapsiblePart,
): part is CollapsedGroup {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "collapsed-group"
  );
}
