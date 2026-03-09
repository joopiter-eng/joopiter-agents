import { tool } from "ai";
import { z } from "zod";
import type { ApprovalRule, DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getWorkingDirectory,
  isPathWithinDirectory,
  resolvePathFromWorkingDirectory,
  shouldAutoApprove,
} from "./utils";

const TIMEOUT_MS = 120_000;

const bashInputSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Workspace-relative working directory for the command (e.g., apps/web)",
    ),
  detached: z
    .boolean()
    .optional()
    .describe(
      "Use this whenever you want to run a persistent server in the background (e.g., npm run dev, next dev). The command starts and returns immediately without waiting for it to finish.",
    ),
});

type BashInput = z.infer<typeof bashInputSchema>;
type ApprovalFn = (args: BashInput) => boolean | Promise<boolean>;

interface ToolOptions {
  needsApproval?: boolean | ApprovalFn;
}

function cwdIsOutsideWorkingDirectory(
  cwd: string | undefined,
  workingDirectory: string,
): boolean {
  if (!cwd) {
    return false;
  }
  const absoluteCwd = resolvePathFromWorkingDirectory(cwd, workingDirectory);
  return !isPathWithinDirectory(absoluteCwd, workingDirectory);
}

function commandMatchesApprovalRule(
  command: string,
  approvalRules: ApprovalRule[],
): boolean {
  const trimmedCommand = command.trim();
  for (const rule of approvalRules) {
    if (rule.type === "command-prefix" && rule.tool === "bash") {
      if (trimmedCommand.startsWith(rule.prefix)) {
        return true;
      }
    }
  }
  return false;
}

const SAFE_COMMAND_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "rg",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "pwd",
  "echo",
  "which",
  "type",
  "file",
  "wc",
  "tree",
];

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bsudo\b/,
  /\bgit\s+(push|commit|add|reset|checkout|merge|rebase|stash)/,
  /\bnpm\s+(install|uninstall|publish)/,
  /\bpnpm\s+(install|uninstall|publish)/,
  /\byarn\s+(add|remove|publish)/,
  /\bbun\s+(add|remove|install)/,
  /\bpip\s+install/,
  />/,
  /\|/,
  /&&/,
  /;/,
];

export function commandNeedsApproval(command: string): boolean {
  const trimmedCommand = command.trim();

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmedCommand)) {
      return true;
    }
  }

  for (const prefix of SAFE_COMMAND_PREFIXES) {
    if (trimmedCommand.startsWith(prefix)) {
      return false;
    }
  }

  return true;
}

async function executeBashStep(
  context: DurableAgentContext,
  command: string,
  cwd: string | undefined,
  detached: boolean | undefined,
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
  const workingDir = cwd
    ? resolvePathFromWorkingDirectory(cwd, workingDirectory)
    : workingDirectory;

  if (detached) {
    if (!sandbox.execDetached) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr:
          "Detached mode is not supported in this sandbox environment. Only cloud sandboxes support background processes.",
      };
    }

    try {
      const { commandId } = await sandbox.execDetached(command, workingDir);
      return {
        success: true,
        exitCode: null,
        stdout: `Process started in background (command ID: ${commandId}). The server is now running.`,
        stderr: "",
      };
    } catch (error) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const result = await sandbox.exec(command, workingDir, TIMEOUT_MS);
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.truncated && { truncated: true }),
  };
}

export const bashTool = (context: DurableAgentContext, options?: ToolOptions) =>
  tool({
    needsApproval: async (args) => {
      const approval = getApprovalConfig(context);
      const workingDirectory = getWorkingDirectory(context);

      if (shouldAutoApprove(approval)) {
        return false;
      }

      if (commandMatchesApprovalRule(args.command, approval.sessionRules)) {
        return false;
      }

      if (cwdIsOutsideWorkingDirectory(args.cwd, workingDirectory)) {
        return true;
      }

      if (approval.autoApprove === "all") {
        return false;
      }

      if (commandNeedsApproval(args.command)) {
        if (typeof options?.needsApproval === "function") {
          return options.needsApproval(args);
        }
        return options?.needsApproval ?? true;
      }

      return false;
    },
    description: `Execute a bash command in the user's shell (non-interactive).

WHEN TO USE:
- Running existing project commands (build, test, lint, typecheck)
- Using read-only CLI tools (git status, git diff, ls, etc.)
- Invoking language/package managers (npm, pnpm, yarn, pip, go, etc.) as part of the task

WHEN NOT TO USE:
- Reading files (use readFileTool instead)
- Editing or creating files (use editFileTool or writeFileTool instead)
- Searching code or text (use grepTool and/or globTool instead)
- Interactive commands (shells, editors, REPLs)

USAGE:
- Runs bash -c "<command>" in a non-interactive shell (no TTY/PTY)
- Commands automatically run in the working directory by default — do NOT prepend "cd /path &&" to commands
- NEVER prefix commands with "cd <working-directory> &&" or any path — this is the most common mistake and is always wrong
- Use the cwd parameter ONLY with a workspace-relative subdirectory when you need to run in a different directory
- Commands automatically timeout after ~2 minutes
- Combined stdout/stderr output is truncated after ~50,000 characters

IMPORTANT:
- Never chain commands with ';' or '&&' - use separate tool calls for each logical step
- Never use interactive commands (vim, nano, top, bash, ssh, etc.)
- Always quote file paths that may contain spaces
- Setting cwd to a path outside the working directory requires approval
- Use detached: true to start dev servers or other long-running processes in the background`,
    inputSchema: bashInputSchema,
    execute: async ({ command, cwd, detached }) =>
      executeBashStep(context, command, cwd, detached),
  });
