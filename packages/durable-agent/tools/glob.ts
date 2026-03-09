import { tool } from "ai";
import { z } from "zod";
import type { DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getWorkingDirectory,
  joinPath,
  pathNeedsApproval,
  resolvePathFromWorkingDirectory,
  shellEscape,
  shouldAutoApprove,
  toDisplayPath,
} from "./utils";

interface FileInfo {
  path: string;
  size: number;
  modifiedAt: number;
}

const globInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

async function executeGlobStep(
  context: DurableAgentContext,
  pattern: string,
  basePath: string | undefined,
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
    let searchDir = basePath
      ? resolvePathFromWorkingDirectory(basePath, workingDirectory)
      : workingDirectory;

    const patternParts = pattern.split("/").filter(Boolean);
    const namePattern = patternParts[patternParts.length - 1] ?? "*";

    const literalPrefix: string[] = [];
    for (let index = 0; index < patternParts.length - 1; index += 1) {
      const part = patternParts[index]!;
      if (part.includes("*") || part.includes("?") || part.includes("[")) {
        break;
      }
      literalPrefix.push(part);
    }
    if (literalPrefix.length > 0) {
      searchDir = joinPath(searchDir, ...literalPrefix);
    }

    const remainingDirSegments = patternParts.slice(
      literalPrefix.length,
      patternParts.length - 1,
    );
    const hasRecursiveWildcard =
      remainingDirSegments.some((segment) => segment === "**") ||
      namePattern === "**";
    const maxDepth = hasRecursiveWildcard
      ? undefined
      : remainingDirSegments.length + 1;

    const findArgs = ["find", shellEscape(searchDir)];
    if (maxDepth !== undefined) {
      findArgs.push("-maxdepth", String(maxDepth));
    }
    findArgs.push(
      "-not",
      "-path",
      "'*/.*'",
      "-not",
      "-path",
      "'*/node_modules/*'",
      "-type",
      "f",
      "-name",
      shellEscape(namePattern),
    );

    const findBase = findArgs.join(" ");
    const command = [
      `{ ${findBase} -printf '%T@\\t%s\\t%p\\n' 2>/dev/null`,
      `|| ${findBase} -print0 | xargs -0 stat -f '%m%t%z%t%N' ; }`,
      `| sort -t$'\\t' -k1 -rn | head -n ${limit}`,
    ].join(" ");

    const result = await sandbox.exec(command, workingDirectory, 30_000);
    if (!result.success && result.exitCode !== 1) {
      return {
        success: false,
        error: `Glob failed (exit ${result.exitCode}): ${result.stdout.slice(0, 500)}`,
      };
    }

    const files: FileInfo[] = [];
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const firstTab = line.indexOf("\t");
      if (firstTab === -1) continue;
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (secondTab === -1) continue;
      const mtimeSeconds = parseFloat(line.slice(0, firstTab));
      const size = parseInt(line.slice(firstTab + 1, secondTab), 10);
      const filePath = line.slice(secondTab + 1);
      if (Number.isNaN(mtimeSeconds) || Number.isNaN(size) || !filePath) {
        continue;
      }
      files.push({
        path: toDisplayPath(filePath, workingDirectory),
        size,
        modifiedAt: mtimeSeconds * 1000,
      });
    }

    const response: Record<string, unknown> = {
      success: true,
      pattern,
      baseDir: toDisplayPath(searchDir, workingDirectory),
      count: files.length,
      files: files.map((file) => ({
        path: file.path,
        size: file.size,
        modifiedAt: new Date(file.modifiedAt).toISOString(),
      })),
    };

    if (files.length === 0) {
      response._debug = {
        command,
        exitCode: result.exitCode,
        stdoutPreview: result.stdout.slice(0, 500),
      };
    }

    return response;
  } catch (error) {
    return {
      success: false,
      error: `Glob failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const globTool = (context: DurableAgentContext) =>
  tool({
    needsApproval: (args) => {
      const approval = getApprovalConfig(context);
      const workingDirectory = getWorkingDirectory(context);

      if (shouldAutoApprove(approval)) {
        return false;
      }

      if (!args.path || approval.type !== "interactive") {
        return false;
      }

      return pathNeedsApproval({
        path: args.path,
        tool: "glob",
        approval,
        workingDirectory,
      });
    },
    description: `Find files matching a glob pattern.`,
    inputSchema: globInputSchema,
    execute: async ({ pattern, path: basePath, limit = 100 }) =>
      executeGlobStep(context, pattern, basePath, limit),
  });
