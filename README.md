# consult-opencode

Delegate a self-contained task to [opencode](https://opencode.ai) as a one-shot subagent, from any coding agent (or human) that can run a shell command.

## Why

If you're driving an expensive/primary coding agent (Claude, GPT, etc.) through a session, it's often wasteful to spend one of its own turns on something small and self-contained: summarizing a file, drafting a regex, writing a boilerplate test, getting a second opinion. `opencode` ships its own free-tier models under the `opencode/` provider namespace — zero config, no API key required. This script shells out to `opencode run` and hands back plain text, so any agent (or script) can use it as a cheap delegation target.

## Requirements

- [Node.js](https://nodejs.org) >= 18
- [`opencode`](https://opencode.ai) installed and on your `PATH`:
  ```bash
  npm install -g opencode-ai
  ```

No other dependencies — this is a single zero-dependency script.

## Usage

```bash
node consult-opencode.mjs "Summarize what this function does: ..."
```

Or install it globally to get a `consult-opencode` command:

```bash
npm install -g .
consult-opencode "Write a regex for US zip codes"
```

Pipe a task in instead of passing it as an argument:

```bash
cat some-file.js | consult-opencode "Explain what this file does"
```

### Options

| Flag | Description |
|---|---|
| `--model <provider/model>` | Model to use (default: `opencode/big-pickle`, opencode's free tier). Once you've authenticated another provider in opencode (`opencode providers login`), you can point this at it, e.g. `--model anthropic/claude-haiku-4-5`. |
| `--json` | Print `{ model, text, cost }` as JSON instead of plain text. |
| `-h`, `--help` | Show usage. |

### From another agent

Most coding agents can just run this as a shell command and read its stdout:

```bash
node /path/to/consult-opencode.mjs "task description here"
```

Exit code is non-zero on failure, with the error on stderr; stdout carries only the result text (or the JSON blob with `--json`), so it composes cleanly in scripts and pipelines.

## The Windows gotcha this script works around

`opencode`'s compiled Windows binary (`opencode.exe`) has been observed to **hang indefinitely** when its stdout is an anonymous pipe — which is exactly what Node's `child_process` gives you by default when you capture a child process's output. This reproduced consistently (6/6 runs) across both a direct `.exe` spawn and a shell-wrapped one.

The fix: redirect the child's stdout/stderr to a real temp file on disk, then read the file back once the process exits, instead of piping. This works reliably on Windows and is harmless on other platforms, so `consult-opencode` always does it this way regardless of OS.

If you're integrating with opencode from your own Node tooling and see a hang with zero output, this is almost certainly why.

## License

MIT
