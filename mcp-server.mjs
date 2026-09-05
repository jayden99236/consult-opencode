#!/usr/bin/env node
// MCP server exposing consult_opencode as a native tool inside any MCP-compatible
// AI chat client (Claude Desktop, Claude Code, Cursor, Windsurf, etc.) - no shell
// commands for the model to construct itself. See README.md for client setup.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MODEL, consultOpencode } from "./lib.mjs";

const server = new McpServer({
  name: "consult-opencode",
  version: "0.1.0",
});

server.registerTool(
  "consult_opencode",
  {
    title: "Consult opencode",
    description:
      "Delegate a self-contained task to opencode as an independent subagent. Defaults to opencode's own free-tier models (no API key needed). Use this to offload isolated work - research lookups, boilerplate, a second opinion - instead of spending your own turn on it.",
    inputSchema: z
      .object({
        task: z.string().min(1).describe("The self-contained task or question to give the subagent"),
        model: z
          .string()
          .optional()
          .describe(
            `Model as "provider/model" (e.g. "${DEFAULT_MODEL}", or "anthropic/claude-haiku-4-5" once configured in opencode). Defaults to ${DEFAULT_MODEL}.`
          ),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ task, model }) => {
    const resolvedModel = model ?? DEFAULT_MODEL;
    try {
      const result = await consultOpencode(task, resolvedModel);
      return {
        content: [{ type: "text", text: result.text || "(subagent returned no text)" }],
        structuredContent: { model: resolvedModel, cost: result.cost },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `opencode subagent (${resolvedModel}) failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("consult-opencode MCP server running on stdio");
}

main().catch((err) => {
  console.error("consult-opencode MCP server failed to start:", err);
  process.exit(1);
});
