// Shared core: spawn opencode, capture its output, parse the result.
// Used by both consult-opencode.mjs (CLI) and mcp-server.mjs (MCP tool).
// Zero dependencies - only Node built-ins.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "opencode/big-pickle"; // opencode's own free tier - no API key needed
const DEFAULT_TIMEOUT_MS = 300_000;
const DIAGNOSTICS_TAIL_CHARS = 2000; // how much captured output to attach to a failure's error message

// Windows note: opencode's compiled binary (opencode.exe) has been observed
// to hang indefinitely when its stdout is an anonymous pipe - Node's default
// for a captured child process. Confirmed by direct reproduction: 6/6 runs
// hung with zero output across both direct-exe and shell-wrapped spawning,
// while redirecting to a real file handle worked instantly every time.
// Writing to a temp file and reading it back avoids this reliably, and is
// harmless on other platforms, so it's used unconditionally. stdout and
// stderr share one file, so real diagnostics (an opencode error message, a
// stack trace) survive even when the process never emits a clean JSON event.
export async function runOpencode(task, model = DEFAULT_MODEL, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const outPath = join(tmpdir(), `consult-opencode-${randomUUID()}.jsonl`);
  const outFd = openSync(outPath, "w");
  let child;
  let timedOut = false;

  // A plain child.kill()/SIGTERM only signals the one process by PID. If
  // opencode.exe ever spawns its own child processes (its "run" command
  // talks in sessionID/messageID terms suggestive of an internal
  // client/server split - unconfirmed whether that means a real subprocess),
  // that leaves orphans running after we've already given up and moved on.
  // Killing the whole tree - taskkill /T on Windows, the process group via a
  // negative pid on POSIX - avoids that regardless.
  function killTree() {
    if (!child?.pid) return;
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      } catch {
        // best-effort
      }
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }
    }
  }

  const onAbort = () => killTree();
  signal?.addEventListener("abort", onAbort);

  try {
    const directExe =
      process.platform === "win32"
        ? join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
        : null;
    const useDirectExe = directExe !== null && existsSync(directExe);
    const command = useDirectExe ? directExe : "opencode";
    const spawnOpts = useDirectExe ? {} : { shell: process.platform === "win32" };

    child = spawn(command, ["run", task, "--model", model, "--format", "json"], {
      ...spawnOpts,
      stdio: ["ignore", outFd, outFd],
      // Forms a process group on POSIX so killTree's negative-pid kill can
      // reach the whole tree, not just this one process. Not needed on
      // Windows, where taskkill /T walks the tree directly by parent PID.
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    try {
      await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, sig) => {
          if (timedOut) reject(new Error(`opencode timed out after ${timeoutMs}ms and was force-killed (including any child processes)`));
          else if (sig) reject(new Error(`opencode was killed by signal ${sig}`));
          else if (code !== 0) reject(new Error(`opencode exited with code ${code}`));
          else resolve();
        });
      });
    } finally {
      clearTimeout(timer);
    }

    return readFileSync(outPath, "utf8");
  } catch (err) {
    // Surface whatever was captured (stdout+stderr) before we throw it away
    // in `finally` below - this is often the actual reason for the failure
    // (opencode's own error output) rather than just a bare exit code.
    let tail = "";
    try {
      tail = readFileSync(outPath, "utf8").trim().slice(-DIAGNOSTICS_TAIL_CHARS);
    } catch {
      // nothing captured
    }
    if (tail) err.message += `\n--- captured opencode output (last ${DIAGNOSTICS_TAIL_CHARS} chars) ---\n${tail}`;
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
