import { describe, expect, test } from "bun:test";
import {
  BROWSER_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  resolveSandboxBaseSnapshotId,
} from "./config";

describe("sandbox snapshot preset resolution", () => {
  test("returns default snapshot id for default preset", () => {
    expect(resolveSandboxBaseSnapshotId("default")).toBe(
      DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
    );
  });

  test("returns browser snapshot id for browser preset", () => {
    expect(resolveSandboxBaseSnapshotId("browser")).toBe(
      BROWSER_SANDBOX_BASE_SNAPSHOT_ID,
    );
  });
});
