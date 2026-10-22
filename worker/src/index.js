// Shared Memory — one memory for Claude web/app, Claude Code (local) and Claude Code (cloud).
// A remote MCP server (Streamable HTTP, stateless JSON responses) on Cloudflare Workers + D1.
//
// Routes (TOKEN = your secret, set with `wrangler secret put MEMORY_TOKEN`):
//   POST /TOKEN/mcp       MCP endpoint (add this URL as a connector in Claude and in Claude Code)
//   GET  /TOKEN/context   Markdown context block, used by the Claude Code SessionStart hook
//   POST /TOKEN/session   Session transcript sync, used by the Claude Code Stop hook
//   GET  /TOKEN/health    "ok"

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "shared-memory", version: "1.0.0" };
const SURFACES = ["claude-web", "claude-code-local", "claude-code-cloud", "other"];
const MAX_FILE = 100_000; // characters per memory file
const MAX_TRANSCRIPT = 200_000; // characters per session transcript

const INSTRUCTIONS = `This is the user's shared memory. The same memory is used from Claude web/app, Claude Code on their computer and Claude Code in the cloud, so anything saved here is available everywhere.
- At the start of work, call memory_context (pass the project or client name if known) unless that context is already in the conversation. Read the relevant /areas/ file before working on a client or project.
- Memory is markdown files: /profile.md (who the user is), /preferences.md (how they want Claude to work), /areas/<name>.md (one per client or project), /people/<name>.md, /topics/<name>.md.
- When you learn a durable fact, decision, status change or preference, update the right file: memory_read it first, then memory_replace or memory_append. Use memory_write only to create a file or rewrite it completely.
- After meaningful work, call session_log with a short summary (what was done, decisions, open items). Calling it again with the same session_id updates the entry.
- To find something from another conversation or session, use memory_search, then session_read.
- Never store passwords, API keys, tokens, or card or bank account numbers.`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [token, route] = url.pathname.split("/").filter(Boolean);

    if (!token) return text("shared-memory is running.");
    if (!env.MEMORY_TOKEN || !safeEqual(token, env.MEMORY_TOKEN)) return text("Not found", 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    try {
      switch (route) {
        case "mcp":
          return await handleMcp(request, env);
        case "health":
          return text("ok");
        case "context":
          if (request.method !== "GET") break;
          return text(
            await buildContext(env, {
              project: url.searchParams.get("project"),
              sessionId: url.searchParams.get("session_id"),
              surface: url.searchParams.get("surface"),
              maxChars: Number(url.searchParams.get("max")) || 0,
            })
          );
        case "session":
          if (request.method !== "POST") break;
          return json(await syncSessionFromHook(env, await request.json()));
        case "import":
          if (request.method !== "POST") break;
          return json(await importFiles(env, await request.json()));
      }
      return text("Not found", 404);
    } catch (err) {
      return text(`Server error: ${err.message}`, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// MCP (JSON-RPC over Streamable HTTP, stateless)
// ---------------------------------------------------------------------------
async function handleMcp(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST", ...cors() } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    const reply = await handleRpc(msg, env);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202, headers: cors() });
  return json(Array.isArray(body) ? replies : replies[0]);
}

async function handleRpc(msg, env) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params = {} } = msg;
  if (!method) return null; // a response sent by the client — nothing to do
  if (id === undefined || id === null) return null; // notification

  switch (method) {
    case "initialize": {
      const version = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(({ handler, ...def }) => def) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const out = await tool.handler(env, params.arguments || {});
        return rpcResult(id, { content: [{ type: "text", text: out }] });
      } catch (err) {
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const pathProp = { type: "string", description: "Memory file path, e.g. /areas/acme.md" };
const surfaceProp = {
  type: "string",
  enum: SURFACES,
  description: "Where this conversation is happening: claude-web (Claude web/desktop/mobile app), claude-code-local, claude-code-cloud, other.",
};

const TOOLS = [
  {
    name: "memory_context",
    description:
      "Load the shared memory: profile, preferences, the list of memory files and recent sessions from every Claude surface. Call at the start of work.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Optional project or client name to focus on." } },
    },
    annotations: { readOnlyHint: true },
    handler: (env, a) => buildContext(env, { project: a.project }),
  },
  {
    name: "memory_list",
    description: "List memory files (path, one-line description, last update). Optionally only under a folder like /areas/.",
    inputSchema: { type: "object", properties: { prefix: { type: "string", description: "Folder prefix, e.g. /areas/" } } },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const files = await listFiles(env, a.prefix);
      return files.length ? files.map(fileLine).join("\n") : "No memory files yet.";
    },
  },
  {
    name: "memory_read",
    description: "Read one or more memory files in full.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, maxItems: 20, description: "Paths to read." },
        path: { type: "string", description: "A single path (alternative to paths)." },
      },
    },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const paths = [...(Array.isArray(a.paths) ? a.paths : []), ...(a.path ? [a.path] : [])].map(normPath);
      if (!paths.length) throw new Error("Pass path or paths.");
      const out = [];
      for (const p of paths.slice(0, 20)) {
        const row = await env.DB.prepare("SELECT content, updated_at, updated_by FROM memories WHERE path = ?").bind(p).first();
        out.push(
          row
            ? `=== ${p} (updated ${row.updated_at.slice(0, 16).replace("T", " ")}${row.updated_by ? ` from ${row.updated_by}` : ""}) ===\n${row.content}`
            : `=== ${p} ===\n(not found)`
        );
      }
      return out.join("\n\n");
    },
  },
  {
    name: "memory_write",
    description: "Create a memory file or replace its whole content. To change part of an existing file use memory_replace or memory_append.",
    inputSchema: {
      type: "object",
      properties: { path: pathProp, content: { type: "string" }, surface: surfaceProp },
      required: ["path", "content"],
    },
    handler: async (env, a) => {
      const p = normPath(a.path);
      await saveFile(env, p, String(a.content ?? ""), a.surface);
      return `Saved ${p}.`;
    },
  },
  {
    name: "memory_append",
    description: "Add text to the end of a memory file (creates the file if it does not exist).",
    inputSchema: {
      type: "object",
      properties: { path: pathProp, text: { type: "string" }, surface: surfaceProp },
      required: ["path", "text"],
    },
    handler: async (env, a) => {
      const p = normPath(a.path);
      const row = await env.DB.prepare("SELECT content FROM memories WHERE path = ?").bind(p).first();
      const content = row ? `${row.content.replace(/\s+$/, "")}\n${a.text}` : String(a.text);
      await saveFile(env, p, content, a.surface);
      return row ? `Appended to ${p}.` : `Created ${p}.`;
    },
  },
  {
    name: "memory_replace",
    description: "Replace one exact piece of text in a memory file. old_text must appear exactly once. Use an empty new_text to delete it.",
    inputSchema: {
      type: "object",
      properties: { path: pathProp, old_text: { type: "string" }, new_text: { type: "string" }, surface: surfaceProp },
      required: ["path", "old_text", "new_text"],
    },
    handler: async (env, a) => {
      const p = normPath(a.path);
      const row = await env.DB.prepare("SELECT content FROM memories WHERE path = ?").bind(p).first();
      if (!row) throw new Error(`${p} does not exist.`);
      const count = row.content.split(a.old_text).length - 1;
      if (!a.old_text || count === 0) throw new Error(`old_text was not found in ${p}. Read the file and try again.`);
      if (count > 1) throw new Error(`old_text appears ${count} times in ${p}; include more surrounding text.`);
      await saveFile(env, p, row.content.replace(a.old_text, () => a.new_text ?? ""), a.surface);
      return `Updated ${p}.`;
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory file. Only when the user asks for it.",
    inputSchema: { type: "object", properties: { path: pathProp }, required: ["path"] },
    annotations: { destructiveHint: true },
    handler: async (env, a) => {
      const p = normPath(a.path);
      const res = await env.DB.prepare("DELETE FROM memories WHERE path = ?").bind(p).run();
      return res.meta.changes ? `Deleted ${p}.` : `${p} did not exist.`;
    },
  },
  {
    name: "memory_search",
    description:
      "Search memory files and past sessions (summaries and full transcripts from all Claude surfaces). All words must match. Works in any language.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number", description: "Max results per kind (default 8)." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    handler: (env, a) => search(env, a.query, a.limit),
  },
  {
    name: "session_log",
    description:
      "Save a short summary of this conversation/session so other Claude surfaces can see it. Call after meaningful work. Reuse the same session_id to update it.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "3–8 lines: what was done, decisions made, open items." },
        title: { type: "string", description: "Short title." },
        project: { type: "string", description: "Client or project name." },
        surface: surfaceProp,
        session_id: {
          type: "string",
          description: "Use the session id from the memory context if one was given. Otherwise omit; the id returned can be reused to update.",
        },
      },
      required: ["summary"],
    },
    handler: async (env, a) => {
      const sid = (a.session_id && String(a.session_id).trim()) || `s-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const summary = clip(String(a.summary), 20_000);
      const title = a.title ? clip(oneLine(a.title), 120) : clip(oneLine(summary), 90);
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, surface, project, title, summary, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'claude', ?6, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
           summary = excluded.summary,
           title = excluded.title,
           project = COALESCE(excluded.project, sessions.project),
           source = 'claude',
           updated_at = excluded.updated_at`
      )
        .bind(sid, surfaceOf(a.surface), a.project || null, title, summary, now)
        .run();
      return `Session logged (session_id: ${sid}).`;
    },
  },
  {
    name: "session_recent",
    description: "List recent sessions from all Claude surfaces, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 15, max 50." },
        project: { type: "string" },
        surface: surfaceProp,
      },
    },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const rows = await recentSessions(env, { limit: a.limit || 15, project: a.project, surface: a.surface });
      return rows.length ? rows.map(sessionLine).join("\n") : "No sessions logged yet.";
    },
  },
  {
    name: "session_read",
    description: "Read one session: its summary and, for Claude Code sessions, the transcript of the messages.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The #number shown in lists, or the session_id." },
        include_transcript: { type: "boolean", description: "Default true." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const key = String(a.id).replace(/^#/, "").trim();
      const row = /^\d+$/.test(key)
        ? await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(Number(key)).first()
        : await env.DB.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(key).first();
      if (!row) throw new Error(`No session ${a.id}.`);
      const parts = [
        `# ${row.title || "(untitled)"}`,
        `#${row.id} · ${row.surface}${row.project ? ` · ${row.project}` : ""} · started ${fmtDate(row.created_at)} · updated ${fmtDate(row.updated_at)} · session_id ${row.session_id}`,
        `## Summary\n${row.summary || "(none)"}`,
      ];
      if (a.include_transcript !== false && row.transcript) {
        const t = row.transcript.length > 60_000 ? `… (earlier part cut)\n${row.transcript.slice(-60_000)}` : row.transcript;
        parts.push(`## Transcript\n${t}`);
      }
      return parts.join("\n\n");
    },
  },
];

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
async function saveFile(env, path, content, surface) {
  if (content.length > MAX_FILE) throw new Error(`File too large (${content.length} chars, max ${MAX_FILE}). Split it into smaller files.`);
  await env.DB.prepare(
    `INSERT INTO memories (path, content, description, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(path) DO UPDATE SET content = excluded.content, description = excluded.description,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  )
    .bind(path, content, describe(content), new Date().toISOString(), surface ? surfaceOf(surface) : null)
    .run();
}

async function listFiles(env, prefix) {
  let sql = "SELECT path, description, updated_at FROM memories";
  const binds = [];
  if (prefix) {
    let p = String(prefix).trim();
    if (!p.startsWith("/")) p = `/${p}`;
    sql += " WHERE path LIKE ? ESCAPE '\\'";
    binds.push(`${escapeLike(p)}%`);
  }
  sql += " ORDER BY path";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results;
}

async function recentSessions(env, { limit = 10, project, surface } = {}) {
  const where = [];
  const binds = [];
  if (project) {
    where.push("LOWER(project) = LOWER(?)");
    binds.push(project);
  }
  if (surface) {
    where.push("surface = ?");
    binds.push(surface);
  }
  const sql = `SELECT id, session_id, surface, project, title, updated_at FROM sessions
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`;
  binds.push(Math.min(Math.max(Number(limit) || 10, 1), 50));
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results;
}

async function buildContext(env, { project, sessionId, surface, maxChars = 0 } = {}) {
  const compact = maxChars > 0;
  const parts = ["# Shared memory (same memory in Claude web/app, Claude Code local and Claude Code cloud)"];

  if (sessionId) {
    parts.push(
      `This session: session_id ${sessionId}${surface ? ` · surface ${surface}` : ""}${project ? ` · project ${project}` : ""}.\n` +
        "The messages of this session are synced to shared memory automatically. After meaningful work, also call the shared-memory tool " +
        "session_log with this session_id and a 3–8 line summary (what was done, decisions, open items). " +
        "When you learn a durable fact or decision, update the right memory file."
    );
  }

  const core = await env.DB.prepare(
    "SELECT path, content FROM memories WHERE path IN ('/profile.md', '/preferences.md') ORDER BY path"
  ).all();
  for (const row of core.results) parts.push(`## ${row.path}\n${row.content.trim()}`);

  let projectFile = null;
  if (project) {
    const slug = slugify(project);
    const area = await env.DB.prepare("SELECT path, content FROM memories WHERE path IN (?, ?)")
      .bind(`/areas/${slug}.md`, `/projects/${slug}.md`)
      .first();
    if (area) projectFile = area;
  }

  const files = await listFiles(env);
  parts.push(
    "## Memory files (read with memory_read)\n" +
      (files.length ? listingText(files.filter((f) => !["/profile.md", "/preferences.md"].includes(f.path)), compact) : "(none yet)")
  );

  const recent = await recentSessions(env, { limit: 10 });
  let projectRecent = [];
  if (project) {
    const ids = new Set(recent.map((r) => r.id));
    projectRecent = (await recentSessions(env, { limit: 5, project })).filter((r) => !ids.has(r.id));
  }
  const all = [...recent, ...projectRecent];
  parts.push(
    "## Recent sessions across all surfaces (open with session_read, find older ones with memory_search)\n" +
      (all.length ? all.map(sessionLine).join("\n") : "(none yet)")
  );

  if (projectFile) {
    const block = `## ${projectFile.path} (current project)\n${projectFile.content.trim()}`;
    const used = parts.join("\n\n").length;
    if (!compact || used + block.length + 2 <= maxChars) parts.splice(sessionId ? 2 : 1, 0, block);
    else parts.splice(sessionId ? 2 : 1, 0, `## Current project\nRead ${projectFile.path} with memory_read before working on this project.`);
  }

  let out = parts.join("\n\n");
  if (compact && out.length > maxChars) out = `${out.slice(0, maxChars - 80)}\n… (cut to fit; use memory_list and memory_read for the rest)`;
  return out;
}

async function search(env, query, limit) {
  const terms = String(query || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!terms.length) throw new Error("Empty query.");
  const n = Math.min(Math.max(Number(limit) || 8, 1), 30);

  const mWhere = terms.map(() => "(content LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')").join(" AND ");
  const mBinds = terms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);
  const mem = await env.DB.prepare(`SELECT path, content, updated_at FROM memories WHERE ${mWhere} ORDER BY updated_at DESC LIMIT ?`)
    .bind(...mBinds, n)
    .all();

  const sWhere = terms
    .map(() => "(COALESCE(title,'') || ' ' || summary || ' ' || COALESCE(project,'') || ' ' || COALESCE(transcript,'') LIKE ? ESCAPE '\\')")
    .join(" AND ");
  const sBinds = terms.map((t) => `%${escapeLike(t)}%`);
  const ses = await env.DB.prepare(
    `SELECT id, session_id, surface, project, title, summary, transcript, updated_at FROM sessions WHERE ${sWhere} ORDER BY updated_at DESC LIMIT ?`
  )
    .bind(...sBinds, n)
    .all();

  const out = [];
  out.push(`## Memory files (${mem.results.length})`);
  for (const r of mem.results) out.push(`${r.path} [${r.updated_at.slice(0, 10)}]\n  …${snippet(r.content, terms)}…`);
  out.push(`\n## Sessions (${ses.results.length})`);
  for (const r of ses.results) {
    const hay = `${r.summary}\n${r.transcript || ""}`;
    out.push(`${sessionLine(r)}\n  …${snippet(hay, terms)}…`);
  }
  if (!mem.results.length && !ses.results.length) return `Nothing found for "${query}". Try fewer or different words.`;
  return out.join("\n");
}

