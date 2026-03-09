import { tool } from "ai";
import { z } from "zod";
import type { DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getWorkingDirectory,
  pathNeedsApproval,
  resolvePath,
  resolvePathFromWorkingDirectory,
  shouldAutoApprove,
  toDisplayPath,
} from "./utils";

const readInputSchema = z.object({
  filePath: z
    .string()
    .describe(
      "Workspace-relative path to the file to read (e.g., src/index.ts)",
    ),
  offset: z.number().optional().describe("Line number to start reading from"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
});

async function resolveReadableFilePath(
  sandbox: {
    access?: (filePath: string) => Promise<void>;
  },
  filePath: string,
  workingDirectory: string,
): Promise<string> {
  const absolutePath = resolvePathFromWorkingDirectory(
    filePath,
    workingDirectory,
  );
  if (typeof sandbox.access !== "function") {
    return absolutePath;
  }

  try {
    await sandbox.access(absolutePath);
    return absolutePath;
  } catch {
    if (
      filePath.startsWith("/") &&
      !filePath.startsWith("/Users/") &&
      !filePath.startsWith("/home/")
    ) {
      const workspaceRelativePath = resolvePath(
        workingDirectory,
        filePath.slice(1),
      );

      try {
        await sandbox.access(workspaceRelativePath);
        return workspaceRelativePath;
      } catch {
        // Ignore fallback failure.
      }
    }
  }

  return absolutePath;
}

async function executeReadFileStep(
  context: DurableAgentContext,
  filePath: string,
  offset: number,
  limit: number,
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
    const absolutePath = await resolveReadableFilePath(
      sandbox,
      filePath,
      workingDirectory,
    );
    const stats = await sandbox.stat(absolutePath);
    if (stats.isDirectory()) {
      return {
        success: false,
        error: "Cannot read a directory. Use glob or ls command instead.",
      };
    }

    const content = await sandbox.readFile(absolutePath, "utf-8");
    const lines = content.split("\n");
    const startLine = Math.max(1, offset) - 1;
    const endLine = Math.min(lines.length, startLine + limit);
    const numberedLines = lines
      .slice(startLine, endLine)
      .map((line, index) => `${startLine + index + 1}: ${line}`);

    return {
      success: true,
      path: toDisplayPath(absolutePath, workingDirectory),
      totalLines: lines.length,
      startLine: startLine + 1,
      endLine,
      content: numberedLines.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const readFileTool = (context: DurableAgentContext) =>
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
        path: resolvePathFromWorkingDirectory(args.filePath, workingDirectory),
        tool: "read",
        approval,
        workingDirectory,
      });
    },
    description: `Read a file from the filesystem.

USAGE:
- Use workspace-relative paths (e.g., "src/index.ts")
- By default reads up to 2000 lines starting from line 1
- Use offset and limit for long files
- Results include line numbers starting at 1 in "N: content" format`,
    inputSchema: readInputSchema,
    execute: async ({ filePath, offset = 1, limit = 2000 }) =>
      executeReadFileStep(context, filePath, offset, limit),
  });
