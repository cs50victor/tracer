import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { z } from "zod";
import {
  initializeDirectoryChecklist,
  listDirectoryChecklist,
  markFileExplained,
} from "./checklist.ts";
import { highlightCodeRegion, TracerError } from "./viewer.ts";
import { VERSION } from "./version.ts";

const responseSchema = {
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
};

function response(result: unknown) {
  const structuredContent = { result };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const body = {
    error: {
      code: error instanceof TracerError ? error.code : "TRACER_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof TracerError && error.details ? { details: error.details } : {}),
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true as const,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "tracer", version: VERSION });
  const viewerId = `tracer-${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  server.registerTool(
    "highlight_code_region",
    {
      title: "Highlight code region",
      description:
        "Open a local file or the latest GitHub pull request diff in Ghostty using bat. Optional line bounds are inclusive.",
      inputSchema: {
        target: z.enum(["local", "pull_request"]),
        path: z.string().optional().describe("Absolute or working-directory-relative local file path"),
        pull_request: z.string().optional().describe("GitHub PR URL or number"),
        repository: z.string().optional().describe("OWNER/REPO, required for a PR number outside its repository"),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        context_lines: z.number().int().nonnegative().max(500).default(10),
        lease_seconds: z.number().int().min(1).max(3600).default(300),
      },
      outputSchema: responseSchema,
    },
    async (input) => {
      try {
        return response(await highlightCodeRegion({ ...input, viewer_id: viewerId }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "initialize_directory_checklist",
    {
      title: "Initialize directory checklist",
      description:
        "Create or refresh .tracer/walkthrough.json from Git-respected files while preserving completion markers.",
      inputSchema: { root: z.string().describe("Directory to walk through") },
      outputSchema: responseSchema,
    },
    async ({ root }) => {
      try {
        return response(await initializeDirectoryChecklist(root));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "mark_file_explained",
    {
      title: "Mark file explained",
      description: "Atomically mark one checklist file explained. Concurrent calls are idempotent.",
      inputSchema: {
        root: z.string(),
        path: z.string().describe("File path relative to root, or an absolute path inside root"),
      },
      outputSchema: responseSchema,
    },
    async ({ root, path }) => {
      try {
        return response(await markFileExplained(root, path));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_directory_checklist",
    {
      title: "List directory checklist",
      description: "List open, done, or all checklist files with pagination and aggregate counts.",
      inputSchema: {
        root: z.string(),
        status: z.enum(["open", "done", "all"]).default("all"),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(1000).default(100),
      },
      outputSchema: responseSchema,
    },
    async ({ root, status, offset, limit }) => {
      try {
        return response(await listDirectoryChecklist(root, status, offset, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