// One-time import of existing memory files (used by setup). Never overwrites a file that already exists.
async function importFiles(env, files) {
  if (!Array.isArray(files)) throw new Error("Expected a list of {path, content}");
  let added = 0;
  let skipped = 0;
  const failed = [];
  for (const f of files) {
    try {
      const p = normPath(f.path);
      const content = String(f.content ?? "");
      if (content.length > MAX_FILE) throw new Error("too large");
      const ts = /^\d{4}-\d{2}-\d{2}T/.test(f.updated_at || "") ? new Date(f.updated_at).toISOString() : new Date().toISOString();
      const res = await env.DB.prepare(
        "INSERT OR IGNORE INTO memories (path, content, description, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, 'import')"
      )
        .bind(p, content, describe(content), ts)
        .run();
      if (res.meta.changes) added++;
      else skipped++;
    } catch (err) {
      failed.push(`${f?.path}: ${err.message}`);
    }
  }
  return { added, skipped, failed };
}

// Called by the Claude Code Stop hook after every Claude reply.
async function syncSessionFromHook(env, body) {
  const sid = body && String(body.session_id || "").trim();
  if (!sid) throw new Error("session_id is required");
  const now = new Date().toISOString();
  const title = body.title ? clip(oneLine(body.title), 120) : null;
  const summary = clip(String(body.summary || ""), 5000);
  let transcript = String(body.transcript || "");
  if (transcript.length > MAX_TRANSCRIPT) transcript = `… (earlier part cut)\n${transcript.slice(-MAX_TRANSCRIPT)}`;
  const res = await env.DB.prepare(
    `INSERT INTO sessions (session_id, surface, project, title, summary, transcript, source, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'hook', ?7, ?7)
     ON CONFLICT(session_id) DO UPDATE SET
       transcript = excluded.transcript,
       updated_at = excluded.updated_at,
       project = COALESCE(sessions.project, excluded.project),
       title = CASE WHEN sessions.source = 'hook' THEN excluded.title ELSE sessions.title END,
       summary = CASE WHEN sessions.source = 'hook' THEN excluded.summary ELSE sessions.summary END`
  )
    .bind(sid, surfaceOf(body.surface), body.project || null, title, summary, transcript, now)
    .run();
  return { ok: true, changes: res.meta.changes };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function normPath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("path is required");
  let s = p.trim().replace(/\\/g, "/");
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\/{2,}/g, "/");
  if (s.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error("'.' and '..' are not allowed in paths");
  if (s.endsWith("/")) throw new Error("path must be a file, not a folder");
  if (!/\.[a-z0-9]{1,8}$/i.test(s)) s += ".md";
  if (s.length > 200) throw new Error("path too long");
  return s;
}

