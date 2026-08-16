import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const STATE_DIRECTORY = ".tracer";
const MANIFEST_NAME = "walkthrough.json";
const LOCK_NAME = "walkthrough.lock";
const EXPLAINED_DIRECTORY = "explained";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  STATE_DIRECTORY,
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

export type ChecklistStatus = "open" | "done" | "all";

export interface WalkthroughManifest {
  version: 1;
  root: string;
  created_at: string;
  updated_at: string;
  files: string[];
}

export interface ChecklistItem {
  path: string;
  status: "open" | "done";
  explained_at?: string;
}

export interface ChecklistPage {
  root: string;
  manifest_path: string;
  total: number;
  open: number;
  done: number;
  offset: number;
  limit: number;
  items: ChecklistItem[];
}

interface ExplainedMarker {
  path: string;
  explained_at: string;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function canonicalRoot(root: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(root));
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Root is not a directory: ${root}`);
  }
  return resolved;
}

function statePaths(root: string) {
  const stateDirectory = path.join(root, STATE_DIRECTORY);
  return {
    stateDirectory,
    manifestPath: path.join(stateDirectory, MANIFEST_NAME),
    lockPath: path.join(stateDirectory, LOCK_NAME),
    explainedDirectory: path.join(stateDirectory, EXPLAINED_DIRECTORY),
  };
}

async function withManifestLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const { stateDirectory, lockPath } = statePaths(root);
  await fs.mkdir(stateDirectory, { recursive: true });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > 5 * 60_000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isErrno(statError, "ENOENT")) {
          throw statError;
        }
      }
      await Bun.sleep(25);
      continue;
    }

    try {
      return await action();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  throw new Error(`Timed out waiting for checklist lock: ${lockPath}`);
}

async function runGitFileList(root: string): Promise<string[] | null> {
  const process = Bun.spawn(
    ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, output] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    return null;
  }
  return output.split("\0").filter(Boolean).sort();
}

async function walkDirectory(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute));
    }
  }
  return files;
}

async function enumerateFiles(root: string): Promise<string[]> {
  const files = (await runGitFileList(root)) ?? (await walkDirectory(root)).sort();
  return files.filter((file) => file !== STATE_DIRECTORY && !file.startsWith(`${STATE_DIRECTORY}/`));
}

async function readManifest(root: string): Promise<WalkthroughManifest> {
  const { manifestPath } = statePaths(root);
  let text: string;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`No checklist exists for ${root}. Run initialize_directory_checklist first.`);
    }
    throw error;
  }

  const value = JSON.parse(text) as WalkthroughManifest;
  if (value.version !== 1 || value.root !== root || !Array.isArray(value.files)) {
    throw new Error(`Invalid checklist manifest: ${manifestPath}`);
  }
  return value;
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, target);
}

function markerName(relativePath: string): string {
  return `${crypto.createHash("sha256").update(relativePath).digest("hex")}.json`;
}

async function readMarker(root: string, relativePath: string): Promise<ExplainedMarker | null> {
  const markerPath = path.join(statePaths(root).explainedDirectory, markerName(relativePath));
  try {
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as ExplainedMarker;
    return marker.path === relativePath ? marker : null;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function writeMarkerOnce(root: string, marker: ExplainedMarker): Promise<ExplainedMarker> {
  const { explainedDirectory } = statePaths(root);
  const markerPath = path.join(explainedDirectory, markerName(marker.path));
  const lockPath = `${markerPath}.lock`;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const existing = await readMarker(root, marker.path);
    if (existing) {
      return existing;
    }

    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      await Bun.sleep(10);
      continue;
    }

    try {
      const completed = await readMarker(root, marker.path);
      if (completed) {
        return completed;
      }
      await atomicWriteJson(markerPath, marker);
      return marker;
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  throw new Error(`Timed out waiting to mark ${marker.path} explained`);
}

async function readMarkers(root: string): Promise<Map<string, ExplainedMarker>> {
  const { explainedDirectory } = statePaths(root);
  let entries: string[];
  try {
    entries = await fs.readdir(explainedDirectory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return new Map();
    }
    throw error;
  }

  const markers = new Map<string, ExplainedMarker>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const markerPath = path.join(explainedDirectory, entry);
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as ExplainedMarker;
      if (marker.path && markerName(marker.path) === entry) {
        markers.set(marker.path, marker);
      } else {
        throw new Error("marker path does not match its filename");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid explained marker ${markerPath}: ${message}`);
    }
  }
  return markers;
}

export async function initializeDirectoryChecklist(rootInput: string): Promise<ChecklistPage> {
  const root = await canonicalRoot(rootInput);
  await withManifestLock(root, async () => {
    const files = await enumerateFiles(root);
    const { manifestPath, explainedDirectory } = statePaths(root);
    await fs.mkdir(explainedDirectory, { recursive: true });

    let createdAt = new Date().toISOString();
    try {
      createdAt = (await readManifest(root)).created_at;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("No checklist exists"))) {
        throw error;
      }
    }

    await atomicWriteJson(manifestPath, {
      version: 1,
      root,
      created_at: createdAt,
      updated_at: new Date().toISOString(),
      files,
    } satisfies WalkthroughManifest);
  });
  return listDirectoryChecklist(root, "all", 0, 100);
}

export async function markFileExplained(
  rootInput: string,
  fileInput: string,
): Promise<ChecklistItem> {
  const root = await canonicalRoot(rootInput);
  const manifest = await readManifest(root);
  const absoluteFile = path.resolve(root, fileInput);
  const relativePath = path.relative(root, absoluteFile);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`File is outside checklist root: ${fileInput}`);
  }
  if (!manifest.files.includes(relativePath)) {
    throw new Error(`File is not in the checklist: ${relativePath}`);
  }

  const { explainedDirectory } = statePaths(root);
  await fs.mkdir(explainedDirectory, { recursive: true });
  const marker: ExplainedMarker = {
    path: relativePath,
    explained_at: new Date().toISOString(),
  };
  const stored = await writeMarkerOnce(root, marker);
  return {
    path: relativePath,
    status: "done",
    explained_at: stored.explained_at,
  };
}

export async function listDirectoryChecklist(
  rootInput: string,
  status: ChecklistStatus = "all",
  offset = 0,
  limit = 100,
): Promise<ChecklistPage> {
  const root = await canonicalRoot(rootInput);
  const manifest = await readManifest(root);
  const markers = await readMarkers(root);
  const allItems = manifest.files.map((file): ChecklistItem => {
    const marker = markers.get(file);
    return marker
      ? {
          path: file,
          status: "done",
          explained_at: marker.explained_at,
        }
      : { path: file, status: "open" };
  });
  const filtered = status === "all" ? allItems : allItems.filter((item) => item.status === status);
  const done = allItems.filter((item) => item.status === "done").length;

  return {
    root,
    manifest_path: statePaths(root).manifestPath,
    total: allItems.length,
    open: allItems.length - done,
    done,
    offset,
    limit,
    items: filtered.slice(offset, offset + limit),
  };
}
