#!/usr/bin/env node
// Claude Code Stop hook — after every Claude reply, syncs this session's messages
// (your messages + Claude's replies, without tool noise) to the shared memory.
// It never blocks Claude and never prints anything into the conversation.
//
// Needs the environment variable SHARED_MEMORY_URL = https://<worker>.workers.dev/<TOKEN>
// --remote-only : do nothing unless running in Claude Code on the web (cloud)

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

const isRemote = /^(1|true|yes)$/i.test(process.env.CLAUDE_CODE_REMOTE || "");
if (process.argv.includes("--remote-only") && !isRemote) process.exit(0);

const base = (process.env.SHARED_MEMORY_URL || "").trim().replace(/\/+$/, "");
if (!base) process.exit(0);

const input = await readStdin();
if (!input.session_id || !input.transcript_path) process.exit(0);

const MAX_TURN = 3000; // characters kept per message
const MAX_TOTAL = 150_000; // characters sent per session (the newest part is kept)

try {
  const turns = readTurns(input.transcript_path);
  const userTurns = turns.filter((t) => t.role === "user");
  if (!userTurns.length) process.exit(0);

  let transcript = turns.map((t) => `${t.role === "user" ? "USER" : "CLAUDE"}: ${clip(t.text, MAX_TURN)}`).join("\n\n");
  if (transcript.length > MAX_TOTAL) transcript = `… (earlier part cut)\n${transcript.slice(-MAX_TOTAL)}`;

  const first = oneLine(userTurns[0].text);
  const last = oneLine(userTurns[userTurns.length - 1].text);
  const cwd = input.cwd || process.cwd();
  const summary =
    `Auto-captured Claude Code session · ${turns.length} messages · folder ${basename(cwd)}\n` +
    `First request: ${clip(first, 300)}` +
    (userTurns.length > 1 ? `\nLatest request: ${clip(last, 300)}` : "");

  await fetch(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: input.session_id,
      surface: process.env.SHARED_MEMORY_SURFACE || (isRemote ? "claude-code-cloud" : "claude-code-local"),
      project: process.env.SHARED_MEMORY_PROJECT || projectName(cwd),
      title: clip(first, 110),
      summary,
      transcript,
    }),
    signal: AbortSignal.timeout(10000),
  });
} catch (err) {
  process.stderr.write(`shared-memory: sync failed (${err.message})\n`);
}
process.exit(0);

// ---------------------------------------------------------------------------
function readTurns(path) {
  const turns = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const textValue = extractText(entry.message?.content);
    if (!textValue) continue;
    if (entry.type === "user" && /^<(command-|local-command|bash-|user-memory-input|task-notification)/.test(textValue)) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === entry.type) prev.text += `\n${textValue}`;
    else turns.push({ role: entry.type, text: textValue });
  }
  return turns;
}

function extractText(content) {
  let out = "";
  if (typeof content === "string") out = content;
  else if (Array.isArray(content)) out = content.filter((b) => b && b.type === "text" && b.text).map((b) => b.text).join("\n");
  return out
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
