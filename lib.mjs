// Shared core: spawn opencode, capture its output, parse the result.
// Used by both consult-opencode.mjs (CLI) and mcp-server.mjs (MCP tool).
// Zero dependencies - only Node built-ins.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "opencode/big-pickle"; // opencode's own free tier - no API key needed

// Windows note: opencode's compiled binary (opencode.exe) has been observed
// to hang indefinitely when its stdout is an anonymous pipe - Node's default
// for a captured child process. Confirmed by direct reproduction: 6/6 runs
// hung with zero output across both direct-exe and shell-wrapped spawning,
// while redirecting to a real file handle worked instantly every time.
// Writing to a temp file and reading it back avoids this reliably, and is
// harmless on other platforms, so it's used unconditionally.
export async function runOpencode(task, model = DEFAULT_MODEL, { signal } = {}) {
  const outPath = join(tmpdir(), `consult-opencode-${randomUUID()}.jsonl`);
  const outFd = openSync(outPath, "w");
  try {
    const directExe =
      process.platform === "win32"
        ? join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
        : null;
    const useDirectExe = directExe !== null && existsSync(directExe);
    const command = useDirectExe ? directExe : "opencode";
    const spawnOpts = useDirectExe ? {} : { shell: process.platform === "win32" };

    await new Promise((resolve, reject) => {
      const child = spawn(command, ["run", task, "--model", model, "--format", "json"], {
        ...spawnOpts,
        stdio: ["ignore", outFd, outFd],
        signal,
        timeout: 300_000,
        env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
      });
      child.on("error", reject);
      child.on("exit", (code, sig) => {
        if (sig) reject(new Error(`opencode killed by signal ${sig} (likely timeout)`));
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
export function parseEvents(raw) {
  const order = [];
  const byId = new Map();
  let cost = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "text" && event.part?.id) {
      if (!byId.has(event.part.id)) order.push(event.part.id);
      byId.set(event.part.id, event.part.text ?? "");
    } else if (event.type === "step_finish" && typeof event.part?.cost === "number") {
      cost += event.part.cost;
    }
  }

  return { text: order.map((id) => byId.get(id) ?? "").join(""), cost };
}

export async function consultOpencode(task, model = DEFAULT_MODEL, opts = {}) {
  const raw = await runOpencode(task, model, opts);
  return parseEvents(raw);
}
