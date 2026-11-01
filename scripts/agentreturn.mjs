#!/usr/bin/env node
/**
 * agentreturn — shared project memory CLI (no dependencies; Node 18+; macOS, Linux, Windows).
 *
 *   agentreturn setup --url https://<server> --token ar_xxx     save credentials to ~/.agentreturn/config.json
 *   agentreturn whoami                                          who am I, which projects
 *   agentreturn brief   [--ticket KEY] [--human] [--peek]       project → feature → ticket context
 *   agentreturn project                                         Start here, features, tickets, decisions, people
 *   agentreturn page    [--print]                               open the readable project page in your browser
 *   agentreturn feed    [--ticket KEY] [--type DECISION] [--since 2026-10-30] [--limit 30]
 *   agentreturn log     --type WORK|DECISION|DISCUSSION|RESEARCH --title "..." --summary "one line"
 *                       [--body "..." | --body-file notes.md | --body-file -]  [--ticket KEY] [--feature KEY]
 *                       [--files a.ts,b.ts] [--supersedes <entry id>] [--agent "Claude Code"] [--restricted]
 *
 * Project: --project, else $AGENTRETURN_PROJECT, else .agentreturn.json {"project": "..."} in the repo, else config.
 * Ticket:  --ticket, else a KEY-123 pattern in the current git branch name.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.agentreturn');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function findRepoConfig(start = process.cwd()) {
  let dir = start;
  for (;;) {
    const f = path.join(dir, '.agentreturn.json');
    if (fs.existsSync(f)) return readJson(f);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function die(msg, code = 1) {
  process.stderr.write(`agentreturn: ${msg}\n`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'help';
const saved = readJson(CONFIG_FILE) ?? {};
const repoCfg = findRepoConfig() ?? {};
const url = String(process.env.AGENTRETURN_URL || saved.url || '').replace(/\/+$/, '');
const token = process.env.AGENTRETURN_TOKEN || saved.token || '';
const project = args.project || process.env.AGENTRETURN_PROJECT || repoCfg.project || saved.project || '';

function ticketArg() {
  if (args.ticket && args.ticket !== true) return String(args.ticket).toUpperCase();
  const m = gitBranch().match(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

async function api(method, p, body) {
  if (!url) die('server URL not set. Run: agentreturn setup --url <server> --token <token>');
  if (!token) die('token not set. Run: agentreturn setup --url <server> --token <token>');
  let res;
  try {
    res = await fetch(`${url}/v1/memory${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    die(`could not reach ${url} (${err.message})`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) die(`${res.status} ${data.error ?? 'request failed'}`);
  return data;
}

function needProject() {
  if (!project) die('no project. Pass --project, set AGENTRETURN_PROJECT, or add .agentreturn.json {"project": "..."} to the repo.');
  return encodeURIComponent(project);
}

const fmt = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

async function main() {
  switch (cmd) {
    case 'setup': {
      const next = { ...saved };
      if (args.url) next.url = String(args.url).replace(/\/+$/, '');
      if (args.token) next.token = String(args.token);
      if (args.project) next.project = String(args.project);
      if (!next.url || !next.token) die('usage: agentreturn setup --url <server> --token <token> [--project <id>]');
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
      process.env.AGENTRETURN_URL = next.url;
      console.log(`Saved to ${CONFIG_FILE}`);
      const res = await fetch(`${next.url}/v1/memory/me`, { headers: { authorization: `Bearer ${next.token}` } }).catch((e) => ({ ok: false, statusText: e.message }));
      if (!res.ok) die(`saved, but the server check failed: ${res.status ?? ''} ${res.statusText}`);
      const me = await res.json();
      console.log(`Connected as ${me.member.name} <${me.member.email}> · projects: ${me.projects.map((p) => p.id).join(', ') || '(none yet)'}`);
      return;
    }
    case 'whoami': {
      const me = await api('GET', '/me');
      console.log(`${me.member.name} <${me.member.email}>`);
      for (const p of me.projects) console.log(`  ${p.id}  ${p.name}  (${p.role})${p.id === project ? '  ← current' : ''}`);
      return;
    }
    case 'brief': {
      const qs = new URLSearchParams({ project });
      needProject();
      const t = ticketArg();
      if (t) qs.set('ticket', t);
      if (args.activity) qs.set('activity', String(args.activity));
      if (args.peek) qs.set('mark_seen', 'false');
      const b = await api('GET', `/brief?${qs}`);
      if (args.json) console.log(JSON.stringify(b, null, 2));
      else if (args.human) console.log(b.human || `✓ ${b.project.name}: nothing new since you were last here.`);
      else console.log(b.agent);
      return;
    }
    case 'project': {
      const v = await api('GET', `/projects/${needProject()}`);
      if (args.json) return console.log(JSON.stringify(v, null, 2));
      console.log(`# ${v.project.name} (${v.project.id})\n\n${v.project.start_here}\n`);
      console.log('## Features');
      for (const f of v.features) {
        console.log(`- ${f.title} [${f.key}] (${f.status ?? 'active'})`);
        for (const t of v.tickets.filter((t) => t.feature === f.key)) console.log(`    ${t.key}  ${t.title}  (${t.status ?? ''})`);
      }
      const loose = v.tickets.filter((t) => !t.feature);
      if (loose.length) {
        console.log('- (no feature)');
        for (const t of loose) console.log(`    ${t.key}  ${t.title}`);
      }
      console.log('\n## Current decisions');
      for (const d of v.decisions) console.log(`- ${fmt(d.created_at)}  ${d.title} — ${d.summary} (${d.author_name}${d.agent ? ' + ' + d.agent : ''})`);
      console.log('\n## People and agents');
      for (const m of v.members) console.log(`- ${m.name}${m.role === 'owner' ? ' (owner)' : ''}${m.area ? ' — ' + m.area : ''}${m.agents.length ? ' · ' + m.agents.join(', ') : ''}`);
      return;
    }
    case 'page': {
      needProject();
      if (!url || !token) die('not set up. Run: npm run join (or agentreturn setup --url <server> --token <token>)');
      const link = `${url}/memory/${encodeURIComponent(project)}#token=${encodeURIComponent(token)}`;
      if (args.print) return console.log(link);
      const opener = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
      try {
        execSync(opener, { stdio: 'ignore', shell: true });
        console.log(`Opened the ${project} project page in your browser.`);
      } catch {
        console.log(`Open this link in your browser (it contains your personal access — don't share it):
${link}`);
      }
      return;
    }
    case 'feed': {
      const qs = new URLSearchParams({ project });
      needProject();
      if (args.ticket) qs.set('ticket', String(args.ticket));
      if (args.feature) qs.set('feature', String(args.feature));
      if (args.type) qs.set('type', String(args.type));
      if (args.since) qs.set('since', String(args.since));
      qs.set('limit', String(args.limit ?? 30));
      const { entries } = await api('GET', `/feed?${qs}`);
      if (args.json) return console.log(JSON.stringify(entries, null, 2));
      if (!entries.length) return console.log('(no entries)');
      for (const e of entries) {
        const tags = [e.ticket_key, e.feature_key, e.status === 'superseded' ? 'superseded' : null, e.visibility === 'restricted' ? 'restricted' : null].filter(Boolean).join(' · ');
        console.log(`\n${fmt(e.created_at)}  [${e.type}] ${e.title}`);
        console.log(`  ${e.author_name}${e.agent ? ' + ' + e.agent : ''}${tags ? ' · ' + tags : ''} · id ${e.id}`);
        console.log(`  ${e.summary}`);
        if (args.full && e.body) console.log('\n  ' + e.body.replace(/\n/g, '\n  '));
      }
      return;
    }
    case 'log': {
      needProject();
      let body = typeof args.body === 'string' ? args.body : '';
      if (args['body-file']) {
        body = args['body-file'] === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(String(args['body-file']), 'utf-8');
      }
      if (!args.type || !args.title || !args.summary) {
        die('usage: agentreturn log --type WORK|DECISION|DISCUSSION|RESEARCH --title "..." --summary "one line" [--body-file notes.md] [--ticket KEY] [--files a,b]');
      }
      const entry = {
        project,
        type: String(args.type).toUpperCase(),
        title: String(args.title),
        summary: String(args.summary),
        body,
        ticket: ticketArg(),
        feature: args.feature ? String(args.feature) : undefined,
        files: args.files ? String(args.files).split(',').map((s) => s.trim()).filter(Boolean) : [],
        supersedes: args.supersedes ? String(args.supersedes) : undefined,
        agent: String(args.agent || process.env.AGENTRETURN_AGENT || 'unknown agent'),
        visibility: args.restricted ? 'restricted' : 'project',
        activity_type: args.activity ? String(args.activity) : undefined,
      };
      const r = await api('POST', '/entries', entry);
      console.log(`✓ Logged ${entry.type} "${entry.title}" to ${project}${entry.ticket ? ' · ' + entry.ticket : ''}${r.feature ? ' · feature ' + r.feature : ''} · id ${r.id}`);
      return;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^#!.*\n\/\*\*?\n?/, '').replace(/^ \* ?/gm, ''));
  }
}

main().catch((err) => die(err.message));
