#!/usr/bin/env bun

if (process.argv[2] === "mcp") {
  const { startMcpServer } = await import("./mcp.ts");
  await startMcpServer();
} else {
  await import("./cli.tsx");
}
