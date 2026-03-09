import { tool } from "ai";
import { z } from "zod";
import type { DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getWorkingDirectory,
  pathNeedsApproval,
  resolvePathFromWorkingDirectory,
  shellEscape,
  shouldAutoApprove,
  toDisplayPath,
} from "./utils";

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

const grepInputSchema = z.object({
  pattern: z.string(),
  path: z.string(),
  glob: z.string().optional(),
  caseSensitive: z.boolean().optional(),
});

async function executeGrepStep(
  context: DurableAgentContext,
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  caseSensitive: boolean,
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
      searchPath,
      workingDirectory,
    );

    const args: string[] = ["grep", "-rn"];
    if (!caseSensitive) args.push("-i");
    args.push(
      `--exclude-dir=${shellEscape(".*")}`,
      `--exclude-dir=${shellEscape("node_modules")}`,
    );
    if (glob) {
      args.push(`--include=${shellEscape(glob)}`);
    }
    args.push(
      "-m",
      "10",
      "-E",
      shellEscape(pattern),
      shellEscape(absolutePath),
    );

    const command = args.join(" ");
    const result = await sandbox.exec(command, workingDirectory, 30_000);
    if (!result.success && result.exitCode !== 1) {
      const errorOutput = (result.stderr || result.stdout).slice(0, 500);
      return {
        success: false,
        error: `Grep failed (exit ${result.exitCode}): ${errorOutput}`,
      };
    }

    const matches: GrepMatch[] = [];
    const filesSet = new Set<string>();
    const fileMatchCounts = new Map<string, number>();

    for (const line of result.stdout.split("\n").filter(Boolean)) {
      if (matches.length >= 100) break;
      const nulIndex = line.indexOf("\0");
      let file: string;
      let rest: string;
      if (nulIndex !== -1) {
        file = line.slice(0, nulIndex);
        rest = line.slice(nulIndex + 1);
      } else {
        const match = line.match(/:(\d+):/);
        if (!match || match.index === undefined) continue;
        file = line.slice(0, match.index);
        rest = line.slice(match.index + 1);
      }
      const colonIndex = rest.indexOf(":");
      if (colonIndex === -1) continue;

      const lineNum = parseInt(rest.slice(0, colonIndex), 10);
      const content = rest.slice(colonIndex + 1);
      if (Number.isNaN(lineNum)) continue;

      const displayFile = toDisplayPath(file, workingDirectory);
      filesSet.add(displayFile);
      const currentFileCount = fileMatchCounts.get(displayFile) ?? 0;
      if (currentFileCount >= 10) continue;
      fileMatchCounts.set(displayFile, currentFileCount + 1);
      matches.push({
        file: displayFile,
        line: lineNum,
        content: content.slice(0, 200),
      });
    }

    const response: Record<string, unknown> = {
      success: true,
      pattern,
      matchCount: matches.length,
      filesWithMatches: filesSet.size,
      matches,
    };

    if (matches.length === 0) {
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
      error: `Grep failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const grepTool = (context: DurableAgentContext) =>
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
        path: args.path,
        tool: "grep",
        approval,
        workingDirectory,
      });
    },
    description: `Search for patterns in files using POSIX Extended Regular Expressions (ERE).`,
    inputSchema: grepInputSchema,
    execute: async ({
      pattern,
      path: searchPath,
      glob,
      caseSensitive = true,
    }) => executeGrepStep(context, pattern, searchPath, glob, caseSensitive),
  });
