#!/usr/bin/env node
// Claude Code SessionStart hook — loads the shared memory into the session.
// Claude Code adds whatever this prints to Claude's context. It never blocks the session.
//
// Needs the environment variable SHARED_MEMORY_URL = https://<worker>.workers.dev/<TOKEN>
// --remote-only : do nothing unless running in Claude Code on the web (cloud)

import { basename } from "node:path";
import { execFileSync } from "node:child_process";

const isRemote = /^(1|true|yes)$/i.test(process.env.CLAUDE_CODE_REMOTE || "");
if (process.argv.includes("--remote-only") && !isRemote) process.exit(0);

const base = (process.env.SHARED_MEMORY_URL || "").trim().replace(/\/+$/, "");
if (!base) process.exit(0);

const input = await readStdin();
const cwd = input.cwd || process.cwd();
const params = new URLSearchParams({
  project: process.env.SHARED_MEMORY_PROJECT || projectName(cwd),
  surface: process.env.SHARED_MEMORY_SURFACE || (isRemote ? "claude-code-cloud" : "claude-code-local"),
  max: "9000", // keep under Claude Code's hook output limit
});
if (input.session_id) params.set("session_id", input.session_id);

try {
  const res = await fetch(`${base}/context?${params}`, { signal: AbortSignal.timeout(8000) });
  if (res.ok) process.stdout.write(await res.text());
  else process.stderr.write(`shared-memory: could not load memory (HTTP ${res.status})\n`);
} catch (err) {
  process.stderr.write(`shared-memory: could not load memory (${err.message})\n`);
}
process.exit(0);

// ---------------------------------------------------------------------------
async function readStdin() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function projectName(dir) {
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (top) return basename(top);
  } catch {}
  return basename(dir);
}
