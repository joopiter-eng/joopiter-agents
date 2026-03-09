import { tool } from "ai";
import { z } from "zod";
import {
  extractSkillBody,
  injectSkillDirectory,
  substituteArguments,
} from "../skills/loader";
import { discoverSkills } from "../skills/discovery";
import type { SkillMetadata } from "../skills/types";
import type { ApprovalRule, DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getSkills,
  getWorkingDirectory,
  joinPath,
  shouldAutoApprove,
} from "./utils";

function skillMatchesApprovalRule(
  skillName: string,
  approvalRules: ApprovalRule[],
): boolean {
  const normalizedName = skillName.toLowerCase();
  for (const rule of approvalRules) {
    if (rule.type === "skill" && rule.tool === "skill") {
      if (rule.skillName.toLowerCase() === normalizedName) {
        return true;
      }
    }
  }
  return false;
}

const skillInputSchema = z.object({
  skill: z.string().describe("The skill name to invoke"),
  args: z.string().optional().describe("Optional arguments for the skill"),
});

async function executeSkillStep(
  context: DurableAgentContext,
  foundSkill: SkillMetadata,
  skill: string,
  args: string | undefined,
) {
  "use step";

  const { connectSandbox } = await import("@open-harness/sandbox");
  const sandbox = await connectSandbox(context.sandbox.state, {
    env: context.sandbox.env,
    ports: context.sandbox.ports,
    timeout: context.sandbox.timeout,
    baseSnapshotId: context.sandbox.baseSnapshotId,
  });
  const skillFilePath = joinPath(foundSkill.path, foundSkill.filename);

  let fileContent: string;
  try {
    fileContent = await sandbox.readFile(skillFilePath, "utf-8");
  } catch (error) {
    return {
      success: false,
      error: `Failed to read skill file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const body = extractSkillBody(fileContent);
  const bodyWithDir = injectSkillDirectory(body, foundSkill.path);

  return {
    success: true,
    skillName: skill,
    skillPath: foundSkill.path,
    content: substituteArguments(bodyWithDir, args),
  };
}

async function discoverSkillsStep(context: DurableAgentContext) {
  "use step";

  const { connectSandbox } = await import("@open-harness/sandbox");
  const sandbox = await connectSandbox(context.sandbox.state, {
    env: context.sandbox.env,
    ports: context.sandbox.ports,
    timeout: context.sandbox.timeout,
    baseSnapshotId: context.sandbox.baseSnapshotId,
  });
  const workingDirectory = getWorkingDirectory(context);
  const skillDirs = [".claude", ".agents"].map((folder) =>
    joinPath(workingDirectory, folder, "skills"),
  );

  return discoverSkills(sandbox, skillDirs);
}

export const skillTool = (context: DurableAgentContext) =>
  tool({
    needsApproval: ({ skill }) => {
      const approval = getApprovalConfig(context);

      if (shouldAutoApprove(approval)) {
        return false;
      }

      if (approval.type !== "interactive") {
        return false;
      }

      if (approval.autoApprove === "all") {
        return false;
      }

      if (skillMatchesApprovalRule(skill, approval.sessionRules)) {
        return false;
      }

      return true;
    },
    description: `Execute a skill within the main conversation.`,
    inputSchema: skillInputSchema,
    execute: async ({ skill, args }) => {
      let skills = getSkills(context);
      const normalizedSkillName = skill.toLowerCase();
      let foundSkill = skills.find(
        (entry) => entry.name.toLowerCase() === normalizedSkillName,
      );

      if (!foundSkill) {
        skills = await discoverSkillsStep(context);
        foundSkill = skills.find(
          (entry) => entry.name.toLowerCase() === normalizedSkillName,
        );
      }

      if (!foundSkill) {
        const availableSkills = skills.map((entry) => entry.name).join(", ");
        return {
          success: false,
          error: `Skill '${skill}' not found. Available skills: ${availableSkills || "none"}`,
        };
      }

      if (foundSkill.options.disableModelInvocation) {
        return {
          success: false,
          error: `Skill '${skill}' cannot be invoked by the model (disable-model-invocation is set)`,
        };
      }

      return executeSkillStep(context, foundSkill, skill, args);
    },
  });

export type SkillToolInput = z.infer<typeof skillInputSchema>;
