# Claude Shared Memory

**One memory for Claude web, Claude desktop and mobile, Claude Code on your computer and Claude Code in the cloud.**

Tell Claude something once and every Claude you use knows it. Shared Memory is a small private MCP server that runs on your own free Cloudflare account. Every Claude surface connects to it, reads the same memory files and logs its sessions there. So a decision you made in a Claude web chat is known in your next Claude Code session, and work done in Claude Code can be looked up from your phone.

## Why it matters

- **Each Claude surface remembers on its own.** Claude web's memory, Claude Code's `CLAUDE.md` and memory files, and cloud sessions don't share anything. You end up re-explaining your clients, projects and preferences in every place.
- **Work gets lost between surfaces.** What you did in Claude Code yesterday is invisible to Claude web today, and the other way round.
- **Your memory should be yours.** It runs on your own Cloudflare account, in your own database. No third-party memory service, no subscription.
- **It's free.** A personal setup fits comfortably within Cloudflare's free plan.

## What you get

| | Claude web / desktop / mobile | Claude Code (your computer) | Claude Code (cloud) |
|---|---|---|---|
| Sees your profile, preferences and project files | ✅ | ✅ loaded automatically every session | ✅ loaded automatically every session |
| Can update memory files | ✅ | ✅ | ✅ |
| Every message saved | — (Claude saves a summary) | ✅ automatically, after every reply | ✅ automatically, after every reply |
| Can search all past sessions | ✅ | ✅ | ✅ |

**Tools Claude gets:** `memory_context`, `memory_list`, `memory_read`, `memory_write`, `memory_append`, `memory_replace`, `memory_delete`, `memory_search`, `session_log`, `session_recent`, `session_read`.

**How memory is organised:** plain Markdown files.
- `/profile.md`: who you are
- `/preferences.md`: how you want Claude to work
- `/areas/<project>.md`: one file per client or project
- `/people/<name>.md` and `/topics/<topic>.md`

Every session can be searched later, whichever surface it came from.

## How it works

```
Claude web / desktop / mobile ──(custom connector)──┐
Claude Code on your computer ──(MCP + hooks)────────┼──► Cloudflare Worker ──► D1 database
Claude Code in the cloud ──(MCP + hooks)────────────┘     (MCP server)          (memories, sessions)
```

