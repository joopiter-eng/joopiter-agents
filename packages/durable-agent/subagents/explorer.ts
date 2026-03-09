import type { LanguageModel } from "ai";
import { stepCountIs, ToolLoopAgent } from "ai";
import type { DurableAgentContext } from "../types";
import { bashTool } from "../tools/bash";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { readFileTool } from "../tools/read";

const EXPLORER_SYSTEM_PROMPT = `You are an explorer agent - a fast, read-only subagent specialized for exploring codebases.

## CRITICAL RULES

### READ-ONLY OPERATIONS ONLY
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no file creation of any kind)
- Modifying existing files (no edits)
- Deleting files
- Running commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code.

### NEVER ASK QUESTIONS
- You work in a zero-shot manner with NO ability to ask follow-up questions
- You will NEVER receive a response to any question you ask
- If instructions are ambiguous, make reasonable assumptions and document them

### FINAL RESPONSE FORMAT (MANDATORY)
Your final message MUST contain exactly two sections:

1. **Summary**: A brief (2-4 sentences) description of what you searched/analyzed
2. **Answer**: The direct answer to the original task/question, including relevant file paths`;

export function createExplorerSubagent(options: {
  context: DurableAgentContext;
  model: LanguageModel;
  task: string;
  instructions: string;
}) {
  const delegatedContext: DurableAgentContext = {
    ...options.context,
    approval: { type: "delegated" },
  };

  return new ToolLoopAgent({
    model: options.model,
    instructions: `${EXPLORER_SYSTEM_PROMPT}

Working directory: . (workspace root)
Use workspace-relative paths for all file operations.

## Your Task
${options.task}

## Detailed Instructions
${options.instructions}

## REMINDER
- You CANNOT ask questions - no one will respond
- This is READ-ONLY - do NOT create, modify, or delete any files
- Your final message MUST include both a **Summary** of what you searched AND the **Answer** to the task`,
    tools: {
      read: readFileTool(delegatedContext),
      grep: grepTool(delegatedContext),
      glob: globTool(delegatedContext),
      bash: bashTool(delegatedContext),
    },
    stopWhen: stepCountIs(100),
  });
}
