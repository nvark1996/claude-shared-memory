#!/usr/bin/env node
// Connects Claude Code to your shared memory.
//
//   On your computer (run once):
//     node install.mjs https://shared-memory.<you>.workers.dev/<TOKEN>
//
//   For Claude Code in the cloud (run once per GitHub repo you use there, then commit + push):
//     node install.mjs --repo /path/to/your/repo
//
//   Remove from your computer:
//     node install.mjs --uninstall

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_FILES = ["memory-start.mjs", "memory-sync.mjs"];
const MARK_START = "<!-- shared-memory:start -->";
const MARK_END = "<!-- shared-memory:end -->";
const isWindows = platform() === "win32";

const USER_BLOCK = `
## Shared memory
I use one memory across Claude web/app, Claude Code on my computer and Claude Code in the cloud — the MCP server "shared-memory". Its context is loaded at the start of every session.
- Before working on a client or project, read its /areas/ file (memory_read) if one exists.
- When you learn something durable (a decision, preference, client fact, status change), update the right memory file: read it, then memory_replace or memory_append.
- After meaningful work, call session_log with the session id from the memory context and a 3–8 line summary (what was done, decisions, open items).
- To find something from another chat or session, use memory_search, then session_read.
- Never save passwords, API keys, tokens or card/bank numbers to memory.
`;

const REPO_BLOCK = `
## Shared memory
This repo is connected to my shared memory (MCP server "shared-memory"), the same memory I use in Claude web and Claude Code on my computer. Read the relevant /areas/ file before working, update memory files when you learn durable facts, and call session_log with a short summary after meaningful work.
`;

const args = process.argv.slice(2);
const ok = (m) => console.log(`\x1b[32m✔\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const fail = (m) => {
  console.error(`\x1b[31m✖ ${m}\x1b[0m`);
  process.exit(1);
};

if (args.includes("--uninstall")) uninstall();
else if (args.includes("--repo")) installRepo(args[args.indexOf("--repo") + 1]);
else await installLocal(args.find((a) => /^https?:\/\//.test(a)) || readSavedBaseUrl());

// ---------------------------------------------------------------------------
// Your computer
// ---------------------------------------------------------------------------
async function installLocal(baseUrl) {
  if (!baseUrl) fail("Pass your BASE URL: node install.mjs https://shared-memory.<you>.workers.dev/<TOKEN>");
  const base = baseUrl.trim().replace(/\/+$/, "").replace(/\/mcp$/, "");

  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000) });
    if ((await res.text()).trim() !== "ok") fail(`The server answered, but not with "ok" (HTTP ${res.status}). Check the URL and token.`);
    ok("Server reachable");
  } catch (err) {
    fail(`Cannot reach ${base}/health (${err.message}).`);
  }

  const claudeDir = join(homedir(), ".claude");
  const hookDir = join(claudeDir, "hooks", "shared-memory");
  mkdirSync(hookDir, { recursive: true });
  for (const f of HOOK_FILES) copyFileSync(join(here, "hooks", f), join(hookDir, f));
  ok(`Hooks copied to ${hookDir}`);

  const hookCmd = (f) => `node "${join(hookDir, f).replace(/\\/g, "/")}"`;
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJson(settingsPath);
  settings.env = { ...(settings.env || {}), SHARED_MEMORY_URL: base };
  setHooks(settings, hookCmd("memory-start.mjs"), hookCmd("memory-sync.mjs"));
  writeJson(settingsPath, settings);
  ok(`Hooks + SHARED_MEMORY_URL added to ${settingsPath}`);

  upsertBlock(join(claudeDir, "CLAUDE.md"), USER_BLOCK);
  ok("Memory instructions added to ~/.claude/CLAUDE.md");

  setOsEnv(base);

  const mcpUrl = `${base}/mcp`;
  try {
    execSync("claude mcp remove shared-memory -s user", { stdio: "ignore" });
  } catch {}
  try {
    execSync(`claude mcp add --transport http --scope user shared-memory "${mcpUrl}"`, { stdio: "ignore" });
    ok("MCP server 'shared-memory' added to Claude Code (all projects)");
  } catch {
    warn("Could not run the `claude` command. Add the server yourself:");
    console.log(`    claude mcp add --transport http --scope user shared-memory "${mcpUrl}"`);
  }

  console.log("\nDone. Start a new Claude Code session — it will load your shared memory automatically.");
  console.log("Check it with /mcp (shared-memory should be connected) or ask: \"what's in my shared memory?\"");
}

// ---------------------------------------------------------------------------
// A repo for Claude Code in the cloud
// ---------------------------------------------------------------------------
function installRepo(repoArg) {
  if (!repoArg) fail("Pass the repo folder: node install.mjs --repo /path/to/repo");
  const repo = resolve(repoArg);
  if (!existsSync(repo)) fail(`${repo} does not exist.`);

  const hookDir = join(repo, ".claude", "hooks", "shared-memory");
  mkdirSync(hookDir, { recursive: true });
  for (const f of HOOK_FILES) copyFileSync(join(here, "hooks", f), join(hookDir, f));

  // --remote-only: these hooks only act in cloud sessions, so they never double up with the hooks on your computer.
  const hookCmd = (f) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/shared-memory/${f}" --remote-only`;
  const settingsPath = join(repo, ".claude", "settings.json");
  const settings = readJson(settingsPath);
  setHooks(settings, hookCmd("memory-start.mjs"), hookCmd("memory-sync.mjs"));
  writeJson(settingsPath, settings);

  // The URL is read from an environment variable, so your secret token is never committed.
  // The fallback keeps .mcp.json valid where the variable isn't set (the server just won't connect there).
  const mcpPath = join(repo, ".mcp.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers = {
    ...(mcp.mcpServers || {}),
    "shared-memory": { type: "http", url: "${SHARED_MEMORY_URL:-https://shared-memory-not-configured.invalid}/mcp" },
  };
  writeJson(mcpPath, mcp);

  upsertBlock(join(repo, "CLAUDE.md"), REPO_BLOCK);

  ok(`Repo prepared: ${repo}`);
  console.log(`
Files added or updated (commit and push them):
  .claude/hooks/shared-memory/memory-start.mjs
  .claude/hooks/shared-memory/memory-sync.mjs
  .claude/settings.json
  .mcp.json
  CLAUDE.md

In Claude Code on the web, edit the cloud environment you use for this repo:
  • Environment variable:  SHARED_MEMORY_URL=<your BASE URL>
  • Network access: allow your workers.dev domain (custom allowlist) or choose full access.
`);
}

// ---------------------------------------------------------------------------
// Uninstall from your computer
// ---------------------------------------------------------------------------
function uninstall() {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  if (existsSync(settingsPath)) {
    const s = readJson(settingsPath);
    if (s.env) delete s.env.SHARED_MEMORY_URL;
    setHooks(s, null, null);
    writeJson(settingsPath, s);
  }
  removeBlock(join(claudeDir, "CLAUDE.md"));
  rmSync(join(claudeDir, "hooks", "shared-memory"), { recursive: true, force: true });
  try {
    execSync("claude mcp remove shared-memory -s user", { stdio: "ignore" });
  } catch {}
  removeOsEnv();
  ok("Removed from Claude Code on this computer. Your memory on the server is untouched.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setHooks(settings, startCmd, syncCmd) {
  settings.hooks = settings.hooks || {};
  for (const [event, cmd] of [
    ["SessionStart", startCmd],
    ["Stop", syncCmd],
  ]) {
    const groups = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || "").includes("shared-memory/memory-")) }))
      .filter((g) => g.hooks.length);
    if (cmd) groups.push({ hooks: [{ type: "command", command: cmd, timeout: event === "Stop" ? 20 : 15 }] });
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

