import { tool } from "ai";
import { z } from "zod";
import { getAgentContext, getApprovalContext } from "./utils";

// Note: Need at least one property for Anthropic API compatibility
const exitPlanModeInputSchema = z.object({
  _: z.string().optional().describe("Unused placeholder for API compatibility"),
  allowedPrompts: z
    .array(
      z.object({
        tool: z.literal("bash"),
        prompt: z
          .string()
          .describe(
            'Semantic description of the action, e.g. "run tests", "install dependencies"',
          ),
      }),
    )
    .optional()
    .describe("Prompt-based permissions needed to implement the plan"),
});

export type ExitPlanModeInput = z.infer<typeof exitPlanModeInputSchema>;

export const exitPlanModeTool = () =>
  tool({
    needsApproval: async (_args, { experimental_context }) => {
      const { sandbox, planFilePath } = getApprovalContext(
        experimental_context,
        "exit_plan_mode",
      );

      // No plan file path means we're not in plan mode - auto-approve
      if (!planFilePath) {
        return false;
      }

      // Try to read the plan file and check if it has content
      try {
        const content = await sandbox.readFile(planFilePath, "utf-8");
        const hasContent = content.trim().length > 0;
        // Only require approval if there's actual plan content
        return hasContent;
      } catch {
        // Plan file doesn't exist or can't be read - auto-approve
        return false;
      }
    },
    description: `Exit plan mode and request user approval to proceed with implementation.

WHEN TO USE:
- When your plan is complete and ready for user review
- After you have explored the codebase and documented your approach in the plan file

WHAT HAPPENS:
- The plan file content is returned for user review
- User must approve before you can proceed
- After approval, tools are restored to full access
- The allowedPrompts parameter can pre-authorize certain bash commands

IMPORTANT:
- Make sure your plan is complete before calling this tool
- The user will see your plan and decide whether to proceed
- If the user rejects the plan, you will remain in plan mode to revise it`,
    inputSchema: exitPlanModeInputSchema,
    execute: async ({ allowedPrompts }, { experimental_context }) => {
      const { sandbox, planFilePath } = getAgentContext(
        experimental_context,
        "exit_plan_mode",
      );

      if (!planFilePath) {
        return {
          success: false,
          error: "No plan file path found. Are you in plan mode?",
          plan: null,
          planFilePath: null,
        };
      }

      // Try to read the plan file
      let plan: string | null = null;
      try {
        plan = await sandbox.readFile(planFilePath, "utf-8");
      } catch {
        // Plan file may not exist yet
        plan = null;
      }

      // Check if there's actual plan content
      const hasContent = plan !== null && plan.trim().length > 0;

      if (!hasContent) {
        return {
          success: true,
          message:
            "No plan was written. Exiting plan mode. You now have full tool access.",
          plan: null,
          planFilePath,
          allowedPrompts: allowedPrompts ?? [],
        };
      }

      return {
        success: true,
        message:
          "The user has approved your plan. Start implementing it now, following the steps outlined in your plan.",
        plan,
        planFilePath,
        allowedPrompts: allowedPrompts ?? [],
      };
    },
  });

// TODO: use ai sdk type helpers to derive from tool definition
export type ExitPlanModeOutput = {
  success: boolean;
  message?: string;
  error?: string;
  plan: string | null;
  planFilePath: string | null;
  allowedPrompts?: ExitPlanModeInput["allowedPrompts"];
};

export function isExitPlanModeOutput(
  value: unknown,
): value is ExitPlanModeOutput {
  // AI SDK wraps tool results in { type: "json", value: {...} }
  // Unwrap if necessary
  const unwrapped =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "value" in value
      ? (value as { type: string; value: unknown }).value
      : value;

  return (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "success" in unwrapped &&
    "plan" in unwrapped &&
    (unwrapped as ExitPlanModeOutput).success === true
  );
}

/**
 * Extract the actual output value from a potentially wrapped tool result.
 */
export function extractExitPlanModeOutput(
  value: unknown,
): ExitPlanModeOutput | null {
  const unwrapped =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "value" in value
      ? (value as { type: string; value: unknown }).value
      : value;

  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "success" in unwrapped &&
    "plan" in unwrapped &&
    (unwrapped as ExitPlanModeOutput).success === true
  ) {
    return unwrapped as ExitPlanModeOutput;
  }
  return null;
}
