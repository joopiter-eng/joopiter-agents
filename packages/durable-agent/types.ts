import { z } from "zod";
import type { ProviderOptionsByProvider } from "./models";
import type { SkillMetadata, SkillPromptMetadata } from "./skills/types";

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().describe("The task description"),
  status: todoStatusSchema.describe(
    "Current status. Only ONE task should be in_progress at a time.",
  ),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * Approval configuration using a discriminated union that makes the trust model explicit.
 */
export type ApprovalConfig =
  | {
      type: "interactive";
      autoApprove: "off" | "edits" | "all";
      sessionRules: ApprovalRule[];
    }
  | { type: "background" }
  | { type: "delegated" };

export interface DurableModelConfig {
  modelId: string;
  providerOptionsOverrides?: ProviderOptionsByProvider;
}

export interface DurableSource {
  repo: string;
  branch?: string;
  token?: string;
  newBranch?: string;
}

export interface DurableFileEntry {
  type: "file" | "directory" | "symlink";
  content?: string;
  encoding?: "base64";
  mode?: number;
  target?: string;
}

export type DurablePendingOperation =
  | { type: "writeFile"; path: string; content: string }
  | { type: "mkdir"; path: string; recursive: boolean };

export type DurableSandboxState =
  | {
      type: "just-bash";
      source?: DurableSource;
      files?: Record<string, DurableFileEntry>;
      workingDirectory?: string;
      env?: Record<string, string>;
    }
  | {
      type: "vercel";
      source?: DurableSource;
      sandboxId?: string;
      snapshotId?: string;
      expiresAt?: number;
    }
  | {
      type: "hybrid";
      files?: Record<string, DurableFileEntry>;
      workingDirectory?: string;
      env?: Record<string, string>;
      source?: DurableSource;
      sandboxId?: string;
      snapshotId?: string;
      pendingOperations?: DurablePendingOperation[];
      expiresAt?: number;
    };

export interface DurableSandboxConfig {
  state: DurableSandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  env?: Record<string, string>;
  ports?: number[];
  timeout?: number;
  baseSnapshotId?: string;
}

export interface DurableAgentContext {
  sandbox: DurableSandboxConfig;
  approval: ApprovalConfig;
  skills?: SkillMetadata[];
  skillSuggestions?: SkillPromptMetadata[];
  model: DurableModelConfig;
  subagentModel?: DurableModelConfig;
}

/**
 * Approval rules for auto-approving tool operations within a session.
 * Rules are matched against tool arguments to skip manual approval.
 */
export const approvalRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command-prefix"),
    tool: z.literal("bash"),
    prefix: z.string().min(1, "Prefix cannot be empty"),
  }),
  z.object({
    type: z.literal("path-glob"),
    tool: z.enum(["read", "write", "edit", "grep", "glob"]),
    glob: z.string(),
  }),
  z.object({
    type: z.literal("subagent-type"),
    tool: z.literal("task"),
    subagentType: z.enum(["explorer", "executor"]),
  }),
  z.object({
    type: z.literal("skill"),
    tool: z.literal("skill"),
    skillName: z.string().min(1, "Skill name cannot be empty"),
  }),
]);

export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const EVICTION_THRESHOLD_BYTES = 80 * 1024;