function setOsEnv(base) {
  // Lets a repo's .mcp.json (${SHARED_MEMORY_URL}) work on this computer too.
  try {
    if (isWindows) {
      execSync(`setx SHARED_MEMORY_URL "${base}"`, { stdio: "ignore" });
      ok("SHARED_MEMORY_URL saved as a Windows user environment variable");
      return;
    }
    const line = `export SHARED_MEMORY_URL="${base}" # shared-memory`;
    const files = [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(homedir(), f)).filter(existsSync);
    if (!files.length) files.push(join(homedir(), platform() === "darwin" ? ".zshrc" : ".bashrc"));
    for (const f of files) {
      const current = existsSync(f) ? readFileSync(f, "utf8") : "";
      const cleaned = current.split("\n").filter((l) => !l.includes("# shared-memory")).join("\n").replace(/\n*$/, "\n");
      writeFileSync(f, `${cleaned}${line}\n`);
    }
    ok(`SHARED_MEMORY_URL added to ${files.map((f) => f.replace(homedir(), "~")).join(", ")}`);
  } catch {
    warn("Could not save SHARED_MEMORY_URL as a system environment variable (only needed for repos prepared with --repo).");
  }
}

function removeOsEnv() {
  try {
    if (isWindows) {
      execSync('reg delete "HKCU\\Environment" /v SHARED_MEMORY_URL /f', { stdio: "ignore" });
      return;
    }
    for (const f of [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((x) => join(homedir(), x)).filter(existsSync)) {
      const current = readFileSync(f, "utf8");
      if (current.includes("# shared-memory")) writeFileSync(f, current.split("\n").filter((l) => !l.includes("# shared-memory")).join("\n"));
    }
  } catch {}
}

function upsertBlock(file, block) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const full = `${MARK_START}\n${block.trim()}\n${MARK_END}`;
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  const next = re.test(current) ? current.replace(re, full) : `${current.replace(/\s*$/, "")}${current.trim() ? "\n\n" : ""}${full}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

function removeBlock(file) {
  if (!existsSync(file)) return;
  const re = new RegExp(`\\n*${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
  writeFileSync(file, readFileSync(file, "utf8").replace(re, "\n"));
}

function readJson(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${file} is not valid JSON. Fix it (or move it away) and run again.`);
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function readSavedBaseUrl() {
  const p = join(here, "..", "worker", "connection.txt");
  return existsSync(p) ? readFileSync(p, "utf8").match(/^BASE_URL=(.+)$/m)?.[1]?.trim() : null;
}
