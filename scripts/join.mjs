#!/usr/bin/env node
/**
 * npm run join — join this project's shared AgentReturn memory with an invite code.
 * Works the same on macOS, Linux and Windows (Node 18+). No dependencies.
 *
 * Non-interactive: npm run join -- --name "Ada Lovelace" --email ada@example.com --code ATDC-XXXXXX [--area "frontend"]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoCfg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agentreturn.json'), 'utf-8'));
const url = String(process.env.AGENTRETURN_URL || repoCfg.url).replace(/\/+$/, '');

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}

async function ask(rl, label, current) {
  if (current && current !== true) return String(current);
  let v = '';
  while (!v) v = (await rl.question(`${label}: `)).trim();
  return v;
}

const rl = readline.createInterface({ input, output });
console.log(`\nJoin "${repoCfg.projectName ?? repoCfg.project}" on AgentReturn (${url})\n`);
const name = await ask(rl, 'Your name', args.name);
const email = await ask(rl, 'Your email', args.email);
const code = await ask(rl, 'Invite code', args.code);
const area = args.area && args.area !== true ? String(args.area) : (await rl.question('What will you work on? (optional, e.g. frontend): ')).trim();
rl.close();

let res;
try {
  res = await fetch(`${url}/v1/memory/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, code, area: area || undefined }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (err) {
  console.error(`\n✗ Could not reach ${url} (${err.message}). Check your internet connection and try again.`);
  process.exit(1);
}
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\n✗ ${data.error ?? `Join failed (${res.status})`}`);
  process.exit(1);
}

const dir = path.join(os.homedir(), '.agentreturn');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'config.json');
let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
} catch {}
fs.writeFileSync(file, JSON.stringify({ ...existing, url, token: data.token, project: data.project.id }, null, 2), { encoding: 'utf-8', mode: 0o600 });

console.log(`
✓ Welcome, ${data.member.name}! You're on "${data.project.name}"${data.role === 'owner' ? ' as the project owner' : ''}.
  Your personal access is saved in ${file} (keep it private).

Next:
  1. Open this folder in Claude Code, Cursor or GitHub Copilot.
     (Claude Code may ask you to trust the folder — say yes so the project hooks can run.)
  2. Your first session shows the project welcome; then tag your first prompt with a ticket,
     e.g.  #1a fix the booking form   (ticket #1, Dev/Feature)
  3. See your catch-up any time:  npm run brief
`);
