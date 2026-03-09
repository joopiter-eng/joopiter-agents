import type { LanguageModel } from "ai";
import { stepCountIs, ToolLoopAgent } from "ai";
import type { DurableAgentContext } from "../types";
import { bashTool } from "../tools/bash";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { readFileTool } from "../tools/read";
import { editFileTool, writeFileTool } from "../tools/write";

const EXECUTOR_SYSTEM_PROMPT = `You are an executor agent - a fire-and-forget subagent that completes specific, well-defined implementation tasks autonomously.

Think of yourself as a productive engineer who cannot ask follow-up questions once started.

## CRITICAL RULES

### NEVER ASK QUESTIONS
- You work in a zero-shot manner with NO ability to ask follow-up questions
- You will NEVER receive a response to any question you ask
- If instructions are ambiguous, make reasonable assumptions and document them
- If you encounter blockers, work around them or document them in your final response

### ALWAYS COMPLETE THE TASK
- Execute the task fully from start to finish
- Do not stop mid-task or hand back partial work
- If one approach fails, try alternative approaches before giving up

### FINAL RESPONSE FORMAT (MANDATORY)
Your final message MUST contain exactly two sections:

1. **Summary**: A brief (2-4 sentences) description of what you actually did
2. **Answer**: The direct answer to the original task/question`;

export function createExecutorSubagent(options: {
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
    instructions: `${EXECUTOR_SYSTEM_PROMPT}

Working directory: . (workspace root)
Use workspace-relative paths for all file operations.

## Your Task
${options.task}

## Detailed Instructions
${options.instructions}

## REMINDER
- You CANNOT ask questions - no one will respond
- Complete the task fully before returning
- Your final message MUST include both a **Summary** of what you did AND the **Answer** to the task`,
    tools: {
      read: readFileTool(delegatedContext),
      write: writeFileTool(delegatedContext),
      edit: editFileTool(delegatedContext),
      grep: grepTool(delegatedContext),
      glob: globTool(delegatedContext),
      bash: bashTool(delegatedContext),
    },
    stopWhen: stepCountIs(100),
  });
}
