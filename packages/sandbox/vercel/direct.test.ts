import { describe, expect, mock, test } from "bun:test";
import type { Sandbox } from "../interface";

let runCommandCalls = 0;
let stopSessionCalls = 0;
let stopSessionMock = async () => {
  throw new Error("Status code 410 is not ok");
};

class MockApiClient {
  async runCommand() {
    runCommandCalls += 1;
    throw new Error("Status code 410 is not ok");
  }

  async stopSession() {
    stopSessionCalls += 1;
    return stopSessionMock();
  }

  async getSession() {
    return {
      json: {
        routes: [],
      },
    };
  }
}

mock.module("@vercel/sandbox/dist/api-client", () => ({
  APIClient: MockApiClient,
}));

mock.module("@vercel/sandbox/dist/utils/get-credentials", () => ({
  getCredentials: async () => ({
    teamId: "team-1",
    projectId: "project-1",
    token: "token-1",
  }),
}));

const directModulePromise = import("./direct");

function createFallbackSandbox(overrides?: Partial<Sandbox>) {
  const sandbox: Sandbox = {
    type: "cloud",
    workingDirectory: "/vercel/sandbox",
    readFile: async () => {
      throw new Error("not implemented");
    },
    writeFile: async () => {
      throw new Error("not implemented");
    },
    stat: async () => {
      throw new Error("not implemented");
    },
    access: async () => {
      throw new Error("not implemented");
    },
    mkdir: async () => {
      throw new Error("not implemented");
    },
    readdir: async () => {
      throw new Error("not implemented");
    },
    exec: async () => ({
      success: true,
      exitCode: 0,
      stdout: "/vercel/sandbox\n",
      stderr: "",
      truncated: false,
    }),
    stop: async () => {},
  };

  return {
    ...sandbox,
    ...overrides,
  } satisfies Sandbox;
}

describe("tryConnectVercelSandboxDirect", () => {
  test("falls back to the managed sandbox when direct exec returns a 410", async () => {
    runCommandCalls = 0;

    const { tryConnectVercelSandboxDirect } = await directModulePromise;
    const reconnect = mock(async () => createFallbackSandbox());

    const sandbox = await tryConnectVercelSandboxDirect({
      sandboxId: "sbx-1",
      sessionId: "sess-1",
      reconnect,
      expiresAt: Date.now() + 60_000,
    });

    expect(sandbox).not.toBeNull();
    if (!sandbox) {
      throw new Error("Expected a direct sandbox instance");
    }

    const result = await sandbox.exec("pwd", "/vercel/sandbox", 5_000);

    expect(result).toEqual({
      success: true,
      exitCode: 0,
      stdout: "/vercel/sandbox\n",
      stderr: "",
      truncated: false,
    });
    expect(runCommandCalls).toBe(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  test("falls back to the managed sandbox when direct stop hits a stale session", async () => {
    stopSessionCalls = 0;
    stopSessionMock = async () => {
      throw new Error("Status code 410 is not ok");
    };

    const { tryConnectVercelSandboxDirect } = await directModulePromise;
    const fallbackStop = mock(async () => {});
    const reconnect = mock(async () =>
      createFallbackSandbox({
        stop: fallbackStop,
      }),
    );

    const sandbox = await tryConnectVercelSandboxDirect({
      sandboxId: "sbx-1",
      sessionId: "sess-1",
      reconnect,
      expiresAt: Date.now() + 60_000,
    });

    expect(sandbox).not.toBeNull();
    if (!sandbox) {
      throw new Error("Expected a direct sandbox instance");
    }

    await sandbox.stop();

    expect(stopSessionCalls).toBe(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(fallbackStop).toHaveBeenCalledTimes(1);
  });

  test("returns null when sessionId is unavailable", async () => {
    const { tryConnectVercelSandboxDirect } = await directModulePromise;

    const sandbox = await tryConnectVercelSandboxDirect({
      sandboxId: "sbx-1",
    });

    expect(sandbox).toBeNull();
  });
});