function describe(content) {
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) return clip(d[1].trim().replace(/^["']|["']$/g, ""), 150);
  }
  const body = fm ? content.slice(fm[0].length) : content;
  const line = body
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/^\[stated\]\s*/, "").trim())
    .find(Boolean);
  return clip(line || "(empty)", 150);
}

// Full listing (one line per file), or compact: file names grouped by folder.
function listingText(files, compact) {
  if (!files.length) return "(only profile and preferences)";
  if (!compact) return files.map(fileLine).join("\n");
  const groups = new Map();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const folder = f.path.slice(0, i + 1);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(f.path.slice(i + 1).replace(/\.md$/, ""));
  }
  return [...groups].map(([folder, names]) => `${folder}  ${names.join(", ")}`).join("\n") +
    "\n(memory_list shows a one-line description of each file)";
}

const fileLine = (f) => `${f.path} — ${f.description} [${f.updated_at.slice(0, 10)}]`;
const sessionLine = (r) =>
  `#${r.id} ${fmtDate(r.updated_at)} [${r.surface}${r.project ? ` · ${r.project}` : ""}] ${r.title || "(untitled)"}`;
const fmtDate = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "");
const surfaceOf = (s) => (SURFACES.includes(s) ? s : "other");
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function snippet(textValue, terms) {
  const lower = textValue.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 120);
  return oneLine(textValue.slice(start, start + 300));
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization",
});
const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...cors() } });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors() } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
