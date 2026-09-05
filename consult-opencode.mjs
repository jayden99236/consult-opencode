#!/usr/bin/env node
// consult-opencode: delegate a self-contained task to opencode (https://opencode.ai)
// as a one-shot subagent, from any coding agent that can run a shell command.
//
// Why this exists: an expensive/primary agent (Claude, GPT, etc.) can hand off
// simple, isolated subtasks to opencode's own free-tier models instead of
// spending its own (paid) turns on them - see README.md.
//
// Zero dependencies - only Node built-ins - so any agent can just run this
// file directly with `node`, no npm install required.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = "opencode/big-pickle"; // opencode's own free-tier default - no API key needed

function printHelp() {
  console.log(`consult-opencode - delegate a task to opencode as a subagent

Usage:
  consult-opencode "<task>" [--model <provider/model>]
  echo "<task>" | consult-opencode [--model <provider/model>]

Options:
  --model <provider/model>  Model to use (default: ${DEFAULT_MODEL})
  --json                    Print the full parsed result (text, cost, raw events) as JSON
  -h, --help                Show this help

Examples:
  consult-opencode "Summarize what this function does: ..."
  consult-opencode "Write a regex for US zip codes" --model anthropic/claude-haiku-4-5
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

// Windows note: opencode's compiled binary (opencode.exe) has been observed
// to hang indefinitely when its stdout is an anonymous pipe (Node's default
// for a captured child process) - reproduced consistently across both
// direct-exe and shell-wrapped spawning. Redirecting output to a real file
// and reading it back afterward avoids this reliably, and works fine on
// every platform, so it's used unconditionally rather than only on win32.
async function runOpencode(task, model) {
  const outPath = join(tmpdir(), `consult-opencode-${randomUUID()}.jsonl`);
  const outFd = openSync(outPath, "w");
  try {
    const DIRECT_EXE =
      process.platform === "win32"
        ? join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
        : null;
    const useDirectExe = DIRECT_EXE !== null && existsSync(DIRECT_EXE);
    const command = useDirectExe ? DIRECT_EXE : "opencode";
    const spawnOpts = useDirectExe ? {} : { shell: process.platform === "win32" };

    await new Promise((resolve, reject) => {
      const child = spawn(command, ["run", task, "--model", model, "--format", "json"], {
        ...spawnOpts,
        stdio: ["ignore", outFd, outFd],
        timeout: 300_000,
        env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) reject(new Error(`opencode killed by signal ${signal} (likely timeout)`));
        else if (code !== 0) reject(new Error(`opencode exited with code ${code}`));
        else resolve();
      });
    });
    return readFileSync(outPath, "utf8");
  } finally {
    try {
      closeSync(outFd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(outPath);
    } catch {
      // best-effort cleanup
    }
  }
}

// `opencode run --format json` streams newline-delimited events. Each
// completed text part fires a "text" event keyed by part.id - take the
// latest version of each id, in first-seen order, in case a part updates
// more than once, and sum step_finish costs for a rough total (0 for free
// models).
function parseEvents(raw) {
  const order = [];
  const byId = new Map();
  let cost = 0;
  const events = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    events.push(event);
    if (event.type === "text" && event.part?.id) {
      if (!byId.has(event.part.id)) order.push(event.part.id);
      byId.set(event.part.id, event.part.text ?? "");
    } else if (event.type === "step_finish" && typeof event.part?.cost === "number") {
      cost += event.part.cost;
    }
  }

  return { text: order.map((id) => byId.get(id) ?? "").join(""), cost, events };
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
    const raw = await runOpencode(task, args.model);
    const result = parseEvents(raw);
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
