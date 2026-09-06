import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpServer } from "../src/mcp.ts";
import { acquireViewLease, highlightCodeRegion, type HighlightResult } from "../src/viewer.ts";

const spawn = Bun.spawn;
const diff = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n";
let root: string;
let sourcePath: string;
let client: Client;
let server: ReturnType<typeof createMcpServer>;
let commands: string[][];
let zedExit: number;
let missingZed: boolean;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tracer-mcp-")));
  sourcePath = path.join(root, "source with 'quotes' $(literal).ts");
  await fs.writeFile(sourcePath, "one\ntwo\nthree\n");
  spyOn(os, "homedir").mockReturnValue(root);
  commands = [];
  zedExit = 0;
  missingZed = false;
  spyOn(Bun, "spawn").mockImplementation(<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(
    input: string[] | (Bun.SpawnOptions.OptionsObject<In, Out, Err> & { cmd: string[] }),
    options?: Bun.SpawnOptions.OptionsObject<In, Out, Err>,
  ) => {
    const command = Array.isArray(input) ? input : input.cmd;
    const spawnOptions = Array.isArray(input) ? options : input;
    commands.push(command);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    if (command[0] === "which") {
      if (missingZed && command[1] === "zed") {
        exitCode = 1;
      } else {
        stdout = `/test/bin/${command[1]}\n`;
      }
    } else if (command[0] === "/test/bin/gh") {
      stdout = diff;
    } else if (command[0] === "/test/bin/zed") {
      exitCode = zedExit;
      if (exitCode) stderr = "Zed launch failed\n";
    } else if (command[0] !== "open" && command[0] !== "/test/bin/ghostty") {
      throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
    }
    return spawn([
      process.execPath, "--eval",
      "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exit(Number(process.argv[3]));",
      stdout, stderr, String(exitCode),
    ], spawnOptions);
  });
  server = createMcpServer();
  client = new Client({ name: "tracer-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  mock.restore();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function highlight(args: Record<string, unknown>) {
  return client.callTool({ name: "highlight_code_region", arguments: args });
}

describe("MCP editor selection", () => {
  test("defaults to Zed range diffs without changing the source or requiring bat", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((tool) => tool.name === "highlight_code_region");
    expect(tool?.inputSchema.properties?.editor).toMatchObject({ default: "zed" });
    expect(tool?.inputSchema.properties?.diff).toMatchObject({ default: true });
    const result = await highlight({ target: "local", path: sourcePath, start_line: 2, end_line: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: { editor: "zed", diff: true, source: sourcePath } });
    const { result: preview } = result.structuredContent as { result: HighlightResult };
    expect(await fs.readFile(preview.baseline_path!, "utf8")).toBe("one\n");
    expect(await fs.readFile(preview.preview_path!, "utf8")).toBe("one\ntwo\nthree\n");
    expect(await fs.readFile(sourcePath, "utf8")).toBe("one\ntwo\nthree\n");
    expect(path.extname(preview.preview_path!)).toBe(".ts");
    expect(commands).toEqual([
      ["which", "zed"],
      ["/test/bin/zed", "--add", "--diff", preview.baseline_path!, `${preview.preview_path}:2`],
    ]);
  });

  test("diff false opens the source path literally at the requested line", async () => {
    const result = await highlight({ target: "local", path: sourcePath, start_line: 2, end_line: 3, diff: false });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: { diff: false } });
    expect(commands).toEqual([
      ["which", "zed"],
      ["/test/bin/zed", "--add", `${sourcePath}:2`],
    ]);
    expect(await fs.readdir(path.join(root, ".tracer"))).toEqual(["viewing"]);
  });

  test("direct callers also default to Zed at line one", async () => {
    const result = await highlightCodeRegion({ target: "local", path: sourcePath, viewer_id: "direct" });
    expect(result.editor).toBe("zed");
    expect(result.diff).toBe(false);
    expect(commands.at(-1)).toEqual(["/test/bin/zed", "--add", `${sourcePath}:1`]);
  });

  test("opens the latest fetched PR diff in Zed", async () => {
    const result = await highlight({ target: "pull_request", pull_request: "42", repository: "owner/repo", start_line: 2, end_line: 3 });
    expect(result.isError).toBeFalsy();
    const { result: preview } = result.structuredContent as { result: HighlightResult };
    expect(preview.editor).toBe("zed");
    expect(preview.diff).toBe(true);
    expect(await fs.readFile(preview.preview_path!, "utf8")).toBe(diff);
    expect(await fs.readFile(preview.baseline_path!, "utf8")).toBe(diff.split("\n")[0] + "\n");
    expect(commands).toEqual([
      ["which", "gh"],
      ["/test/bin/gh", "pr", "diff", "42", "--color=never", "--repo", "owner/repo"],
      ["which", "zed"],
      ["/test/bin/zed", "--add", "--diff", preview.baseline_path!, `${preview.preview_path}:2`],
    ]);
  });

  test("explicit Ghostty preserves diff syntax, range highlighting and context", async () => {
    const result = await highlight({ target: "pull_request", pull_request: "42", repository: "owner/repo", editor: "ghostty", start_line: 2, end_line: 3, context_lines: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: { editor: "ghostty", diff: false } });
    const launched = JSON.stringify(commands);
    expect(launched).toContain("--language=diff");
    expect(launched).toContain("--line-range=1:4");
    expect(launched).toContain("--highlight-line=2:3");
    expect(commands).not.toContainEqual(["which", "zed"]);
  });

  test("returns launch errors and releases the file lease", async () => {
    zedExit = 7;
    const result = await highlight({ target: "local", path: sourcePath, start_line: 1, end_line: 2 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "ZED_LAUNCH_FAILED", details: { exit_code: 7, stderr: "Zed launch failed\n" } } });
    expect(await fs.readdir(path.join(root, ".tracer", "previews"))).toEqual([]);
    const lease = await acquireViewLease(sourcePath, "next-viewer");
    await lease.release();
  });

  test("reports missing Zed without silently opening Ghostty", async () => {
    missingZed = true;
    const result = await highlight({ target: "local", path: sourcePath });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "COMMAND_NOT_FOUND" } });
    expect(commands).toEqual([["which", "zed"]]);
    const lease = await acquireViewLease(sourcePath, "next-viewer");
    await lease.release();
  });

  test("rejects unsupported editors and invalid ranges before launching", async () => {
    expect((await highlight({ target: "local", path: sourcePath, editor: "other" })).isError).toBe(true);
    const result = await highlight({ target: "local", path: sourcePath, start_line: 3, end_line: 2 });
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_LINE_RANGE" } });
    expect(commands).toEqual([]);
  });

  test.each([
    [1, 1, "two\r\nthree"],
    [2, 2, "α\r\nthree"],
    [3, 3, "α\r\ntwo\r\n"],
    [1, 3, ""],
  ])("preserves bytes when removing lines %i through %i", async (start, end, baseline) => {
    const contents = Buffer.from("α\r\ntwo\r\nthree");
    await fs.writeFile(sourcePath, contents);
    const result = await highlightCodeRegion({ target: "local", path: sourcePath, viewer_id: "direct", start_line: start, end_line: end });
    expect(result.diff).toBe(true);
    expect(await fs.readFile(result.baseline_path!)).toEqual(Buffer.from(baseline));
    expect(await fs.readFile(result.preview_path!)).toEqual(contents);
    expect(await fs.readFile(sourcePath)).toEqual(contents);
  });

  test.each(["", "one\n", "one"])("rejects a diff range past EOF for %j", async (contents) => {
    await fs.writeFile(sourcePath, contents);
    const result = await highlight({ target: "local", path: sourcePath, start_line: 1, end_line: 2 });
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_LINE_RANGE" } });
    expect(commands).toEqual([["which", "zed"]]);
    const lease = await acquireViewLease(sourcePath, "next-viewer");
    await lease.release();
  });

  test("removes partial snapshots and releases the lease when writing fails", async () => {
    const writeFile = fs.writeFile;
    spyOn(fs, "writeFile").mockImplementation((file, data, options) => {
      if (String(file).includes(".highlighted")) {
        return Promise.reject(new Error("snapshot write failed"));
      }
      return writeFile(file, data, options);
    });
    const result = await highlight({ target: "local", path: sourcePath, start_line: 1, end_line: 2 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { message: "snapshot write failed" } });
    expect(await fs.readdir(path.join(root, ".tracer", "previews"))).toEqual([]);
    const lease = await acquireViewLease(sourcePath, "next-viewer");
    await lease.release();
  });

  test("removes captured PR data and snapshots when Zed fails", async () => {
    zedExit = 7;
    const result = await highlight({ target: "pull_request", pull_request: "42", repository: "owner/repo", start_line: 1, end_line: 2 });
    expect(result.isError).toBe(true);
    expect(await fs.readdir(path.join(root, ".tracer", "previews"))).toEqual([]);
    const lease = await acquireViewLease("github:owner/repo#42", "next-viewer");
    await lease.release();
  });
});
