import type { AgentMode } from "../types";
import type { SessionRule, ApprovalRule } from "./session-rules";

/**
 * Mutable global state shared between prepareCall and tool approval functions.
 *
 * This exists because the AI SDK's `needsApproval` callback only receives tool
 * arguments, not `experimental_context`. Since approval functions need access
 * to `workingDirectory` and `mode` to make decisions (e.g., auto-approve in
 * background mode, check if paths are within working directory), we use this
 * global as a workaround.
 *
 * TODO: Remove this once the AI SDK passes context to `needsApproval` functions.
 * At that point, approval functions can read from `experimental_context` directly.
 */
export const sharedContext: {
  workingDirectory: string;
  mode: AgentMode;
  sessionRules: SessionRule[];
} = {
  workingDirectory: process.cwd(),
  mode: "interactive",
  sessionRules: [],
};

/**
 * Add a session rule for auto-approving matching tool requests.
 * Rules are scoped to the current working directory.
 */
export function addSessionRule(rule: ApprovalRule): void {
  sharedContext.sessionRules.push({
    id: crypto.randomUUID(),
    rule,
    scope: { cwd: sharedContext.workingDirectory },
    createdAt: Date.now(),
  });
}

/**
 * Clear all session rules.
 */
export function clearSessionRules(): void {
  sharedContext.sessionRules = [];
}