- **Server:** `worker/src/index.js` is a remote MCP server (Streamable HTTP, stateless JSON) on Cloudflare Workers with a D1 (SQLite) database. Besides MCP, it serves a Markdown context block for the hooks and a session-sync endpoint.
- **SessionStart hook:** `claude-code/hooks/memory-start.mjs` loads your profile, preferences, the list of memory files, recent sessions from every surface and the current project's file into each Claude Code session.
- **Stop hook:** `claude-code/hooks/memory-sync.mjs` saves the conversation (your messages and Claude's replies, without tool noise) after every reply, so Claude Code sessions are kept in full and can be searched.
- **Security:** the server only answers on paths that start with your secret token (`https://<worker>.workers.dev/<TOKEN>/mcp`), compared in constant time. Any other path returns 404.

## What you need

- **Node.js 18 or newer** (check with `node -v`)
- A **free Cloudflare account**: https://dash.cloudflare.com/sign-up
- Claude Code (for the Claude Code parts) and/or a Claude plan with custom connectors (for Claude web)

## Step 1: Deploy (about 5 minutes)

```bash
git clone https://github.com/nvark1996/claude-shared-memory.git
cd claude-shared-memory/worker
npm install
npm run setup
```

You only **log in to Cloudflare** when the browser opens. The script does the rest in 7 steps:

1. Checks your Cloudflare login
2. Creates the D1 database and saves its ID in `wrangler.toml`
3. Creates the tables
4. Deploys the server
5. Generates your secret token
6. Imports your starting memory, if you provided one (see below)
7. Connects Claude Code on this computer: adds the MCP server for all projects, installs the hooks that load memory and save every message, and adds short instructions to `~/.claude/CLAUDE.md`. It keeps everything already in your settings and saves `settings.json.bak`.

At the end it prints your **connector URL** and saves it in `worker/connection.txt`.

> **The URL is a password.** Anyone with it can read and write your memory. Don't share it. `connection.txt` is in `.gitignore`, so it is never committed.

If Cloudflare asks you to pick a `workers.dev` subdomain on the first deploy, set any name in the dashboard and run `npm run setup` again. Running setup again is always safe: it reuses the database and token and never overwrites existing memory. Then **open a new terminal** before using Claude Code.

**Start with your existing memory (optional):** copy `worker/memory-seed.example.json` to `worker/seed/memory-seed.json` and fill it with your own files (a list of `{ "path", "content" }`) before running setup. The `seed/` folder is in `.gitignore`.

## Step 2: Connect Claude web, desktop and mobile (about 1 minute)

1. In Claude, add a **custom connector** and paste your connector URL (the `MCP_URL` line in `connection.txt`). No sign-in is needed. It then works in the mobile app too.
2. Add this to your personal preferences in Claude, so it uses the memory without being asked:

```
When the shared-memory connector is available: at the start of any work conversation, call memory_context (pass the client or project name if there is one). When I share a durable fact, decision or status change, update the right memory file. After meaningful work, call session_log with surface "claude-web" and a 3–8 line summary (what was done, decisions, open items).
```

## Step 3: Claude Code in the cloud (optional, about 1 minute per repo)

Prepare each GitHub repo you use with Claude Code on the web, then commit and push the files it adds:

```bash
node claude-code/install.mjs --repo /path/to/your/repo
```

This adds the hooks, an `.mcp.json` and a `CLAUDE.md` note. The URL is read from an environment variable, so your token is never committed. Then edit the cloud environment you use for that repo:

- **Environment variable:** `SHARED_MEMORY_URL=` your `BASE_URL` from `connection.txt` (without `/mcp`)
- **Network access:** allow your `workers.dev` domain (custom allowlist) or choose full access

The repo's hooks run only in cloud sessions (`--remote-only`), so they never double up with the hooks on your computer.

## Check it works

- `curl -s "$BASE_URL/health"` prints `ok`.
- **Claude Code:** start `claude`, type `/mcp` and check that `shared-memory` is connected. Then ask *"what's in my shared memory?"*
- **Claude web:** in a new chat, ask *"check my shared memory"*.
- After a Claude Code session, ask Claude web *"what did I do in Claude Code today?"*

## Using it

It runs mostly on its own. Useful things to say in any Claude:

- "Search shared memory for the pricing decision."
- "What did I do in Claude Code yesterday?"
- "Save this to the Acme file."
- "Log this session."

## Good to know

- **Claude web chats aren't saved word for word.** Claude web has no hooks, so Claude saves a summary when it logs the session. The preference in Step 2 makes that the default. Claude Code sessions are saved in full, automatically.
- **Built-in memory keeps working.** Claude web's own memory and Claude Code's memory files still work. Shared Memory is the copy every surface can reach.
- **Limits:** 100,000 characters per memory file, 200,000 per session transcript (the newest part is kept).
- **Backup:** `cd worker && npm run backup` writes everything to `backup.sql` (also in `.gitignore`).
- **Change your token** (for example, if the URL leaked): delete `worker/connection.txt`, run `npm run setup` again, then update the connector URL in Claude and the cloud environment variable.
- **Remove from your computer:** `node claude-code/install.mjs --uninstall`. Your memory on the server stays.
- **Don't store** passwords, API keys, tokens, or card or bank numbers in memory.

## Files

```
worker/
  src/index.js              MCP server, memory and session logic
  schema.sql                database tables
  setup.mjs                 one-command setup (npm run setup)
  wrangler.toml             Cloudflare config (database id filled in by setup)
  memory-seed.example.json  example starting memory
claude-code/
  install.mjs               connects Claude Code (your computer, a cloud repo, or --uninstall)
  hooks/memory-start.mjs    SessionStart: loads memory into each session
  hooks/memory-sync.mjs     Stop: saves the session after every reply
```

Not an official Anthropic project.

## License

MIT. See [LICENSE](LICENSE).
