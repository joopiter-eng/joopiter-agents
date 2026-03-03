import { beforeEach, describe, expect, mock, test } from "bun:test";

type SnapshotPreset = "default" | "browser";
type SandboxType = "hybrid" | "vercel" | "just-bash";

interface PreferenceState {
  defaultModelId: string;
  defaultSubagentModelId: string | null;
  defaultSandboxType: SandboxType;
  defaultSandboxSnapshotPreset: SnapshotPreset;
}

let isAuthenticated = true;
let preferenceState: PreferenceState;
const updateCalls: Array<Partial<PreferenceState>> = [];

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => {
    if (!isAuthenticated) {
      return null;
    }

    return {
      user: {
        id: "user-1",
      },
    };
  },
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => preferenceState,
  updateUserPreferences: async (
    _userId: string,
    updates: Partial<PreferenceState>,
  ) => {
    updateCalls.push(updates);
    preferenceState = {
      ...preferenceState,
      ...updates,
    };
    return preferenceState;
  },
}));

const routeModulePromise = import("./route");

describe("/api/settings/preferences snapshot preset", () => {
  beforeEach(() => {
    isAuthenticated = true;
    updateCalls.length = 0;
    preferenceState = {
      defaultModelId: "anthropic/claude-haiku-4.5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultSandboxSnapshotPreset: "default",
    };
  });

  test("returns 401 when user is not authenticated", async () => {
    isAuthenticated = false;
    const { GET } = await routeModulePromise;

    const response = await GET();

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("Not authenticated");
  });

  test("rejects invalid snapshot preset values", async () => {
    const { PATCH } = await routeModulePromise;

    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultSandboxSnapshotPreset: "invalid",
      }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("Invalid sandbox snapshot preset");
    expect(updateCalls).toHaveLength(0);
  });

  test("persists browser snapshot preset", async () => {
    const { PATCH } = await routeModulePromise;

    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultSandboxSnapshotPreset: "browser",
      }),
    });

    const response = await PATCH(request);

    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      preferences?: PreferenceState;
    };

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.defaultSandboxSnapshotPreset).toBe("browser");
    expect(body.preferences?.defaultSandboxSnapshotPreset).toBe("browser");
  });
});
