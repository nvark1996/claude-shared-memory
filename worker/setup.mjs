#!/usr/bin/env node
// One-time setup: creates the D1 database and tables, deploys the worker, generates your secret token,
// imports your existing Claude memory (seed/memory-seed.json) and connects Claude Code on this computer.
// Safe to run again: existing memory is never overwritten.
//
//   cd worker && npm install && npm run setup

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tomlPath = join(here, "wrangler.toml");
const connPath = join(here, "connection.txt");

function run(cmd, { input, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: here, shell: true, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      if (!quiet) process.stderr.write(d);
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("close", (code) => resolve({ code, out }));
  });
}

const step = (n, msg) => console.log(`\n\x1b[1m[${n}/7] ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
};

// 1. Login
step(1, "Checking your Cloudflare login");
let who = await run("npx wrangler whoami", { quiet: true });
if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
  console.log("A browser window will open to log in to Cloudflare (a free account is enough).");
  const login = await run("npx wrangler login");
  if (login.code !== 0) fail("Cloudflare login failed.");
} else {
  console.log("Logged in.");
}

// 2. Database
step(2, "Creating the database");
let toml = readFileSync(tomlPath, "utf8");
if (toml.includes("REPLACE_WITH_DATABASE_ID")) {
  let id = null;
  const created = await run("npx wrangler d1 create shared-memory");
  id = created.out.match(/database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/i)?.[1];
  if (!id) {
    // Already exists — look it up.
    const list = await run("npx wrangler d1 list --json", { quiet: true });
    try {
      const dbs = JSON.parse(list.out.slice(list.out.indexOf("[")));
      id = dbs.find((d) => d.name === "shared-memory")?.uuid;
    } catch {}
  }
  if (!id) fail("Could not find the database id. Run `npx wrangler d1 list` and paste the id into wrangler.toml.");
  toml = toml.replace("REPLACE_WITH_DATABASE_ID", id);
  writeFileSync(tomlPath, toml);
  console.log(`Database id saved to wrangler.toml (${id}).`);
} else {
  console.log("Database already configured in wrangler.toml.");
}

// 3. Tables
step(3, "Creating the tables");
const init = await run("npx wrangler d1 execute shared-memory --remote --file=schema.sql --yes");
if (init.code !== 0) fail("Creating the tables failed (see the error above).");

// 4. Deploy
step(4, "Deploying the server");
const deploy = await run("npx wrangler deploy");
if (deploy.code !== 0) fail("Deploy failed (see the error above).");
const workerUrl = deploy.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!workerUrl) fail("Deployed, but could not read the URL. Find it in the Cloudflare dashboard → Workers.");

// 5. Secret token
step(5, "Setting your secret token");
let token = null;
if (existsSync(connPath)) token = readFileSync(connPath, "utf8").match(/^TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) token = randomBytes(24).toString("base64url");
const secret = await run("npx wrangler secret put MEMORY_TOKEN", { input: `${token}\n` });
if (secret.code !== 0) fail("Setting the secret failed (see the error above).");

const base = `${workerUrl}/${token}`;
writeFileSync(
  connPath,
  `# Keep this private — anyone with these URLs can read and write your memory.\nTOKEN=${token}\nBASE_URL=${base}\nMCP_URL=${base}/mcp\n`
);

// Check it works
let healthy = false;
for (let i = 0; i < 10 && !healthy; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    healthy = (await (await fetch(`${base}/health`)).text()).trim() === "ok";
  } catch {}
}
if (!healthy) fail(`Deployed, but ${workerUrl} is not answering yet. Wait a minute and run \`npm run setup\` again.`);

// 6. Import existing memory
step(6, "Importing your existing Claude memory");
const seedPath = join(here, "seed", "memory-seed.json");
if (existsSync(seedPath)) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const res = await fetch(`${base}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(seed),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Import failed (HTTP ${res.status}).`);
  console.log(`${out.added} files imported, ${out.skipped} already there (kept as they are).`);
  if (out.failed?.length) console.log(`Not imported: ${out.failed.join("; ")}`);
} else {
  console.log("No seed/memory-seed.json found, skipping.");
}

// 7. Connect Claude Code on this computer
step(7, "Connecting Claude Code on this computer");
if (process.argv.includes("--no-claude-code")) {
  console.log("Skipped (--no-claude-code).");
} else {
  const inst = await run(`node "${join(here, "..", "claude-code", "install.mjs")}" "${base}"`);
  if (inst.code !== 0) console.log(`\x1b[33m!\x1b[0m Claude Code setup didn't finish. Run it later: node ../claude-code/install.mjs ${base}`);
}

console.log(`
\x1b[32m✔ Shared memory is live.\x1b[0m

  Your connector URL for Claude web/app:
  ${base}/mcp

Saved to worker/connection.txt. Keep it private: anyone with this URL can read and write your memory.

Last step: in Claude (web or desktop), add a custom connector and paste the URL above.
Then open a new terminal window before using Claude Code.
`);
