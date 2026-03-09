import { describe, expect, test } from "bun:test";
import type { ApprovalRule, DurableAgentContext } from "../types";
import {
  getApprovalConfig,
  getModelConfig,
  getSkills,
  getSubagentModelConfig,
  getWorkingDirectory,
  isPathWithinDirectory,
  pathMatchesApprovalRule,
  pathMatchesGlob,
  pathNeedsApproval,
  shellEscape,
  shouldAutoApprove,
  toDisplayPath,
} from "./utils";

function createContext(
  overrides: Partial<DurableAgentContext> = {},
): DurableAgentContext {
  return {
    sandbox: {
      state: { type: "just-bash", workingDirectory: "/repo" },
      workingDirectory: "/repo",
    },
    approval: {
      type: "interactive",
      autoApprove: "off",
      sessionRules: [],
    },
    model: {
      modelId: "test-model",
    },
    ...overrides,
  };
}

describe("tools/utils", () => {
  test("isPathWithinDirectory handles nested and sibling paths", () => {
    expect(isPathWithinDirectory("/repo/src/index.ts", "/repo")).toBe(true);
    expect(isPathWithinDirectory("/repo", "/repo")).toBe(true);
    expect(isPathWithinDirectory("/repo-other/src/index.ts", "/repo")).toBe(
      false,
    );
  });

  test("toDisplayPath returns workspace-relative paths when possible", () => {
    expect(toDisplayPath("/repo/src/index.ts", "/repo")).toBe("src/index.ts");
    expect(toDisplayPath("src/index.ts", "/repo")).toBe("src/index.ts");
    expect(toDisplayPath("/repo", "/repo")).toBe(".");
    expect(toDisplayPath("/outside/file.ts", "/repo")).toBe("/outside/file.ts");
  });

  test("shouldAutoApprove only for background and delegated modes", () => {
    expect(shouldAutoApprove({ type: "background" })).toBe(true);
    expect(shouldAutoApprove({ type: "delegated" })).toBe(true);
    expect(
      shouldAutoApprove({
        type: "interactive",
        autoApprove: "all",
        sessionRules: [],
      }),
    ).toBe(false);
  });

  test("durable context getters return serializable config fields", () => {
    const context = createContext({
      skills: [
        {
          name: "review",
          description: "Review code changes",
          path: "/repo/.skills/review",
          filename: "SKILL.md",
          options: {},
        },
      ],
      subagentModel: {
        modelId: "subagent-model",
      },
    });

    expect(getWorkingDirectory(context)).toBe("/repo");
    expect(getApprovalConfig(context)).toEqual({
      type: "interactive",
      autoApprove: "off",
      sessionRules: [],
    });
    expect(getModelConfig(context)).toEqual({ modelId: "test-model" });
    expect(getSubagentModelConfig(context)).toEqual({
      modelId: "subagent-model",
    });
    expect(getSkills(context)).toEqual(context.skills);
  });

  test("getSubagentModelConfig falls back to the main model", () => {
    const context = createContext();
    expect(getSubagentModelConfig(context)).toEqual({
      modelId: "test-model",
    });
  });

  test("pathMatchesGlob supports recursive file patterns and directory suffixes", () => {
    expect(
      pathMatchesGlob("/repo/apps/web/page.tsx", "apps/**/*.tsx", "/repo"),
    ).toBe(true);
    expect(pathMatchesGlob("/repo/apps", "apps/**", "/repo")).toBe(true);
    expect(pathMatchesGlob("/other/page.tsx", "apps/**/*.tsx", "/repo")).toBe(
      false,
    );
  });

  test("pathMatchesGlob returns false for malformed patterns", () => {
    expect(pathMatchesGlob("/repo/src/index.ts", "[", "/repo")).toBe(false);
  });

  test("pathMatchesApprovalRule matches only the requested tool", () => {
    const rules: ApprovalRule[] = [
      { type: "path-glob", tool: "read", glob: "outside/**" },
      { type: "path-glob", tool: "write", glob: "writes/**" },
    ];

    expect(
      pathMatchesApprovalRule("/repo/outside/file.ts", "read", "/repo", rules),
    ).toBe(true);
    expect(
      pathMatchesApprovalRule("/repo/outside/file.ts", "write", "/repo", rules),
    ).toBe(false);
  });

  test("pathNeedsApproval follows interactive read/write rules", () => {
    const workingDirectory = "/repo";
    const readRules: ApprovalRule[] = [
      { type: "path-glob", tool: "read", glob: "../external/**" },
    ];

    expect(
      pathNeedsApproval({
        path: "/repo/src/index.ts",
        tool: "read",
        approval: {
          type: "interactive",
          autoApprove: "off",
          sessionRules: readRules,
        },
        workingDirectory,
      }),
    ).toBe(false);

    expect(
      pathNeedsApproval({
        path: "/external/config.json",
        tool: "read",
        approval: {
          type: "interactive",
          autoApprove: "off",
          sessionRules: readRules,
        },
        workingDirectory,
      }),
    ).toBe(false);

    expect(
      pathNeedsApproval({
        path: "/external/secret.json",
        tool: "grep",
        approval: {
          type: "interactive",
          autoApprove: "off",
          sessionRules: readRules,
        },
        workingDirectory,
      }),
    ).toBe(true);

    expect(
      pathNeedsApproval({
        path: "/repo/src/index.ts",
        tool: "write",
        approval: {
          type: "interactive",
          autoApprove: "off",
          sessionRules: [],
        },
        workingDirectory,
      }),
    ).toBe(true);

    expect(
      pathNeedsApproval({
        path: "/repo/src/index.ts",
        tool: "write",
        approval: {
          type: "interactive",
          autoApprove: "edits",
          sessionRules: [],
        },
        workingDirectory,
      }),
    ).toBe(false);

    expect(
      pathNeedsApproval({
        path: "/external/file.ts",
        tool: "edit",
        approval: {
          type: "interactive",
          autoApprove: "all",
          sessionRules: [
            { type: "path-glob", tool: "edit", glob: "../external/**" },
          ],
        },
        workingDirectory,
      }),
    ).toBe(false);
  });

  test("shellEscape safely escapes single quotes", () => {
    expect(shellEscape("simple")).toBe("'simple'");
    expect(shellEscape("it's fine")).toBe("'it'\\''s fine'");
  });
});
