import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

export type HighlightTarget = "local" | "pull_request";

export interface HighlightRequest {
  target: HighlightTarget;
  viewer_id: string;
  path?: string;
  pull_request?: string;
  repository?: string;
  start_line?: number;
  end_line?: number;
  context_lines?: number;
  lease_seconds?: number;
}

export interface HighlightResult {
  target: HighlightTarget;
  source: string;
  viewer_id: string;
  viewing_until: string;
  start_line?: number;
  end_line?: number;
  preview_path?: string;
}

export class TracerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TracerError";
  }
}

interface ViewLease {
  source: string;
  viewer_id: string;
  started_at: string;
  expires_at: string;
}

interface AcquiredViewLease {
  lease: ViewLease;
  release: () => Promise<void>;
}

function viewLeasePath(source: string, stateRoot: string): string {
  const key = crypto.createHash("sha256").update(source).digest("hex");
  return path.join(stateRoot, "viewing", key);
}

export async function acquireViewLease(
  source: string,
  viewerId: string,
  leaseSeconds = 300,
  stateRoot = path.join(os.homedir(), ".tracer"),
): Promise<AcquiredViewLease> {
  const duration = Math.max(1, Math.min(3600, Math.floor(leaseSeconds)));
  const leasePath = viewLeasePath(source, stateRoot);
  const markerPath = path.join(leasePath, "lease.json");
  await fs.mkdir(path.dirname(leasePath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(leasePath);
      const now = new Date();
      const lease: ViewLease = {
        source,
        viewer_id: viewerId,
        started_at: now.toISOString(),
        expires_at: new Date(now.getTime() + duration * 1000).toISOString(),
      };
      await fs.writeFile(markerPath, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
      return {
        lease,
        release: () => fs.rm(leasePath, { recursive: true, force: true }),
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        await fs.rm(leasePath, { recursive: true, force: true });
        throw error;
      }

      let existing: ViewLease | null = null;
      try {
        existing = JSON.parse(await fs.readFile(markerPath, "utf8")) as ViewLease;
      } catch {
        await Bun.sleep(25);
      }
      if (existing && Date.parse(existing.expires_at) > Date.now()) {
        if (existing.viewer_id === viewerId) {
          const renewed: ViewLease = {
            ...existing,
            expires_at: new Date(Date.now() + duration * 1000).toISOString(),
          };
          const temporary = `${markerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
          await fs.writeFile(temporary, `${JSON.stringify(renewed, null, 2)}\n`, { flag: "wx" });
          await fs.rename(temporary, markerPath);
          return { lease: renewed, release: async () => {} };
        }
        throw new TracerError(
          "VIEW_CONFLICT",
          `${source} is already being viewed by another Tracer MCP session: ${existing.viewer_id}`,
          {
            source,
            requested_session: viewerId,
            viewing_session: existing.viewer_id,
            started_at: existing.started_at,
            expires_at: existing.expires_at,
          },
        );
      }
      await fs.rm(leasePath, { recursive: true, force: true });
    }
  }

  throw new TracerError("VIEW_LEASE_FAILED", `Could not claim a viewing lease for ${source}`);
}

async function commandPath(command: string): Promise<string> {
  const process = Bun.spawn(["which", command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, output, errorOutput] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const resolved = output.trim();
  if (exitCode !== 0 || !resolved) {
    throw new TracerError("COMMAND_NOT_FOUND", `Required command not found: ${command}`, {
      command: ["which", command],
      exit_code: exitCode,
      stderr: errorOutput,
    });
  }
  return resolved;
}

function validateRange(startLine?: number, endLine?: number): void {
  if ((startLine === undefined) !== (endLine === undefined)) {
    throw new TracerError("INVALID_LINE_RANGE", "start_line and end_line must be provided together");
  }
  if (startLine !== undefined && endLine !== undefined) {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new TracerError(
        "INVALID_LINE_RANGE",
        "Line range must use positive integers with end_line >= start_line",
        { start_line: startLine, end_line: endLine },
      );
    }
  }
}

export function buildBatArguments(
  batPath: string,
  sourcePath: string,
  startLine?: number,
  endLine?: number,
  contextLines = 10,
  language?: string,
): string[] {
  validateRange(startLine, endLine);
  const args = [batPath, "--paging=always"];
  if (language) {
    args.push(`--language=${language}`);
  }
  if (startLine !== undefined && endLine !== undefined) {
    const context = Math.max(0, Math.floor(contextLines));
    args.push(`--line-range=${Math.max(1, startLine - context)}:${endLine + context}`);
    args.push(`--highlight-line=${startLine}:${endLine}`);
  }
  args.push("--", sourcePath);
  return args;
}

async function launchGhostty(command: string[]): Promise<void> {
  if (process.platform === "darwin") {
    const check = Bun.spawn(["open", "-Ra", "Ghostty"], { stdout: "ignore", stderr: "pipe" });
    if ((await check.exited) !== 0) {
      throw new TracerError(
        "GHOSTTY_NOT_FOUND",
        "Ghostty.app is required. Install it with: brew install --cask ghostty",
      );
    }
    const launch = Bun.spawn(["open", "-na", "Ghostty.app", "--args", "-e", ...command], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await launch.exited) !== 0) {
      const stderr = (await new Response(launch.stderr).text()).trim();
      throw new TracerError("GHOSTTY_LAUNCH_FAILED", stderr || "Ghostty failed to open", {
        command: ["open", "-na", "Ghostty.app", "--args", "-e", ...command],
        exit_code: launch.exitCode,
        stderr,
      });
    }
    await Bun.spawn(["open", "-a", "Ghostty"], { stdout: "ignore", stderr: "ignore" }).exited;
    return;
  }

  const ghostty = await commandPath("ghostty");
  const ghosttyProcess = Bun.spawn([ghostty, "-e", ...command], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  ghosttyProcess.unref();
}

async function capturePullRequestDiff(pullRequest: string, repository?: string): Promise<string> {
  const gh = await commandPath("gh");
  const args = [gh, "pr", "diff", pullRequest, "--color=never"];
  if (repository) {
    args.push("--repo", repository);
  }
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, output, errorOutput] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new TracerError("GH_PR_DIFF_FAILED", errorOutput.trim() || `gh pr diff exited with ${exitCode}`, {
      command: args,
      exit_code: exitCode,
      stderr: errorOutput,
    });
  }

  const previewDirectory = path.join(os.homedir(), ".tracer", "previews");
  await fs.mkdir(previewDirectory, { recursive: true });
  const previewPath = path.join(previewDirectory, `pr-${Date.now()}-${crypto.randomUUID()}.diff`);
  await fs.writeFile(previewPath, new Uint8Array(output), { flag: "wx" });
  return previewPath;
}

async function pruneOldPreviews(): Promise<void> {
  const previewDirectory = path.join(os.homedir(), ".tracer", "previews");
  let entries: string[];
  try {
    entries = await fs.readdir(previewDirectory);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(previewDirectory, entry);
      try {
        if ((await fs.stat(file)).mtimeMs < cutoff) {
          await fs.rm(file, { force: true });
        }
      } catch {
        // A concurrent process may already have removed the preview.
      }
    }),
  );
}

export function pullRequestViewSource(pullRequest: string, repository?: string): string {
  const value = pullRequest.trim();
  if (URL.canParse(value)) {
    const url = new URL(value);
    const [owner, repo, resource, numberText, ...extra] = url.pathname.split("/").filter(Boolean);
    const pullRequestNumber = Number(numberText);
    if (
      url.origin === "https://github.com" &&
      owner &&
      repo &&
      resource === "pull" &&
      extra.length === 0 &&
      Number.isSafeInteger(pullRequestNumber) &&
      pullRequestNumber > 0 &&
      String(pullRequestNumber) === numberText
    ) {
      return `github:${owner.toLowerCase()}/${repo.toLowerCase()}#${pullRequestNumber}`;
    }
  }
  if (repository) {
    return `github:${repository.toLowerCase()}#${value}`;
  }
  return `github:${value}`;
}

export async function highlightCodeRegion(request: HighlightRequest): Promise<HighlightResult> {
  validateRange(request.start_line, request.end_line);
  const bat = await commandPath("bat");
  await pruneOldPreviews();

  if (request.target === "local") {
    if (!request.path) {
      throw new TracerError("MISSING_PATH", "path is required when target is local");
    }
    let sourcePath: string;
    try {
      sourcePath = await fs.realpath(path.resolve(request.path));
    } catch (error) {
      throw new TracerError("FILE_ACCESS_FAILED", error instanceof Error ? error.message : String(error), {
        path: path.resolve(request.path),
        system_code: error instanceof Error && "code" in error ? error.code : undefined,
      });
    }
    if (!(await fs.stat(sourcePath)).isFile()) {
      throw new TracerError("NOT_A_FILE", `Path is not a file: ${request.path}`, { path: sourcePath });
    }
    const acquired = await acquireViewLease(sourcePath, request.viewer_id, request.lease_seconds);
    const command = buildBatArguments(
      bat,
      sourcePath,
      request.start_line,
      request.end_line,
      request.context_lines,
    );
    try {
      await launchGhostty(command);
    } catch (error) {
      await acquired.release();
      throw error;
    }
    return {
      target: "local",
      source: sourcePath,
      viewer_id: request.viewer_id,
      viewing_until: acquired.lease.expires_at,
      ...(request.start_line ? { start_line: request.start_line, end_line: request.end_line } : {}),
    };
  }

  if (!request.pull_request) {
    throw new TracerError("MISSING_PULL_REQUEST", "pull_request is required when target is pull_request");
  }
  const source = pullRequestViewSource(request.pull_request, request.repository);
  const acquired = await acquireViewLease(source, request.viewer_id, request.lease_seconds);
  let previewPath: string;
  try {
    previewPath = await capturePullRequestDiff(request.pull_request, request.repository);
    const command = buildBatArguments(
      bat,
      previewPath,
      request.start_line,
      request.end_line,
      request.context_lines,
      "diff",
    );
    await launchGhostty(command);
  } catch (error) {
    await acquired.release();
    throw error;
  }
  return {
    target: "pull_request",
    source: request.pull_request,
    viewer_id: request.viewer_id,
    viewing_until: acquired.lease.expires_at,
    preview_path: previewPath,
    ...(request.start_line ? { start_line: request.start_line, end_line: request.end_line } : {}),
  };
}
