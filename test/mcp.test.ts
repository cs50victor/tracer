import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpServer } from "../src/mcp.ts";
import { acquireViewLease, highlightCodeRegion } from "../src/viewer.ts";

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
  test("defaults to Zed and passes the path literally without requiring bat or Ghostty", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((tool) => tool.name === "highlight_code_region");
    expect(tool?.inputSchema.properties?.editor).toMatchObject({ default: "zed" });
    const result = await highlight({ target: "local", path: sourcePath, start_line: 2, end_line: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: { editor: "zed", source: sourcePath } });
    expect(commands).toEqual([
      ["which", "zed"],
      ["/test/bin/zed", "--add", `${sourcePath}:2`],
    ]);
  });

  test("direct callers also default to Zed at line one", async () => {
    const result = await highlightCodeRegion({ target: "local", path: sourcePath, viewer_id: "direct" });
    expect(result.editor).toBe("zed");
    expect(commands.at(-1)).toEqual(["/test/bin/zed", "--add", `${sourcePath}:1`]);
  });

  test("opens the latest fetched PR diff in Zed", async () => {
    const result = await highlight({ target: "pull_request", pull_request: "42", repository: "owner/repo", start_line: 2, end_line: 3 });
    expect(result.isError).toBeFalsy();
    const { result: preview } = result.structuredContent as { result: { preview_path: string; editor: string } };
    expect(preview.editor).toBe("zed");
    expect(await fs.readFile(preview.preview_path, "utf8")).toBe(diff);
    expect(commands).toEqual([
      ["which", "gh"],
      ["/test/bin/gh", "pr", "diff", "42", "--color=never", "--repo", "owner/repo"],
      ["which", "zed"],
      ["/test/bin/zed", "--add", `${preview.preview_path}:2`],
    ]);
  });

  test("explicit Ghostty preserves diff syntax, range highlighting and context", async () => {
    const result = await highlight({ target: "pull_request", pull_request: "42", repository: "owner/repo", editor: "ghostty", start_line: 2, end_line: 3, context_lines: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: { editor: "ghostty" } });
    const launched = JSON.stringify(commands);
    expect(launched).toContain("--language=diff");
    expect(launched).toContain("--line-range=1:4");
    expect(launched).toContain("--highlight-line=2:3");
    expect(commands).not.toContainEqual(["which", "zed"]);
  });

  test("returns launch errors and releases the file lease", async () => {
    zedExit = 7;
    const result = await highlight({ target: "local", path: sourcePath });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "ZED_LAUNCH_FAILED", details: { exit_code: 7, stderr: "Zed launch failed\n" } } });
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
});
