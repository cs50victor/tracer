import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initializeDirectoryChecklist,
  listDirectoryChecklist,
  markFileExplained,
} from "../src/checklist.ts";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tracer-checklist-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "README.md"), "# Fixture\n");
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("directory checklist", () => {
  test("initializes a JSON manifest and filters open and done files", async () => {
    const root = await fixture();
    const initialized = await initializeDirectoryChecklist(root);
    expect(initialized.total).toBe(2);
    expect(initialized.open).toBe(2);
    expect(JSON.parse(await fs.readFile(initialized.manifest_path, "utf8")).files).toEqual([
      "README.md",
      "src/index.ts",
    ]);

    const marked = await markFileExplained(root, "src/index.ts");
    expect(marked).toMatchObject({ path: "src/index.ts", status: "done" });

    const open = await listDirectoryChecklist(root, "open");
    const done = await listDirectoryChecklist(root, "done");
    expect(open.items.map((item) => item.path)).toEqual(["README.md"]);
    expect(done.items.map((item) => item.path)).toEqual(["src/index.ts"]);
    expect(done.done).toBe(1);
  });

  test("preserves markers when refreshing the file list", async () => {
    const root = await fixture();
    await initializeDirectoryChecklist(root);
    await markFileExplained(root, "README.md");
    await fs.writeFile(path.join(root, "src", "new.ts"), "export {};\n");

    const refreshed = await initializeDirectoryChecklist(root);
    expect(refreshed.total).toBe(3);
    expect(refreshed.done).toBe(1);
    expect(refreshed.items.find((item) => item.path === "README.md")?.status).toBe("done");
  });

  test("handles concurrent idempotent marks from separate callers", async () => {
    const root = await fixture();
    await initializeDirectoryChecklist(root);
    await Promise.all(
      Array.from({ length: 50 }, () => markFileExplained(root, "README.md")),
    );

    const done = await listDirectoryChecklist(root, "done");
    expect(done.done).toBe(1);
    expect(done.items).toHaveLength(1);
    const markerFiles = await fs.readdir(path.join(root, ".tracer", "explained"));
    expect(markerFiles).toHaveLength(1);
  });

  test("rejects files outside the checklist root", async () => {
    const root = await fixture();
    await initializeDirectoryChecklist(root);
    await expect(markFileExplained(root, "../outside.ts")).rejects.toThrow("outside checklist root");
  });
});
