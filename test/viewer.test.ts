import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireViewLease, buildBatArguments, pullRequestViewSource } from "../src/viewer.ts";

describe("bat command construction", () => {
  test("builds an inclusive local range with bounded context", () => {
    expect(buildBatArguments("/opt/homebrew/bin/bat", "/tmp/huge.ts", 100, 200, 20)).toEqual([
      "/opt/homebrew/bin/bat",
      "--paging=always",
      "--line-range=80:220",
      "--highlight-line=100:200",
      "--",
      "/tmp/huge.ts",
    ]);
  });

  test("sets diff syntax without a range", () => {
    expect(buildBatArguments("bat", "/tmp/pr.diff", undefined, undefined, 10, "diff")).toEqual([
      "bat",
      "--paging=always",
      "--language=diff",
      "--",
      "/tmp/pr.diff",
    ]);
  });

  test("rejects incomplete or reversed ranges", () => {
    expect(() => buildBatArguments("bat", "/tmp/file", 10)).toThrow("provided together");
    expect(() => buildBatArguments("bat", "/tmp/file", 20, 10)).toThrow("end_line >= start_line");
  });
});

describe("pull request identity", () => {
  test("normalizes URL and repository-number forms to the same lease key", () => {
    expect(pullRequestViewSource("https://github.com/CS50Victor/Tracer/pull/42")).toBe(
      "github:cs50victor/tracer#42",
    );
    expect(pullRequestViewSource("https://github.com/CS50Victor/Tracer/pull/42?diff=split")).toBe(
      "github:cs50victor/tracer#42",
    );
    expect(pullRequestViewSource("42", "CS50Victor/Tracer")).toBe("github:cs50victor/tracer#42");
  });

  test("does not normalize non-PR GitHub URLs", () => {
    const input = "https://github.com/cs50victor/tracer/issues/42";
    expect(pullRequestViewSource(input)).toBe(`github:${input}`);
  });
});

describe("view ownership", () => {
  test("reports the agent that already owns a file view", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tracer-view-"));
    try {
      const first = await acquireViewLease("/tmp/example.ts", "agent-one", 60, stateRoot);
      const renewed = await acquireViewLease("/tmp/example.ts", "agent-one", 120, stateRoot);
      expect(renewed.lease.viewer_id).toBe("agent-one");
      await expect(acquireViewLease("/tmp/example.ts", "agent-two", 60, stateRoot)).rejects.toMatchObject({
        code: "VIEW_CONFLICT",
        details: { viewing_session: "agent-one", requested_session: "agent-two" },
      });
      await first.release();
      const second = await acquireViewLease("/tmp/example.ts", "agent-two", 60, stateRoot);
      await second.release();
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });
});
