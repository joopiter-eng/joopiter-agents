/* eslint-disable max-lines */

import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { DurableAgentContext, SkillMetadata } from "../types";

let currentSandbox: unknown;

mock.module("@open-harness/sandbox", () => ({
  connectSandbox: async () => currentSandbox,
}));

let askUserQuestionTool: typeof import("./ask-user-question").askUserQuestionTool;
let bashTool: typeof import("./bash").bashTool;
let commandNeedsApproval: typeof import("./bash").commandNeedsApproval;
let webFetchTool: typeof import("./fetch").webFetchTool;
let globTool: typeof import("./glob").globTool;
let grepTool: typeof import("./grep").grepTool;
let readFileTool: typeof import("./read").readFileTool;
let skillTool: typeof import("./skill").skillTool;
let taskTool: typeof import("./task").taskTool;
let todoWriteTool: typeof import("./todo").todoWriteTool;
let editFileTool: typeof import("./write").editFileTool;
let writeFileTool: typeof import("./write").writeFileTool;

beforeAll(async () => {
  ({ askUserQuestionTool } = await import("./ask-user-question"));
  ({ bashTool, commandNeedsApproval } = await import("./bash"));
  ({ webFetchTool } = await import("./fetch"));
  ({ globTool } = await import("./glob"));
  ({ grepTool } = await import("./grep"));
  ({ readFileTool } = await import("./read"));
  ({ skillTool } = await import("./skill"));
  ({ taskTool } = await import("./task"));
  ({ todoWriteTool } = await import("./todo"));
  ({ editFileTool, writeFileTool } = await import("./write"));
});

function createContext({
  workingDirectory = "/repo",
  approval,
  skills,
  model,
  subagentModel,
}: {
  workingDirectory?: string;
  approval?: DurableAgentContext["approval"];
  skills?: SkillMetadata[];
  model?: DurableAgentContext["model"];
  subagentModel?: DurableAgentContext["subagentModel"];
} = {}): DurableAgentContext {
  return {
    sandbox: {
      state: { type: "just-bash", workingDirectory },
      workingDirectory,
    },
    approval: approval ?? {
      type: "interactive",
      autoApprove: "off",
      sessionRules: [],
    },
    skills,
    model: model ?? {
      modelId: "test-model",
    },
    subagentModel,
  };
}

function executionOptions() {
  return {
    toolCallId: "tool-call-1",
    messages: [],
  };
}

async function getNeedsApprovalResult<TArgs>(
  needsApproval:
    | boolean
    | ((args: TArgs) => boolean | Promise<boolean>)
    | undefined,
  args: TArgs,
) {
  if (typeof needsApproval === "function") {
    return await Promise.resolve(needsApproval(args));
  }
  return needsApproval ?? false;
}

async function createFsSandbox() {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "agent-tools-"));

  const sandbox = {
    workingDirectory,
    stat: (filePath: string) => stat(filePath),
    readFile: (filePath: string, encoding: BufferEncoding) =>
      readFile(filePath, { encoding }),
    writeFile: (filePath: string, content: string, encoding: BufferEncoding) =>
      writeFile(filePath, content, { encoding }),
    mkdir: (dirPath: string, options: { recursive?: boolean }) =>
      mkdir(dirPath, options),
  };

  return { sandbox, workingDirectory };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  currentSandbox = undefined;
  globalThis.fetch = originalFetch;
});

