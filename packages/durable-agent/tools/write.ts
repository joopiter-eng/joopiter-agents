import { tool } from "ai";
import { z } from "zod";
import type { DurableAgentContext } from "../types";
import {
  dirnamePath,
  getApprovalConfig,
  getWorkingDirectory,
  pathNeedsApproval,
  resolvePathFromWorkingDirectory,
  shouldAutoApprove,
  toDisplayPath,
} from "./utils";

const writeInputSchema = z.object({
  filePath: z.string(),
  content: z.string(),
});

const editInputSchema = z.object({
  filePath: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
  startLine: z.number().optional(),
});

async function executeWriteFileStep(
  context: DurableAgentContext,
  filePath: string,
  content: string,
) {
  "use step";

  const { connectSandbox } = await import("@open-harness/sandbox");
  const sandbox = await connectSandbox(context.sandbox.state, {
    env: context.sandbox.env,
    ports: context.sandbox.ports,
    timeout: context.sandbox.timeout,
    baseSnapshotId: context.sandbox.baseSnapshotId,
  });
  const workingDirectory = getWorkingDirectory(context);

  try {
    const absolutePath = resolvePathFromWorkingDirectory(
      filePath,
      workingDirectory,
    );
    const dir = dirnamePath(absolutePath);
    await sandbox.mkdir(dir, { recursive: true });
    await sandbox.writeFile(absolutePath, content, "utf-8");
    const stats = await sandbox.stat(absolutePath);

    return {
      success: true,
      path: toDisplayPath(absolutePath, workingDirectory),
      bytesWritten: stats.size,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function executeEditFileStep(
  context: DurableAgentContext,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
) {
  "use step";

  const { connectSandbox } = await import("@open-harness/sandbox");
  const sandbox = await connectSandbox(context.sandbox.state, {
    env: context.sandbox.env,
    ports: context.sandbox.ports,
    timeout: context.sandbox.timeout,
    baseSnapshotId: context.sandbox.baseSnapshotId,
  });
  const workingDirectory = getWorkingDirectory(context);

  try {
    if (oldString === newString) {
      return {
        success: false,
        error: "oldString and newString must be different",
      };
    }

    const absolutePath = resolvePathFromWorkingDirectory(
      filePath,
      workingDirectory,
    );
    const content = await sandbox.readFile(absolutePath, "utf-8");

    if (!content.includes(oldString)) {
      return {
        success: false,
        error: "oldString not found in file",
        hint: "Make sure to match exact whitespace and indentation",
      };
    }

    const occurrences = content.split(oldString).length - 1;
    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        error: `oldString found ${occurrences} times. Use replaceAll=true or provide more context to make it unique.`,
      };
    }

    const matchIndex = content.indexOf(oldString);
    const startLine = content.slice(0, matchIndex).split("\n").length;
    const newContent = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);

    await sandbox.writeFile(absolutePath, newContent, "utf-8");

    return {
      success: true,
      path: toDisplayPath(absolutePath, workingDirectory),
      replacements: replaceAll ? occurrences : 1,
      startLine,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to edit file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const writeFileTool = (context: DurableAgentContext) =>
  tool({
    needsApproval: (args) => {
      const approval = getApprovalConfig(context);
      const workingDirectory = getWorkingDirectory(context);

      if (shouldAutoApprove(approval)) {
        return false;
      }

      if (approval.type !== "interactive") {
        return false;
      }

      return pathNeedsApproval({
        path: args.filePath,
        tool: "write",
        approval,
        workingDirectory,
      });
    },
    description: `Write content to a file on the filesystem.`,
    inputSchema: writeInputSchema,
    execute: async ({ filePath, content }) =>
      executeWriteFileStep(context, filePath, content),
  });

export const editFileTool = (context: DurableAgentContext) =>
  tool({
    needsApproval: (args) => {
      const approval = getApprovalConfig(context);
      const workingDirectory = getWorkingDirectory(context);

      if (shouldAutoApprove(approval)) {
        return false;
      }

      if (approval.type !== "interactive") {
        return false;
      }

      return pathNeedsApproval({
        path: args.filePath,
        tool: "edit",
        approval,
        workingDirectory,
      });
    },
    description: `Perform exact string replacement in a file.`,
    inputSchema: editInputSchema,
    execute: async ({ filePath, oldString, newString, replaceAll = false }) =>
      executeEditFileStep(context, filePath, oldString, newString, replaceAll),
  });
