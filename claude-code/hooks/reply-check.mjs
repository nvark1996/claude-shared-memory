#!/usr/bin/env node
// Optional Claude Code Stop / SubagentStop hook (install with --reply-check).
// Makes every reply end with a clear "what do I need to do" line:
//   - "nothing needed." as the last line, when nothing is needed from you, or
//   - a line that starts with "Needed from you" listing what you must do.
// If the reply has neither, Claude is asked to add it before it finishes.
// It asks only once per reply (stop_hook_active), so it can never loop.
//
// Change the wording with environment variables:
//   REPLY_CHECK_DONE    default: nothing needed.
//   REPLY_CHECK_ACTION  default: Needed from you
// --remote-only : do nothing unless running in Claude Code on the web (cloud)

import { readFileSync, existsSync } from "node:fs";

const isRemote = /^(1|true|yes)$/i.test(process.env.CLAUDE_CODE_REMOTE || "");
if (process.argv.includes("--remote-only") && !isRemote) process.exit(0);

const DONE = (process.env.REPLY_CHECK_DONE || "nothing needed.").trim();
const ACTION = (process.env.REPLY_CHECK_ACTION || "Needed from you").trim();

const input = await readStdin();
if (input.stop_hook_active) process.exit(0); // already asked once for this reply

// SubagentStop gives the subagent's own transcript; Stop gives the main one.
const isSubagent = input.hook_event_name === "SubagentStop";
const path = isSubagent ? input.agent_transcript_path : input.transcript_path;
if (!path || !existsSync(path)) process.exit(0);

let reply = "";
try {
  reply = lastAssistantText(path, isSubagent);
} catch {
  process.exit(0);
}
if (!reply) process.exit(0);

const lines = reply.split("\n").map((l) => clean(l)).filter(Boolean);
const last = (lines[lines.length - 1] || "").toLowerCase();
const done = last === DONE.toLowerCase();
const action = lines.some((l) => l.toLowerCase().startsWith(ACTION.toLowerCase()));
if (done || action) process.exit(0);

const reason =
  `Your reply must end with what the user needs to do. ` +
  `If nothing is needed from them, add "${DONE}" on its own new line at the very end. ` +
  `If something is needed, add a short line starting with "${ACTION}:" listing it. ` +
  `Do not repeat the rest of the reply, just add the missing line.`;
process.stdout.write(JSON.stringify({ decision: "block", reason }));
process.exit(0);

// ---------------------------------------------------------------------------
function lastAssistantText(file, sidechainOk) {
  let text = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    if (entry.isSidechain && !sidechainOk) continue;
    const t = extractText(entry.message?.content);
    if (t) text = t;
  }
  return text;
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Ignore markdown around the line: **bold**, _italics_, `code`, quotes, list marks.
function clean(s) {
  return s
    .replace(/[*_`>]/g, "")
    .replace(/^\s*[-•]\s*/, "")
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