describe("tools execute behavior", () => {
  test("readFileTool returns numbered lines for offset/limit", async () => {
    const { sandbox, workingDirectory } = await createFsSandbox();
    const filePath = path.join(workingDirectory, "notes.txt");
    await writeFile(filePath, "line-1\nline-2\nline-3", "utf-8");
    currentSandbox = sandbox;

    const result = await readFileTool(
      createContext({ workingDirectory }),
    ).execute?.({ filePath, offset: 2, limit: 2 }, executionOptions());

    expect(result).toEqual({
      success: true,
      path: "notes.txt",
      totalLines: 3,
      startLine: 2,
      endLine: 3,
      content: "2: line-2\n3: line-3",
    });
  });

  test("readFileTool rejects reading directories", async () => {
    const { sandbox, workingDirectory } = await createFsSandbox();
    currentSandbox = sandbox;

    const result = await readFileTool(
      createContext({ workingDirectory }),
    ).execute?.({ filePath: workingDirectory }, executionOptions());

    expect(result).toEqual({
      success: false,
      error: "Cannot read a directory. Use glob or ls command instead.",
    });
  });

  test("writeFileTool creates parent directories and writes content", async () => {
    const { sandbox, workingDirectory } = await createFsSandbox();
    currentSandbox = sandbox;
    const relativePath = "nested/output.txt";

    const result = await writeFileTool(
      createContext({ workingDirectory }),
    ).execute?.(
      { filePath: relativePath, content: "hello" },
      executionOptions(),
    );

    const expectedPath = path.join(workingDirectory, relativePath);
    const written = await readFile(expectedPath, "utf-8");

    expect(written).toBe("hello");
    expect(result).toEqual({
      success: true,
      path: relativePath,
      bytesWritten: 5,
    });
  });

  test("editFileTool rejects ambiguous replacement unless replaceAll is true", async () => {
    const { sandbox, workingDirectory } = await createFsSandbox();
    const filePath = path.join(workingDirectory, "src.txt");
    await writeFile(filePath, "alpha\nalpha\nomega", "utf-8");
    currentSandbox = sandbox;

    const result = await editFileTool(
      createContext({ workingDirectory }),
    ).execute?.(
      { filePath, oldString: "alpha", newString: "beta" },
      executionOptions(),
    );

    expect(result).toEqual({
      success: false,
      error:
        "oldString found 2 times. Use replaceAll=true or provide more context to make it unique.",
    });
  });

  test("editFileTool replaces all matches and reports first start line", async () => {
    const { sandbox, workingDirectory } = await createFsSandbox();
    const filePath = path.join(workingDirectory, "src.txt");
    await writeFile(filePath, "alpha\nalpha\nomega", "utf-8");
    currentSandbox = sandbox;

    const result = await editFileTool(
      createContext({ workingDirectory }),
    ).execute?.(
      { filePath, oldString: "alpha", newString: "beta", replaceAll: true },
      executionOptions(),
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("beta\nbeta\nomega");
    expect(result).toEqual({
      success: true,
      path: "src.txt",
      replacements: 2,
      startLine: 1,
    });
  });

  test("grepTool parses grep output and truncates long content", async () => {
    let executedCommand = "";
    currentSandbox = {
      workingDirectory: "/repo",
      exec: async (command: string) => {
        executedCommand = command;
        return {
          success: true,
          exitCode: 0,
          stdout:
            "/repo/src/a.ts:12:match-a\n/repo/src/b.ts:7:" + "x".repeat(300),
          stderr: "",
        };
      },
    };

    const result = await grepTool(createContext()).execute?.(
      {
        pattern: "match",
        path: "src",
        glob: "*.ts",
        caseSensitive: false,
      },
      executionOptions(),
    );

    expect(executedCommand).toContain("--include='*.ts'");
    expect(executedCommand).toContain(" -i ");
    expect(result).toMatchObject({
      success: true,
      pattern: "match",
      matchCount: 2,
      filesWithMatches: 2,
    });

    const matches =
      result && typeof result === "object" && "matches" in result
        ? (result.matches as Array<{ file: string; content: string }>)
        : [];

    expect(matches[0]?.file).toBe("src/a.ts");
    expect(matches[1]?.content.length).toBe(200);
  });

  test("globTool parses find output into sorted file metadata", async () => {
    let executedCommand = "";
    currentSandbox = {
      workingDirectory: "/repo",
      exec: async (command: string) => {
        executedCommand = command;
        return {
          success: true,
          exitCode: 0,
          stdout:
            "1700000000\t12\t/repo/src/a.ts\n1690000000\t20\t/repo/src/b.ts",
          stderr: "",
        };
      },
    };

    const result = await globTool(createContext()).execute?.(
      { pattern: "src/**/*.ts", path: ".", limit: 2 },
      executionOptions(),
    );

    expect(executedCommand).toContain("head -n 2");
    expect(executedCommand).toContain("-name '*.ts'");
    expect(result).toEqual({
      success: true,
      pattern: "src/**/*.ts",
      baseDir: "src",
      count: 2,
      files: [
        {
          path: "src/a.ts",
          size: 12,
          modifiedAt: "2023-11-14T22:13:20.000Z",
        },
        {
          path: "src/b.ts",
          size: 20,
          modifiedAt: "2023-07-22T04:26:40.000Z",
        },
      ],
    });
  });

  test("bashTool handles detached and non-detached execution", async () => {
    const noDetachSandbox = {
      workingDirectory: "/repo",
      exec: async () => ({
        success: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        truncated: true,
      }),
    };

    currentSandbox = noDetachSandbox;
    const detachedUnsupported = await bashTool(createContext()).execute?.(
      { command: "npm run dev", detached: true },
      executionOptions(),
    );

    expect(detachedUnsupported).toEqual({
      success: false,
      exitCode: null,
      stdout: "",
      stderr:
        "Detached mode is not supported in this sandbox environment. Only cloud sandboxes support background processes.",
    });

    const detachedSandbox = {
      ...noDetachSandbox,
      execDetached: async () => ({ commandId: "cmd-1" }),
    };

    currentSandbox = detachedSandbox;
    const detachedResult = await bashTool(createContext()).execute?.(
      { command: "npm run dev", detached: true },
      executionOptions(),
    );

    expect(detachedResult).toEqual({
      success: true,
      exitCode: null,
      stdout:
        "Process started in background (command ID: cmd-1). The server is now running.",
      stderr: "",
    });

    currentSandbox = noDetachSandbox;
    const normalResult = await bashTool(createContext()).execute?.(
      { command: "ls" },
      executionOptions(),
    );

    expect(normalResult).toEqual({
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      truncated: true,
    });
  });

  test("commandNeedsApproval flags dangerous and unknown commands", () => {
    expect(commandNeedsApproval("ls -la")).toBe(false);
    expect(commandNeedsApproval("git status --short")).toBe(false);
    expect(commandNeedsApproval("npm install")).toBe(true);
    expect(commandNeedsApproval("echo hi | wc -c")).toBe(true);
    expect(commandNeedsApproval("custom-command --help")).toBe(true);
  });

  test("webFetchTool truncates oversized response bodies", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        new Response("x".repeat(20_050), {
          status: 200,
          statusText: "OK",
          headers: { "x-test": "1" },
        }),
      )) as unknown as typeof fetch;

    const result = await webFetchTool.execute?.(
      {
        url: "https://example.com",
        method: "GET",
      },
      executionOptions(),
    );

    expect(result).toMatchObject({
      success: true,
      status: 200,
      statusText: "OK",
      truncated: true,
      headers: { "x-test": "1" },
    });

    const body =
      result && typeof result === "object" && "body" in result
        ? (result.body as string)
        : "";
    expect(body.length).toBe(20_000);
  });

  test("askUserQuestionTool formats structured answers", () => {
    const answerOutput = askUserQuestionTool.toModelOutput?.({
      toolCallId: "tool-call-1",
      input: { questions: [] },
      output: {
        answers: {
          "Which package manager?": "bun",
          "Which checks?": ["typecheck", "test"],
        },
      },
    });

    expect(answerOutput).toEqual({
      type: "text",
      value:
        'User has answered your questions: "Which package manager?"="bun", "Which checks?"="typecheck, test". You can now continue with the user\'s answers in mind.',
    });

    const declinedOutput = askUserQuestionTool.toModelOutput?.({
      toolCallId: "tool-call-1",
      input: { questions: [] },
      output: { declined: true },
    });

    expect(declinedOutput).toEqual({
      type: "text",
      value:
        "User declined to answer questions. You should continue without this information or ask in a different way.",
    });
  });

  test("skillTool loads skill content and substitutes arguments", async () => {
    currentSandbox = {
      workingDirectory: "/repo",
      readFile: async () =>
        "---\nname: review\ndescription: review code\n---\nRun review with $ARGUMENTS",
    };

    const result = await skillTool(
      createContext({
        skills: [
          {
            name: "review",
            description: "Review code changes",
            path: "/repo/.skills/review",
            filename: "SKILL.md",
            options: {},
          },
        ],
      }),
    ).execute?.({ skill: "Review", args: "--quick" }, executionOptions());

    expect(result).toEqual({
      success: true,
      skillName: "Review",
      skillPath: "/repo/.skills/review",
      content:
        "Skill directory: /repo/.skills/review\n\nRun review with --quick",
    });
  });

  test("skillTool returns helpful errors for missing or disabled skills", async () => {
    currentSandbox = {
      workingDirectory: "/repo",
      readFile: async () => "skill-body",
    };

    const missingResult = await skillTool(
      createContext({ skills: [] }),
    ).execute?.({ skill: "unknown" }, executionOptions());

    expect(missingResult).toEqual({
      success: false,
      error: "Skill 'unknown' not found. Available skills: none",
    });

    const disabledResult = await skillTool(
      createContext({
        skills: [
          {
            name: "commit",
            description: "Create a commit",
            path: "/repo/.skills/commit",
            filename: "SKILL.md",
            options: { disableModelInvocation: true },
          },
        ],
      }),
    ).execute?.({ skill: "commit" }, executionOptions());

    expect(disabledResult).toEqual({
      success: false,
      error:
        "Skill 'commit' cannot be invoked by the model (disable-model-invocation is set)",
    });
  });

  test("skillTool needsApproval respects auto-approve and session skill rules", async () => {
    const defaultNeedsApproval = await getNeedsApprovalResult(
      skillTool(
        createContext({
          approval: {
            type: "interactive",
            autoApprove: "off",
            sessionRules: [],
          },
        }),
      ).needsApproval,
      { skill: "commit", args: "" },
    );
    expect(defaultNeedsApproval).toBe(true);

    const autoApproved = await getNeedsApprovalResult(
      skillTool(
        createContext({
          approval: {
            type: "interactive",
            autoApprove: "all",
            sessionRules: [],
          },
        }),
      ).needsApproval,
      { skill: "commit", args: "" },
    );
    expect(autoApproved).toBe(false);

    const matchedRule = await getNeedsApprovalResult(
      skillTool(
        createContext({
          approval: {
            type: "interactive",
            autoApprove: "off",
            sessionRules: [
              {
                type: "skill",
                tool: "skill",
                skillName: "commit",
              },
            ],
          },
        }),
      ).needsApproval,
      { skill: "CoMmIt", args: "" },
    );
    expect(matchedRule).toBe(false);
  });

  test("taskTool needsApproval requires approval for executor in interactive mode", async () => {
    const baseApproval: DurableAgentContext["approval"] = {
      type: "interactive",
      autoApprove: "off",
      sessionRules: [],
    };

    const explorerNeedsApproval = await getNeedsApprovalResult(
      taskTool(createContext({ approval: baseApproval })).needsApproval,
      {
        subagentType: "explorer" as const,
        task: "Find usages",
        instructions: "Search for helper usage",
      },
    );
    expect(explorerNeedsApproval).toBe(false);

    const executorNeedsApproval = await getNeedsApprovalResult(
      taskTool(createContext({ approval: baseApproval })).needsApproval,
      {
        subagentType: "executor" as const,
        task: "Apply changes",
        instructions: "Update files",
      },
    );
    expect(executorNeedsApproval).toBe(true);

    const approvedByRule = await getNeedsApprovalResult(
      taskTool(
        createContext({
          approval: {
            type: "interactive",
            autoApprove: "off",
            sessionRules: [
              {
                type: "subagent-type",
                tool: "task",
                subagentType: "executor",
              },
            ],
          },
        }),
      ).needsApproval,
      {
        subagentType: "executor" as const,
        task: "Apply changes",
        instructions: "Update files",
      },
    );
    expect(approvedByRule).toBe(false);

    const backgroundApproval = await getNeedsApprovalResult(
      taskTool(
        createContext({
          approval: { type: "background" },
        }),
      ).needsApproval,
      {
        subagentType: "executor" as const,
        task: "Apply changes",
        instructions: "Update files",
      },
    );
    expect(backgroundApproval).toBe(false);
  });

  test("todoWriteTool returns updated todo list metadata", async () => {
    const todos = [
      { id: "1", content: "Write tests", status: "in_progress" as const },
      { id: "2", content: "Run checks", status: "pending" as const },
    ];

    const result = await todoWriteTool.execute?.({ todos }, executionOptions());

    expect(result).toEqual({
      success: true,
      message: "Updated task list with 2 items",
      todos,
    });
  });
});
