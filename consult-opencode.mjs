#!/usr/bin/env node
// consult-opencode: delegate a self-contained task to opencode (https://opencode.ai)
// as a one-shot subagent, from any coding agent that can run a shell command.
//
// Why this exists: an expensive/primary agent (Claude, GPT, etc.) can hand off
// simple, isolated subtasks to opencode's own free-tier models instead of
// spending its own (paid) turns on them - see README.md.
//
// For direct integration into an AI chat client instead of shelling out to
// this script, see mcp-server.mjs.

import { DEFAULT_MODEL, consultOpencode } from "./lib.mjs";

function printHelp() {
  console.log(`consult-opencode - delegate a task to opencode as a subagent

Usage:
  consult-opencode "<task>" [--model <provider/model>]
  echo "<task>" | consult-opencode [--model <provider/model>]

Options:
  --model <provider/model>  Model to use (default: ${DEFAULT_MODEL})
  --json                    Print the full parsed result (text, cost) as JSON
  -h, --help                Show this help

Examples:
  consult-opencode "Summarize what this function does: ..."
  consult-opencode "Write a regex for US zip codes" --model anthropic/claude-haiku-4-5

To wire this into an AI chat client directly (Claude Desktop, Claude Code,
Cursor, etc.) instead of shelling out to this script, use the MCP server
(mcp-server.mjs) - see README.md.
`);
}

function parseArgs(argv) {
  const args = { model: DEFAULT_MODEL, json: false, task: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--model") {
      args.model = argv[++i];
    } else if (a.startsWith("--model=")) {
      args.model = a.slice("--model=".length);
    } else {
      rest.push(a);
    }
  }
  args.task = rest.join(" ").trim() || null;
  return args;
}

async function readStdinIfPiped() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const task = args.task ?? (await readStdinIfPiped());
  if (!task) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const result = await consultOpencode(task, args.model);
    if (args.json) {
      console.log(JSON.stringify({ model: args.model, text: result.text, cost: result.cost }, null, 2));
    } else {
      console.log(result.text || "(subagent returned no text)");
    }
  } catch (err) {
    console.error(`consult-opencode failed (model: ${args.model}): ${err.message}`);
    process.exitCode = 1;
  }
}

main();
