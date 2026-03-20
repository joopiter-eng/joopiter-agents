import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SESSION_COOKIE_NAME } from "@/lib/session/constants";
import type { Session } from "@/lib/session/types";

interface MockUser {
  id: string;
  provider: "github" | "vercel";
  username: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

const encryptCalls: Array<{
  payload: Session;
  expirationTime: string;
}> = [];

const getUserByIdCalls: string[] = [];

let currentUser: MockUser | null = {
  id: "user-1",
  provider: "vercel",
  username: "agent-user",
  email: "agent@example.com",
  name: "Agent User",
  avatarUrl: "https://example.com/avatar.png",
};

mock.module("@/lib/db/users", () => ({
  getUserById: async (userId: string) => {
    getUserByIdCalls.push(userId);
    return currentUser;
  },
}));

mock.module("@/lib/jwe/encrypt", () => ({
  encryptJWE: async (payload: Session, expirationTime: string) => {
    encryptCalls.push({ payload, expirationTime });
    return "mock-session-token";
  },
}));

const routeModulePromise = import("./route");

const originalEnv = {
  AGENT_WEB_AUTH_ENABLED: process.env.AGENT_WEB_AUTH_ENABLED,
  AGENT_WEB_AUTH_CODE: process.env.AGENT_WEB_AUTH_CODE,
  AGENT_WEB_AUTH_USER_ID: process.env.AGENT_WEB_AUTH_USER_ID,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

function createRequest(query = ""): Request {
  return new Request(`http://localhost/api/auth/agent/signin${query}`);
}

afterAll(() => {
  restoreEnv();
});

describe("/api/auth/agent/signin", () => {
  beforeEach(() => {
    currentUser = {
      id: "user-1",
      provider: "vercel",
      username: "agent-user",
      email: "agent@example.com",
      name: "Agent User",
      avatarUrl: "https://example.com/avatar.png",
    };
    encryptCalls.length = 0;
    getUserByIdCalls.length = 0;
    process.env.AGENT_WEB_AUTH_ENABLED = "true";
    process.env.AGENT_WEB_AUTH_CODE = "expected-code";
    process.env.AGENT_WEB_AUTH_USER_ID = "user-1";
    Reflect.set(process.env, "NODE_ENV", "test");
    delete process.env.VERCEL_ENV;
  });

  test("returns 404 when agent auth is disabled", async () => {
    process.env.AGENT_WEB_AUTH_ENABLED = "false";
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest("?code=expected-code"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(getUserByIdCalls).toHaveLength(0);
    expect(encryptCalls).toHaveLength(0);
  });

  test("returns 404 in production", async () => {
    process.env.VERCEL_ENV = "production";
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest("?code=expected-code"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(getUserByIdCalls).toHaveLength(0);
  });

  test("returns 500 when agent auth is misconfigured", async () => {
    delete process.env.AGENT_WEB_AUTH_CODE;
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest("?code=expected-code"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe(
      "Agent auth is misconfigured. Set AGENT_WEB_AUTH_CODE and AGENT_WEB_AUTH_USER_ID.",
    );
    expect(getUserByIdCalls).toHaveLength(0);
  });

  test("returns 401 when the code is invalid", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest("?code=wrong-code"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Invalid agent auth code");
    expect(getUserByIdCalls).toHaveLength(0);
    expect(encryptCalls).toHaveLength(0);
  });

  test("returns 500 when the configured user does not exist", async () => {
    currentUser = null;
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest("?code=expected-code"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("Configured agent user was not found");
    expect(getUserByIdCalls).toEqual(["user-1"]);
    expect(encryptCalls).toHaveLength(0);
  });

  test("creates a session cookie and redirects to the requested path", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest("?code=expected-code&next=/settings/profile"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/settings/profile",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const setCookieHeader = response.headers.get("set-cookie");
    expect(setCookieHeader).toBeTruthy();
    expect(setCookieHeader).toContain(
      `${SESSION_COOKIE_NAME}=mock-session-token`,
    );
    expect(setCookieHeader).toContain("Path=/");
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("SameSite=lax");
    expect(setCookieHeader).not.toContain("Secure");

    expect(getUserByIdCalls).toEqual(["user-1"]);
    expect(encryptCalls).toHaveLength(1);
    expect(encryptCalls[0]?.expirationTime).toBe("1y");
    expect(encryptCalls[0]?.payload.authProvider).toBe("vercel");
    expect(encryptCalls[0]?.payload.user).toEqual({
      id: "user-1",
      username: "agent-user",
      email: "agent@example.com",
      name: "Agent User",
      avatar: "https://example.com/avatar.png",
    });
    expect(typeof encryptCalls[0]?.payload.created).toBe("number");
  });

  test("falls back to /sessions for invalid redirect targets", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest("?code=expected-code&next=https://example.com/elsewhere"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/sessions");
  });
});
