import type {
  ApprovalConfig,
  ApprovalRule,
  DurableAgentContext,
  DurableModelConfig,
} from "../types";
import {
  isAbsolutePath,
  isPathWithinDirectory,
  relativePath,
  resolvePath,
  resolvePathFromWorkingDirectory,
  toDisplayPath,
} from "../path-utils";

export {
  basenamePath,
  dirnamePath,
  isAbsolutePath,
  isPathWithinDirectory,
  joinPath,
  relativePath,
  resolvePath,
  resolvePathFromWorkingDirectory,
  toDisplayPath,
} from "../path-utils";

export function shouldAutoApprove(
  approval: ApprovalConfig,
): approval is { type: "background" } | { type: "delegated" } {
  return approval.type === "background" || approval.type === "delegated";
}

export function getWorkingDirectory(context: DurableAgentContext): string {
  return context.sandbox.workingDirectory;
}

export function getApprovalConfig(
  context: DurableAgentContext,
): ApprovalConfig {
  return context.approval;
}

export function getModelConfig(
  context: DurableAgentContext,
): DurableModelConfig {
  return context.model;
}

export function getSubagentModelConfig(
  context: DurableAgentContext,
): DurableModelConfig {
  return context.subagentModel ?? context.model;
}

export function getSkills(context: DurableAgentContext) {
  return context.skills ?? [];
}

export function pathMatchesGlob(
  filePath: string,
  glob: string,
  baseDir: string,
  options?: { allowOutsideBase?: boolean },
): boolean {
  const resolvedPath = resolvePath(filePath);
  const resolvedBase = resolvePath(baseDir);

  if (!options?.allowOutsideBase) {
    if (!isPathWithinDirectory(resolvedPath, resolvedBase)) {
      return false;
    }
  }

  const relativePathToFile = relativePath(resolvedBase, resolvedPath);

  try {
    const globRegex = glob
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*")
      .replace(/\//g, "\\/");

    const regex = new RegExp(`^${globRegex}`);
    if (regex.test(relativePathToFile)) {
      return true;
    }
    if (glob.endsWith("/**") && !relativePathToFile.endsWith("/")) {
      return regex.test(relativePathToFile + "/");
    }
    return false;
  } catch {
    return false;
  }
}

export type PathToolName = "read" | "write" | "edit" | "grep" | "glob";

export function pathMatchesApprovalRule(
  filePath: string,
  tool: PathToolName,
  workingDirectory: string,
  approvalRules: ApprovalRule[],
): boolean {
  const absolutePath = resolvePathFromWorkingDirectory(
    filePath,
    workingDirectory,
  );

  for (const rule of approvalRules) {
    if (rule.type === "path-glob" && rule.tool === tool) {
      if (
        pathMatchesGlob(absolutePath, rule.glob, workingDirectory, {
          allowOutsideBase: true,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

type PathApprovalOptions = {
  path: string;
  tool: PathToolName;
  approval: {
    type: "interactive";
    autoApprove: "off" | "edits" | "all";
    sessionRules: ApprovalRule[];
  };
  workingDirectory: string;
};

export function pathNeedsApproval(options: PathApprovalOptions): boolean {
  const { path: filePath, tool, approval, workingDirectory } = options;

  const absolutePath = resolvePathFromWorkingDirectory(
    filePath,
    workingDirectory,
  );

  const isInsideWorkingDir = isPathWithinDirectory(
    absolutePath,
    workingDirectory,
  );
  const isWriteTool = tool === "write" || tool === "edit";

  if (isWriteTool) {
    if (
      pathMatchesApprovalRule(
        filePath,
        tool,
        workingDirectory,
        approval.sessionRules,
      )
    ) {
      return false;
    }

    if (!isInsideWorkingDir) {
      return true;
    }

    if (approval.autoApprove === "edits" || approval.autoApprove === "all") {
      return false;
    }

    return true;
  }

  if (isInsideWorkingDir) {
    return false;
  }

  if (
    pathMatchesApprovalRule(
      filePath,
      tool,
      workingDirectory,
      approval.sessionRules,
    )
  ) {
    return false;
  }

  return true;
}

export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
