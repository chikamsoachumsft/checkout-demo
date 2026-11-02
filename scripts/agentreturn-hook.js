#!/usr/bin/env node
/**
 * AgentReturn Lifecycle Hook & 3-Vector Attribution Edge Proxy (Node.js)
 *
 * Works natively across:
 *   1. Claude Code  (~/.claude/settings.json & .claude/settings.json)
 *      Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop
 *   2. Cursor       (~/.cursor/hooks.json & .cursor/hooks.json)
 *      Events: beforeSubmitPrompt, beforeShellExecution, beforeMCPExecution, afterFileEdit, stop
 *   3. GitHub Copilot CLI / Coding Agent (.github/hooks/agentreturn.json & ~/.copilot/hooks.json)
 *      Events: sessionStart, userPromptSubmitted, preToolUse, postToolUse, sessionEnd
 *   4. Git Hooks    (.git/hooks/post-commit)
 *
 * Reads JSON payloads from stdin (when piped by Claude/Cursor/Copilot) AND CLI flags.
 * Extracts ticket IDs (e.g. DEV-142, CHK-101) and activity shortcodes (#FEATURE, #BUG,
 * #REFACTOR, #LEARN, #ADHOC, #RESEARCH, #OPS, #EXPLORING) from prompt text or env vars,
 * caches active session attribution in ~/.agentreturn/active-context.json, and enforces
 * Exit Code 0 (Allow) vs Exit Code 2 (Hard Block).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTEXT_DIR = path.join(os.homedir(), '.agentreturn');
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'active-context.json');

// Shared project memory config (written by `agentreturn setup` / `npm run join`): { url, token, project }
const MEMORY_CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONTEXT_DIR, 'config.json'), 'utf-8')) || {};
  } catch {
    return {};
  }
})();

const MODE_LETTER_MAP = {
  A: 'DEVELOPMENT',
  B: 'ADHOC',
  C: 'LEARN',
  D: 'EXPERIMENT_RESEARCH',
  E: 'INCIDENT',
};

const SHORTCODE_TAG_MAP = {
  // Explicit -AR (AgentReturn) Submode Switch Commands (checked first)
  '#RESEARCH-AR': 'EXPERIMENT_RESEARCH',
  '#EXPERIMENT-AR': 'EXPERIMENT_RESEARCH',
  '#DEV-AR': 'DEVELOPMENT',
  '#DEVELOPMENT-AR': 'DEVELOPMENT',
  '#FEATURE-AR': 'DEVELOPMENT',
  '#ADHOC-AR': 'ADHOC',
  '#PROTOTYPE-AR': 'ADHOC',
  '#LEARN-AR': 'LEARN',
  '#LEARNING-AR': 'LEARN',
  '#INCIDENT-AR': 'INCIDENT',
  '#BUG-AR': 'INCIDENT',
  '#FIX-AR': 'INCIDENT',
  '#OPS-AR': 'INCIDENT',
  // Standard Shortcode Aliases
  '#DEV': 'DEVELOPMENT',
  '#DEVELOPMENT': 'DEVELOPMENT',
  '#FEATURE': 'DEVELOPMENT',
  '#FEAT': 'DEVELOPMENT',
  '#BUG': 'INCIDENT',
  '#FIX': 'INCIDENT',
  '#INCIDENT': 'INCIDENT',
  '#OPS': 'INCIDENT',
  '#LEARN': 'LEARN',
  '#LEARNING': 'LEARN',
  '#ADHOC': 'ADHOC',
  '#PROTOTYPE': 'ADHOC',
  '#RESEARCH': 'EXPERIMENT_RESEARCH',
  '#EXPERIMENT': 'EXPERIMENT_RESEARCH',
};

function readStdinJsonSync() {
  if (
    process.stdin.isTTY ||
    process.argv.includes('--set-tenant') ||
    process.argv.includes('--list-tenants') ||
    process.argv.includes('--demo') ||
    process.argv.includes('--demo-all') ||
    process.argv.includes('--demo-intel') ||
    process.argv.includes('--demo-stripe') ||
    process.argv.includes('--demo-nvidia') ||
    process.argv.includes('--demo-jpmorgan') ||
    process.argv.includes('--demo-ar')
  ) {
    return null;
  }
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadSessionContext(key) {
  try {
    if (!fs.existsSync(CONTEXT_FILE)) return null;
    const all = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
    const entry = all[key];
    if (!entry) return null;
    // Expire after 4 hours
    if (Date.now() - (entry.updated_at || 0) > 4 * 60 * 60 * 1000) return null;
    return entry;
  } catch {
    return null;
  }
}

function saveSessionContext(key, data) {
  try {
    if (!fs.existsSync(CONTEXT_DIR)) {
      fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    }
    let all = {};
    if (fs.existsSync(CONTEXT_FILE)) {
      try {
        all = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
      } catch {
        all = {};
      }
    }
    all[key] = {
      ...(all[key] || {}),
      ...data,
      updated_at: Date.now(),
    };
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(all, null, 2), 'utf-8');
  } catch {
    // Non-fatal if home dir is read-only
  }
}

// ---------------------------------------------------------------------------
// Optimization fixes delivered by AgentReturn through this hook.
//   Claude Code      → injected into the agent's context once per session (additionalContext)
//   Cursor / Copilot → written to a local instruction file the agent reads; the file is listed in the
//                      repo's local .git/info/exclude (never committed) and removed when the fix is switched off.
// SECURITY NOTE: pushing instructions/files to developer machines will be flagged by CISOs. Before enterprise
// use this needs signed, policy-controlled, reviewable delivery (see Google Doc / backlog).
// ---------------------------------------------------------------------------
// Local ledger = the developer's source of truth for everything this hook reported. The hosted server can be
// rebuilt from it at any time with `agentreturn replay` (records keep their original time and session id).
const LEDGER_FILE = path.join(CONTEXT_DIR, 'receipts-ledger.jsonl');
function appendLedger(payloadObj, serverResult, endpoint) {
  try {
    if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const line = {
      recorded_at: new Date().toISOString(),
      session_id: (serverResult && serverResult.session_id) || payloadObj.session_id || null,
      endpoint,
      memory_project: (serverResult && serverResult.memory_project) || null,
      work_item_id: serverResult && serverResult.vector_1_where_spend_belongs ? serverResult.vector_1_where_spend_belongs.work_item_id : null,
      payload: payloadObj,
    };
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(line) + '\n', 'utf-8');
  } catch {
    // never block the developer because of the ledger
  }
}

const MANAGED_MARKER = 'Managed by AgentReturn';
const LOCAL_FIX_FILES = {
  cursor: ['.cursor', 'rules', 'agentreturn-optimizations.mdc'],
  'github-copilot': ['.github', 'instructions', 'agentreturn-optimizations.instructions.md'],
};

function fixesAsMarkdown(fixes) {
  return fixes
    .map((f) => `## ${f.title}${f.ticket_key ? ` (${f.ticket_key})` : ''} — ${f.rollout === 'trial' ? 'trial' : 'active'}\n\n${f.content}`)
    .join('\n\n');
}

function excludeFromGit(root, relPath) {
  try {
    const excludeFile = path.join(root, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.join(root, '.git', 'info'))) return;
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : '';
    const line = '/' + relPath.split(path.sep).join('/');
    if (!current.split(/\r?\n/).includes(line)) {
      fs.appendFileSync(excludeFile, `${current.endsWith('\n') || !current ? '' : '\n'}# ${MANAGED_MARKER} (local optimization fixes)\n${line}\n`, 'utf-8');
    }
  } catch {
    // non-fatal
  }
}

function syncLocalFixFile(tool, root, fixes) {
  const parts = LOCAL_FIX_FILES[tool];
  if (!parts || !root) return null;
  const rel = path.join(...parts);
  const file = path.join(root, rel);
  try {
    if (fixes.length) {
      const header =
        tool === 'cursor'
          ? `---\ndescription: ${MANAGED_MARKER} — active optimization fixes for this project. Do not edit.\nalwaysApply: true\n---\n\n`
          : `---\napplyTo: "**"\n---\n\n<!-- ${MANAGED_MARKER} — active optimization fixes for this project. Do not edit. -->\n\n`;
      const body = header + fixesAsMarkdown(fixes) + '\n';
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
      if (existing !== body) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body, 'utf-8');
      }
      excludeFromGit(root, rel);
      return file;
    }
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes(MANAGED_MARKER)) fs.unlinkSync(file);
  } catch {
    // non-fatal: never block the developer because of a fix file
  }
  return null;
}

/** Returns { agentText, bannerLine } for this hook call; null when the server sent nothing about fixes. */
function deliverOptimizations(result, sessionKey, tool, root, eventLower) {
  const fixes = result && Array.isArray(result.optimizations) ? result.optimizations : null;
  if (!fixes || !result.memory_project) return null;
  syncLocalFixFile(tool, root, fixes);
  let agentText = '';
  const canInject = tool === 'claude-code' && (eventLower === 'sessionstart' || eventLower === 'userpromptsubmit');
  if (canInject && fixes.length) {
    const prior = (loadSessionContext(sessionKey) || {}).delivered_optimizations || [];
    const fresh = fixes.filter((f) => !prior.includes(`${f.id}:${f.content.length}`));
    if (fresh.length) {
      agentText =
        `# AgentReturn optimization fixes (from the project's owner; follow unless the user says otherwise)\n\n` + fixesAsMarkdown(fresh);
      saveSessionContext(sessionKey, { delivered_optimizations: [...prior, ...fresh.map((f) => `${f.id}:${f.content.length}`)] });
    }
  }
  const bannerLine = fixes.length
    ? `⚡ AgentReturn fix active for this session: ${fixes.map((f) => `${f.title}${f.ticket_key ? ` (${f.ticket_key})` : ''} · ${f.rollout}`).join('; ')}`
    : '';
  return { agentText, bannerLine };
}

function extractInlineTagsFromText(text) {
  if (!text || typeof text !== 'string') return {};
  const extracted = {};

  // Check for #? or #MENU or #TICKETS or #HELP to show the open tickets & modes menu mid-conversation
  if (/#(\?|MENU|TICKETS|HELP)(-AR)?(\s|$)/i.test(text)) {
    extracted.show_menu = true;
  }

  // 1. Check for combined Ticket Rank + Mode Letter shorthand: e.g. #1a, #1b, #2d, #3e, #0b (or #1, #2, #3, #0)
  const comboMatch = text.match(/#([0-9])([a-e])?(?:-AR)?\b/i);
  if (comboMatch) {
    const rankNum = comboMatch[1];
    const modeLetter = comboMatch[2] ? comboMatch[2].toUpperCase() : null;
    if (rankNum === '0') {
      extracted.work_item_id = '__unticketed__';
      extracted.just_exploring = true;
    } else {
      extracted.work_item_id = `#${rankNum}`;
      extracted.just_exploring = false;
    }
    if (modeLetter && MODE_LETTER_MAP[modeLetter]) {
      extracted.activity_type = MODE_LETTER_MAP[modeLetter];
      extracted.matched_tag = `#${rankNum}${modeLetter.toLowerCase()}`;
    }
  } else {
    // 2. Explicit ticket ID (e.g. DEV-142, optionally with a mode letter like DEV-142b). It only counts as a tag when
    //    it is prefixed with '#' (anywhere in the prompt) or is the very first word of the prompt — so mentioning a
    //    ticket, "exp 104", "GPT-4" or "utf-8" mid-sentence never switches the session's ticket.
    const cleanedForTickets = text.replace(/#[A-Z0-9-]+-AR\b/gi, '');
    const hashTicket = cleanedForTickets.match(/(?:^|\s)#([A-Z]{2,10}-\d{1,6})([a-e])?\b/i);
    const leadingTicket = !hashTicket && cleanedForTickets.match(/^\s*([A-Z]{2,10}-\d{1,6})([a-e])?\b/i);
    const ticketMatch = hashTicket || leadingTicket;
    // Natural spacing like "JIRA 234" / "TICKET 234" — also only as the first words of the prompt
    const naturalTicketMatch =
      !ticketMatch &&
      cleanedForTickets.match(/^\s*(?:(JIRA|DEV|EXP|INC|PROJ|CHK|FIN|ADO|LIN)\s+(?:TICKET\s+)?|TICKET\s+)#?(\d{1,6})\b/i);
    if (ticketMatch) {
      extracted.work_item_id = ticketMatch[1].toUpperCase();
      extracted.just_exploring = false;
      if (ticketMatch[2]) {
        const letter = ticketMatch[2].toUpperCase();
        if (MODE_LETTER_MAP[letter]) {
          extracted.activity_type = MODE_LETTER_MAP[letter];
        }
      }
    } else if (naturalTicketMatch) {
      const prefix = (naturalTicketMatch[1] || 'JIRA').toUpperCase();
      extracted.work_item_id = `${prefix}-${naturalTicketMatch[2]}`;
      extracted.just_exploring = false;
    }
  }

  // 3. Check for standalone Mode Letter shorthand: #a, #b, #c, #d, #e
  if (!extracted.activity_type) {
    const letterMatch = text.match(/#([a-e])(?:-AR)?\b/i);
    if (letterMatch) {
      const letter = letterMatch[1].toUpperCase();
      extracted.activity_type = MODE_LETTER_MAP[letter];
      extracted.matched_tag = `#${letter.toLowerCase()}`;
    }
  }

  // 4. Explicit unticketed override (#UNTICKETED-AR, #NO-TICKET-AR, #EXPLORING-AR) if switching off a ticket mid-session
  if (/#(UNTICKETED|NOTICKET|NO-TICKET|EXPLOR(E|ING))(-AR)?\b/i.test(text)) {
    extracted.just_exploring = true;
    extracted.work_item_id = '__unticketed__';
  }

  // 5. Extract Activity Submode hashtags (#RESEARCH-AR, #DEV-AR, #ADHOC-AR, #LEARN-AR, #INCIDENT-AR, etc.)
  if (!extracted.activity_type) {
    const upper = text.toUpperCase();
    for (const [tag, code] of Object.entries(SHORTCODE_TAG_MAP)) {
      if (upper.includes(tag)) {
        extracted.activity_type = code;
        extracted.matched_tag = tag;
        break;
      }
    }
  }

  // Extract inline research evidence if #d / #RESEARCH-AR / #RESEARCH is used
  if (extracted.activity_type === 'EXPERIMENT_RESEARCH') {
    const uncMatch = text.match(/uncertainty\s*[:=]\s*["']([^"']+)["']/i);
    const appMatch = text.match(/approaches\s*[:=]\s*["']([^"']+)["']/i);
    if (uncMatch) extracted.research_uncertainty = uncMatch[1];
    if (appMatch) extracted.research_approaches = appMatch[1];
    if (!extracted.research_uncertainty && text.length > 15) {
      extracted.research_uncertainty = 'Evaluating technical architecture and performance trade-offs';
      extracted.research_approaches = 'Comparing baseline implementation against alternative candidate design';
    }
  }

  return extracted;
}

function estimateTokensFromTranscriptOrInput(stdinData, defaultIn, defaultOut) {
  let inputTokens = defaultIn;
  let outputTokens = defaultOut;

  // 1. Check if Claude Code transcript_path is provided and has token usage
  if (stdinData?.transcript_path && fs.existsSync(stdinData.transcript_path)) {
    try {
      const content = fs.readFileSync(stdinData.transcript_path, 'utf-8');
      const lines = content.trim().split('\n').slice(-15);
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = JSON.parse(lines[i]);
        const usage = parsed?.message?.usage || parsed?.usage;
        if (usage && (usage.input_tokens || usage.cache_read_input_tokens)) {
          inputTokens =
            (Number(usage.input_tokens) || 0) +
            (Number(usage.cache_read_input_tokens) || 0) +
            (Number(usage.cache_creation_input_tokens) || 0);
          outputTokens = Number(usage.output_tokens) || defaultOut;
          break;
        }
      }
    } catch {
      // ignore transcript read errors
    }
  } else if (stdinData?.prompt && typeof stdinData.prompt === 'string') {
    // Estimate tokens from prompt length + base system context
    inputTokens = Math.max(4500, Math.round(stdinData.prompt.length / 4) + 12000);
    outputTokens = 2500;
  }
  return { inputTokens, outputTokens };
}

function parseArgs(argv, stdinData) {
  const opts = {
    endpoint:
      process.env.AGENTRETURN_HOOK_URL ||
      (MEMORY_CONFIG.url ? `${String(MEMORY_CONFIG.url).replace(/\/+$/, '')}/v1/hooks/evaluate` : '') ||
      'http://localhost:3000/v1/hooks/evaluate',
    hook_event: process.env.AGENTRETURN_HOOK_EVENT || '',
    agent_tool: process.env.AGENTRETURN_TOOL || '',
    input_tokens: 25000,
    output_tokens: 6000,
    model: 'claude-sonnet-4-20250514',
    git_email: '',
    repo_name: '',
    branch_name: '',
    cwd: stdinData?.cwd || (stdinData?.workspace_roots && stdinData.workspace_roots[0]) || process.cwd(),
    work_item_id: process.env.AGENTRETURN_WORK_ITEM || '',
    just_exploring: process.env.AGENTRETURN_EXPLORING === 'true',
    activity_type: process.env.AGENTRETURN_ACTIVITY || '',
    research_uncertainty: process.env.AGENTRETURN_UNCERTAINTY || '',
    research_approaches: process.env.AGENTRETURN_APPROACHES || '',
    interactive_cli: Boolean(process.stdin.isTTY),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tool' && argv[i + 1]) opts.agent_tool = argv[++i];
    else if (arg === '--event' && argv[i + 1]) opts.hook_event = argv[++i];
    else if (arg === '--email' && argv[i + 1]) opts.git_email = argv[++i];
    else if (arg === '--repo' && argv[i + 1]) opts.repo_name = argv[++i];
    else if (arg === '--branch' && argv[i + 1]) opts.branch_name = argv[++i];
    else if (arg === '--work-item' && argv[i + 1]) opts.work_item_id = argv[++i];
    else if (arg === '--exploring') opts.just_exploring = true;
    else if (arg === '--activity' && argv[i + 1]) opts.activity_type = argv[++i];
    else if (arg === '--uncertainty' && argv[i + 1]) opts.research_uncertainty = argv[++i];
    else if (arg === '--approaches' && argv[i + 1]) opts.research_approaches = argv[++i];
    else if (arg === '--input-tokens' && argv[i + 1]) opts.input_tokens = parseInt(argv[++i], 10) || 0;
    else if (arg === '--output-tokens' && argv[i + 1]) opts.output_tokens = parseInt(argv[++i], 10) || 0;
    else if (arg === '--model' && argv[i + 1]) opts.model = argv[++i];
    else if (arg === '--stdio-json') opts.interactive_cli = false;
    else if (!arg.startsWith('--') && i === 2) opts.agent_tool = arg;
    else if (!arg.startsWith('--') && i === 3) opts.input_tokens = parseInt(arg, 10) || 25000;
  }

  // Merge stdin fields from Claude Code / Cursor / GitHub Copilot
  if (stdinData) {
    if (!opts.hook_event && stdinData.hook_event_name) {
      opts.hook_event = stdinData.hook_event_name;
    }
    if (!opts.agent_tool) {
      if (stdinData.conversation_id || stdinData.workspace_roots) {
        opts.agent_tool = 'cursor';
      } else if (stdinData.toolName !== undefined || stdinData.sessionId !== undefined) {
        opts.agent_tool = 'github-copilot';
      } else {
        opts.agent_tool = 'claude-code';
      }
    }
    if (stdinData.model) {
      opts.model = stdinData.model;
    } else if (opts.agent_tool === 'github-copilot') {
      opts.model = 'gpt-4o-copilot';
    } else if (opts.agent_tool === 'cursor') {
      opts.model = 'claude-3.7-sonnet-cursor';
    }

    const { inputTokens, outputTokens } = estimateTokensFromTranscriptOrInput(
      stdinData,
      opts.input_tokens,
      opts.output_tokens
    );
    opts.input_tokens = inputTokens;
    opts.output_tokens = outputTokens;
  }

  if (!opts.hook_event) opts.hook_event = 'PreToolUse';
  if (!opts.agent_tool) opts.agent_tool = 'claude-code';

  return opts;
}

const stdinData = readStdinJsonSync();
const opts = parseArgs(process.argv, stdinData);

const execOpts = { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'] };

if (!opts.git_email) {
  try {
    opts.git_email = execSync('git config user.email', execOpts).toString().trim();
  } catch {
    opts.git_email = 'danielmobile69@gmail.com';
  }
}

if (!opts.branch_name) {
  try {
    opts.branch_name = execSync('git rev-parse --abbrev-ref HEAD', execOpts).toString().trim();
  } catch {
    opts.branch_name = 'main';
  }
}

if (!opts.repo_name) {
  try {
    const remoteUrl = execSync('git config --get remote.origin.url', execOpts).toString().trim();
    const m = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/i);
    opts.repo_name = m ? m[1] : path.basename(opts.cwd || process.cwd());
  } catch {
    // No git remote (e.g. downloaded as a ZIP): fall back to the folder name.
    opts.repo_name = path.basename(opts.cwd || process.cwd());
  }
}

// Check inline prompt text or command text for ticket IDs / #SHORTCODES
const textToInspect = [
  stdinData?.prompt,
  stdinData?.tool_input?.command,
  stdinData?.tool_input?.description,
  stdinData?.command,
  stdinData?.toolArgs,
]
  .filter(Boolean)
  .join(' ');

const rawSessionId = stdinData?.session_id || stdinData?.conversation_id || stdinData?.sessionId || '';
const branchCacheKey = `branch:${opts.repo_name}:${opts.branch_name}`;
const sessionKey = rawSessionId ? `session:${rawSessionId}` : branchCacheKey;

const inlineTags = extractInlineTagsFromText(textToInspect);
const priorCtx = loadSessionContext(sessionKey) || {};

const didUserProvideInlineTag = Boolean(
  inlineTags.work_item_id ||
    inlineTags.activity_type ||
    inlineTags.just_exploring ||
    inlineTags.show_menu
);

let segmentIndex = priorCtx.segment_index || 1;
let segmentNote = '';

// Section 7.6: Segment a conversation when its work context (Ticket OR Activity Submode) changes mid-session
const ticketChanged = Boolean(
  inlineTags.work_item_id &&
    priorCtx.work_item_id &&
    inlineTags.work_item_id.toUpperCase() !== priorCtx.work_item_id.toUpperCase()
);
const submodeChanged = Boolean(
  inlineTags.activity_type &&
    priorCtx.activity_type &&
    inlineTags.activity_type.toUpperCase() !== priorCtx.activity_type.toUpperCase()
);

if (ticketChanged || submodeChanged) {
  segmentIndex = (priorCtx.segment_index || 1) + 1;
  if (ticketChanged && submodeChanged) {
    segmentNote = `Switched to ${inlineTags.work_item_id} • ${inlineTags.activity_type} (Seg #${segmentIndex})`;
  } else if (submodeChanged) {
    segmentNote = `Switched mode to ${inlineTags.activity_type} (Seg #${segmentIndex})`;
  } else {
    segmentNote = `Switched ticket to ${inlineTags.work_item_id} (Seg #${segmentIndex})`;
  }
}

// Fall back to saved session context if not explicitly overridden on this prompt
if (!opts.work_item_id) {
  opts.work_item_id = inlineTags.work_item_id || priorCtx.work_item_id || '';
}
if (!opts.just_exploring) {
  opts.just_exploring =
    inlineTags.just_exploring !== undefined
      ? Boolean(inlineTags.just_exploring)
      : Boolean(priorCtx.just_exploring);
}
if (!opts.activity_type) {
  const pickedNewRealTicket = Boolean(
    inlineTags.work_item_id && inlineTags.work_item_id !== '__unticketed__'
  );
  opts.activity_type =
    inlineTags.activity_type || (pickedNewRealTicket ? '' : priorCtx.activity_type) || '';
}
if (!opts.research_uncertainty) {
  opts.research_uncertainty = inlineTags.research_uncertainty || priorCtx.research_uncertainty || '';
}
if (!opts.research_approaches) {
  opts.research_approaches = inlineTags.research_approaches || priorCtx.research_approaches || '';
}

const segmentedSessionId = rawSessionId ? `${rawSessionId}-seg${segmentIndex}` : undefined;

const payload = {
  session_id: segmentedSessionId,
  hook_event: opts.hook_event,
  git_email: opts.git_email,
  repo_name: opts.repo_name,
  branch_name: opts.branch_name,
  agent_tool: opts.agent_tool,
  model: opts.model,
  input_tokens: opts.input_tokens,
  output_tokens: opts.output_tokens,
  work_item_id: opts.work_item_id || undefined,
  just_exploring: opts.just_exploring || undefined,
  activity_type: opts.activity_type || undefined,
  research_uncertainty: opts.research_uncertainty || undefined,
  research_approaches: opts.research_approaches || undefined,
  prompt_text:
    stdinData?.prompt && typeof stdinData.prompt === 'string'
      ? stdinData.prompt.trim().slice(0, 140)
      : undefined,
  want_brief: (() => {
    const ev = String(opts.hook_event || '').toLowerCase();
    if (ev === 'sessionstart') return 'project';
    const isPrompt = ev === 'userpromptsubmit' || ev === 'beforesubmitprompt' || ev === 'userpromptsubmitted';
    if (isPrompt && inlineTags.work_item_id && inlineTags.work_item_id !== '__unticketed__') return 'ticket';
    return undefined;
  })(),
};

const TENANT_FILE = path.join(CONTEXT_DIR, 'tenant-brand.json');

function hexToRgb(hex, fallback = [84, 180, 255]) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : fallback;
}

function loadSavedTenantConfig() {
  if (process.env.AGENTRETURN_TENANT) {
    return { tenant: process.env.AGENTRETURN_TENANT.toLowerCase() };
  }
  // A project can brand its own sessions via .agentreturn.json { "brand": { customName, customWorkspace, customColor } }
  try {
    const baseDir = (opts && opts.cwd) || process.cwd();
    const repoCfgFile = path.join(baseDir, '.agentreturn.json');
    if (fs.existsSync(repoCfgFile)) {
      const repoCfg = JSON.parse(fs.readFileSync(repoCfgFile, 'utf-8'));
      if (repoCfg && repoCfg.brand && repoCfg.brand.tenant) return { tenant: String(repoCfg.brand.tenant).toLowerCase() };
      if (repoCfg && repoCfg.brand && repoCfg.brand.customName) return { tenant: 'custom', ...repoCfg.brand };
    }
  } catch {
    // ignore (also covers being called before opts is initialised)
  }
  try {
    if (fs.existsSync(TENANT_FILE)) {
      return JSON.parse(fs.readFileSync(TENANT_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return { tenant: 'intel' };
}

function saveTenantConfig(cfg) {
  try {
    if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.writeFileSync(TENANT_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

// CLI flag: --list-tenants
if (process.argv.includes('--list-tenants')) {
  const current = loadSavedTenantConfig();
  console.log('\n🎨 Available Enterprise Co-Branded Tenant Styles:');
  console.log('  • intel     — Intel Engineering (Two-Tone Cyan #00C7FD + Sky Blue #54B4FF `intel.` wordmark)');
  console.log('  • stripe    — Stripe Engineering (Electric Periwinkle #B3AEFF + Stripe Blurple #8B85FF `stripe.` wordmark)');
  console.log('  • nvidia    — NVIDIA Engineering (Cyber Lime #B6FF2B + GeForce Green #76B900 `nVIDIA.` wordmark)');
  console.log('  • jpmorgan  — JPMorganChase Engineering (Platinum Gold #FFE28A + Sapphire Gold #F5C85B `JPM.` wordmark)');
  console.log('  • default   — Agentic Return (Default Warm Copper #E6A17E `AR.` wordmark)');
  console.log('  • custom    — Custom Company Builder (--set-tenant custom --name "Acme Eng" --workspace "Acme" --color "#FF4D8D")\n');
  console.log(`Active Tenant Config: ${JSON.stringify(current)}\n`);
  process.exit(0);
}

// CLI flag: --set-tenant <intel|stripe|nvidia|jpmorgan|default|custom>
const setTenantIdx = process.argv.indexOf('--set-tenant');
if (setTenantIdx !== -1) {
  const val = (process.argv[setTenantIdx + 1] || 'default').toLowerCase();
  const normalized = val === 'none' || val === 'ar' ? 'default' : val;
  const getFlag = (flag) => {
    const idx = process.argv.indexOf(flag);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
  };
  const cfg = {
    tenant: normalized,
    customName: getFlag('--name') || undefined,
    customWorkspace: getFlag('--workspace') || undefined,
    customColor: getFlag('--color') || undefined,
    customMonogram: getFlag('--monogram') || undefined,
  };
  saveTenantConfig(cfg);
  if (fs.existsSync(CONTEXT_FILE)) {
    try { fs.unlinkSync(CONTEXT_FILE); } catch {}
  }
  console.log(
    `\n✅ Agentic Return: Active Organization Tenant set to "${normalized.toUpperCase()}" (session cache reset for demo).\n` +
      `   Preview it anytime with: node scripts/agentreturn-hook.js --demo ${normalized}\n`
  );
  process.exit(0);
}

const CACHED_TICKETS_FILE = path.join(CONTEXT_DIR, 'cached-tickets.json');

function saveCachedTickets(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  try {
    if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.writeFileSync(
      CACHED_TICKETS_FILE,
      JSON.stringify({ synced_at: new Date().toISOString(), candidates }, null, 2),
      'utf-8'
    );
  } catch {
    // ignore cache write errors
  }
}

function loadCachedAndGitTickets(payloadObj) {
  let candidates = [
    { work_item_id: 'EXP-404', project: 'AI FinOps Research' },
    { work_item_id: 'INC-902', project: 'Platform Security' },
    { work_item_id: 'PROJ-101', project: 'Orchestrator Core' },
  ];
  try {
    if (fs.existsSync(CACHED_TICKETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHED_TICKETS_FILE, 'utf-8'));
      if (Array.isArray(parsed?.candidates) && parsed.candidates.length > 0) {
        candidates = parsed.candidates;
      }
    }
  } catch {
    // fallback to default candidates
  }

  // Also inspect local git branch & recent commit messages for any newly checked-out ticket while offline
  const discoveredTicketIds = [];
  const branchMatch = String(payloadObj.branch_name || '').match(/\b([A-Z]{2,10}-\d{1,6})\b/i);
  if (branchMatch) discoveredTicketIds.push(branchMatch[1].toUpperCase());

  try {
    const recentCommits = execSync('git log -n 5 --pretty=format:%s', execOpts).toString();
    const commitMatches = recentCommits.match(/\b([A-Z]{2,10}-\d{1,6})\b/gi) || [];
    for (const m of commitMatches) {
      const upper = m.toUpperCase();
      if (!discoveredTicketIds.includes(upper)) discoveredTicketIds.push(upper);
    }
  } catch {
    // ignore git log errors
  }

  for (const ticketId of discoveredTicketIds.reverse()) {
    if (!candidates.some((c) => String(c.work_item_id).toUpperCase() === ticketId)) {
      const prefix = ticketId.split('-')[0];
      candidates.unshift({
        work_item_id: ticketId,
        project: `${prefix} Local Branch Work`,
      });
    }
  }

  return candidates.slice(0, 3);
}

function evaluateLocallyFallback(payloadObj) {
  const defaultCandidates = loadCachedAndGitTickets(payloadObj);
  const ev = String(payloadObj.hook_event || '').toLowerCase();
  const isSilent =
    ev === 'stop' ||
    ev === 'sessionend' ||
    ev === 'pretooluse' ||
    ev === 'posttooluse' ||
    ev === 'beforeshellexecution' ||
    ev === 'beforemcpexecution' ||
    ev === 'afterfileedit' ||
    ev === 'postcommit';

  let resolvedWorkItem = payloadObj.work_item_id || '';
  if (resolvedWorkItem === '#1') resolvedWorkItem = defaultCandidates[0]?.work_item_id || 'EXP-404';
  else if (resolvedWorkItem === '#2') resolvedWorkItem = defaultCandidates[1]?.work_item_id || 'INC-902';
  else if (resolvedWorkItem === '#3') resolvedWorkItem = defaultCandidates[2]?.work_item_id || 'PROJ-101';

  const matchedCandidate = defaultCandidates.find((c) => c.work_item_id === resolvedWorkItem);
  const resolvedProject =
    resolvedWorkItem === '__unticketed__' || payloadObj.just_exploring
      ? 'Innovation Allowance'
      : matchedCandidate
        ? matchedCandidate.project
        : resolvedWorkItem
          ? 'Engineering Work'
          : '';

  const resolvedActivity = payloadObj.activity_type || '';
  const hasAttribution = Boolean(
    (resolvedWorkItem && resolvedActivity) ||
      (payloadObj.just_exploring && resolvedActivity) ||
      resolvedActivity
  );

  if (ev === 'sessionstart' || isSilent) {
    return {
      exit_code: 0,
      candidate_work_items: defaultCandidates,
      vector_1_where_spend_belongs: {
        work_item_id: resolvedWorkItem || '__unticketed__',
        project: resolvedProject || 'Innovation Allowance',
      },
      vector_2_what_work_happened: {
        activity_type: resolvedActivity || 'UNKNOWN',
      },
    };
  }

  if (!isSilent && ev !== 'sessionstart' && hasAttribution) {
    try {
      if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
      const queueFile = path.join(CONTEXT_DIR, 'offline-queue.jsonl');
      fs.appendFileSync(
        queueFile,
        JSON.stringify({ ...payloadObj, queued_at: new Date().toISOString() }) + '\n',
        'utf-8'
      );
    } catch {
      // ignore offline queue write error
    }
  }

  return {
    exit_code: hasAttribution ? 0 : 2,
    candidate_work_items: defaultCandidates,
    vector_1_where_spend_belongs: {
      work_item_id: resolvedWorkItem || '__unticketed__',
      project: resolvedProject || 'Innovation Allowance',
    },
    vector_2_what_work_happened: {
      activity_type: resolvedActivity || 'UNKNOWN',
    },
  };
}

try {
  let result;
  try {
    const controller = new AbortController();
    // Shared-memory catch-ups need a little longer than plain attribution checks.
    const timeout = setTimeout(() => controller.abort(), MEMORY_CONFIG.token ? 6000 : 2500);

    const resp = await fetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(MEMORY_CONFIG.token ? { Authorization: `Bearer ${MEMORY_CONFIG.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    result = await resp.json();
    appendLedger(payload, result, opts.endpoint);

    // 1. Update local Last-Known-Good ticket cache whenever online
    if (Array.isArray(result?.candidate_work_items)) {
      saveCachedTickets(result.candidate_work_items);
    }

    // 2. Store-and-forward: flush any offline queued receipts now that we are back online
    const queueFile = path.join(CONTEXT_DIR, 'offline-queue.jsonl');
    if (fs.existsSync(queueFile)) {
      const queuedLines = fs
        .readFileSync(queueFile, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      fs.unlinkSync(queueFile);
      for (const qLine of queuedLines) {
        try {
          const qResp = await fetch(opts.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(MEMORY_CONFIG.token ? { Authorization: `Bearer ${MEMORY_CONFIG.token}` } : {}),
            },
            body: qLine,
          });
          const qResult = await qResp.json().catch(() => null);
          try {
            const { queued_at, ...queuedPayload } = JSON.parse(qLine);
            appendLedger(queuedPayload, qResult, opts.endpoint);
          } catch {
            // ignore unparsable queued line
          }
        } catch {
          // ignore individual replay failure
        }
      }
    }
  } catch {
    // Offline fallback so Claude Code / Cursor always renders the Agentic Return screen even if port 3000 is down
    result = evaluateLocallyFallback(payload);
  }
  const isBlocked = result.exit_code === 2;
  const eventLower = opts.hook_event.toLowerCase();
  const isSessionStart = eventLower === 'sessionstart';
  const isSilentLifecycleEvent =
    eventLower === 'stop' ||
    eventLower === 'sessionend' ||
    eventLower === 'pretooluse' ||
    eventLower === 'posttooluse' ||
    eventLower === 'beforeshellexecution' ||
    eventLower === 'beforemcpexecution' ||
    eventLower === 'afterfileedit' ||
    eventLower === 'postcommit';

  // Persist the resolved ticket & activity into session cache (and mirror to branchCacheKey for git post-commit)
  if (!isBlocked && !isSessionStart) {
    const resolvedWorkItem = result.vector_1_where_spend_belongs?.work_item_id || '';
    const resolvedActivity = result.vector_2_what_work_happened?.activity_type || '';
    if (resolvedActivity && resolvedActivity !== 'UNKNOWN') {
      const ctxData = {
        work_item_id: resolvedWorkItem,
        just_exploring: resolvedWorkItem === '__unticketed__',
        activity_type: resolvedActivity,
        research_uncertainty: opts.research_uncertainty || '',
        research_approaches: opts.research_approaches || '',
        segment_index: segmentIndex,
      };
      saveSessionContext(sessionKey, ctxData);
      if (sessionKey !== branchCacheKey) {
        saveSessionContext(branchCacheKey, ctxData);
      }
    }
  }

  const cleanedPromptSample =
    stdinData?.prompt && typeof stdinData.prompt === 'string'
      ? stdinData.prompt.replace(/#(\?|MENU|TICKETS|HELP)(-AR)?/gi, '').trim().slice(0, 42)
      : '';
  const brandExamplePrompt = (() => {
    try {
      const f = path.join(opts.cwd || process.cwd(), '.agentreturn.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8'))?.brand?.examplePrompt || '' : '';
    } catch {
      return '';
    }
  })();
  const userPromptSample = cleanedPromptSample || brandExamplePrompt || 'Add retry handling to the orchestrator';

  const ACTIVITY_DISPLAY_LABELS = {
    DEVELOPMENT: 'Dev / Feature',
    ADHOC: 'Ad-hoc',
    LEARN: 'Learn',
    EXPERIMENT_RESEARCH: 'R&D Research',
    INCIDENT: 'Bug / Incident',
  };

  const top3 = Array.isArray(result.candidate_work_items)
    ? result.candidate_work_items.slice(0, 3)
    : [];

  const t1 = top3[0] || { work_item_id: 'EXP-404', project: 'AI FinOps Research' };
  const t2 = top3[1] || { work_item_id: 'INC-902', project: 'Platform Security' };
  const t3 = top3[2] || { work_item_id: 'PROJ-101', project: 'Orchestrator Core' };

  const useAnsi =
    !process.env.NO_COLOR &&
    !process.argv.includes('--no-color') &&
    opts.agent_tool !== 'cursor';
  const C_WHITE_BOLD = useAnsi ? '\x1b[1;38;2;244;240;232m' : '';
  const C_WHITE = useAnsi ? '\x1b[38;2;226;232;240m' : '';
  const C_MUTED = useAnsi ? '\x1b[38;2;148;163;184m' : '';
  const C_DIM = useAnsi ? '\x1b[38;2;71;85;105m' : '';
  const R = useAnsi ? '\x1b[0m' : '';

  function buildTenantBrandBundle(tenantKey, customMeta = {}) {
    const key = String(tenantKey || 'default').toLowerCase();

    if (key.includes('intel')) {
      const C_DOT = useAnsi ? '\x1b[38;2;0;199;253m' : ''; // #00C7FD bright cyan 'i' dot
      const C_BODY = useAnsi ? '\x1b[38;2;84;180;255m' : ''; // #54B4FF sky-blue wordmark
      const C_ACCENT = useAnsi ? '\x1b[1;38;2;84;180;255m' : ''; // Bold Intel Blue
      return {
        key: 'intel',
        displayName: 'Intel Engineering',
        workspaceName: 'Intel',
        accentBold: C_ACCENT,
        header: [
          ` ${C_DOT}██${R}          ${C_BODY}██${R}         ${C_BODY}██${R}      ${C_WHITE_BOLD}Intel Engineering${R}`,
          ` ${C_BODY}▄▄  █████▄ █████ ▄███▄ ██${R}      ${C_MUTED}Powered by ${R}${C_WHITE_BOLD}Agentic Return${R}`,
          ` ${C_BODY}██  ██  ██  ██  ██▄▄██ ██${R}      ${C_MUTED}AI spend & work attribution${R}`,
          ` ${C_BODY}██  ██  ██  ██  ██▄▄▄▄ ██${R}      ${C_MUTED}Workspace: Intel  ${C_ACCENT}·${R}${C_MUTED}  Work policy: Categorized${R}`,
          ` ${C_BODY}██  ██  ██  ▀██▄ ▀████ ██ ▄▄${R}`,
        ].join('\n'),
        confirmPrefix: `${C_ACCENT}Intel Engineering${R} ${C_MUTED}(Powered by Agentic Return)${R}`,
      };
    }

    if (key.includes('stripe')) {
      const C_DOT = useAnsi ? '\x1b[38;2;179;174;255m' : ''; // #B3AEFF electric lavender highlight
      const C_BODY = useAnsi ? '\x1b[38;2;122;115;255m' : ''; // #7A73FF Stripe Blurple body
      const C_ACCENT = useAnsi ? '\x1b[1;38;2;139;133;255m' : ''; // Bold Stripe Blurple
      return {
        key: 'stripe',
        displayName: 'Stripe Engineering',
        workspaceName: 'Stripe Payments',
        accentBold: C_ACCENT,
        header: [
          `        ${C_BODY}██${R}         ${C_DOT}██${R}                   ${C_WHITE_BOLD}Stripe Engineering${R}`,
          ` ${C_BODY}▄███▄ █████ ████▄ ▄▄ █████▄  ▄███▄${R}     ${C_MUTED}Powered by ${R}${C_WHITE_BOLD}Agentic Return${R}`,
          ` ${C_BODY}▀███▄  ██   ██ ▀▀ ██ ██  ██ ██▄▄██${R}     ${C_MUTED}AI spend & work attribution${R}`,
          ` ${C_BODY}▄▄▄██  ██   ██    ██ ██▄▄█▀ ██▄▄▄▄${R}     ${C_MUTED}Workspace: Stripe Payments  ${C_ACCENT}·${R}${C_MUTED}  Work policy: Categorized${R}`,
          ` ${C_BODY}▀███▀  ▀██▄ ██    ██ ██      ▀████${R} ${C_DOT}▄▄${R}`,
        ].join('\n'),
        confirmPrefix: `${C_ACCENT}Stripe Engineering${R} ${C_MUTED}(Powered by Agentic Return)${R}`,
      };
    }

    if (key.includes('nvidia')) {
      const C_DOT = useAnsi ? '\x1b[38;2;182;255;43m' : ''; // #B6FF2B cyber lime highlight
      const C_BODY = useAnsi ? '\x1b[38;2;118;185;0m' : ''; // #76B900 NVIDIA GeForce Green
      const C_ACCENT = useAnsi ? '\x1b[1;38;2;138;214;0m' : ''; // Bold NVIDIA Green
      return {
        key: 'nvidia',
        displayName: 'NVIDIA Engineering',
        workspaceName: 'NVIDIA CUDA Core',
        accentBold: C_ACCENT,
        header: [
          `        ${C_BODY}██    ██${R} ${C_DOT}██${R} ${C_BODY}█████▄${R}  ${C_DOT}██${R}  ${C_BODY}▄███▄${R}     ${C_WHITE_BOLD}NVIDIA Engineering${R}`,
          ` ${C_DOT}█████▄${R} ${C_BODY}██    ██ ██ ██   ██ ██ ██   ██${R}    ${C_MUTED}Powered by ${R}${C_WHITE_BOLD}Agentic Return${R}`,
          ` ${C_DOT}██  ██${R} ${C_BODY} ██  ██  ██ ██   ██ ██ ███████${R}    ${C_MUTED}AI spend & work attribution${R}`,
          ` ${C_DOT}██  ██${R} ${C_BODY}  ████   ██ ██   ██ ██ ██   ██${R}    ${C_MUTED}Workspace: NVIDIA CUDA Core  ${C_ACCENT}·${R}${C_MUTED}  Work policy: Categorized${R}`,
          ` ${C_DOT}██  ██${R} ${C_BODY}   ▀▀    ▀▀ █████▀  ▀▀ ██   ██${R} ${C_DOT}▄▄${R}`,
        ].join('\n'),
        confirmPrefix: `${C_ACCENT}NVIDIA Engineering${R} ${C_MUTED}(Powered by Agentic Return)${R}`,
      };
    }

    if (key.includes('jpm') || key.includes('chase')) {
      const C_DOT = useAnsi ? '\x1b[38;2;255;226;138m' : ''; // #FFE28A platinum gold highlight
      const C_BODY = useAnsi ? '\x1b[38;2;229;184;75m' : ''; // #E5B84B JPM Sapphire Amber/Gold
      const C_ACCENT = useAnsi ? '\x1b[1;38;2;245;200;91m' : ''; // Bold JPM Gold
      return {
        key: 'jpmorgan',
        displayName: 'JPMorganChase Engineering',
        workspaceName: 'JPMC Core Banking',
        accentBold: C_ACCENT,
        header: [
          `    ${C_DOT}████${R} ${C_BODY}██████▄  ███▄ ▄███${R}       ${C_WHITE_BOLD}JPMorganChase Engineering${R}`,
          `      ${C_BODY}██ ██   ██  ████▄████${R}       ${C_MUTED}Powered by ${R}${C_WHITE_BOLD}Agentic Return${R}`,
          `      ${C_BODY}██ ██████▀  ██ ▀█▀ ██${R}       ${C_MUTED}AI spend & work attribution${R}`,
          ` ${C_BODY}██   ██ ██       ██     ██${R}       ${C_MUTED}Workspace: JPMC Core Banking  ${C_ACCENT}·${R}${C_MUTED}  Work policy: Categorized${R}`,
          `  ${C_BODY}▀███▀  ██       ██     ██${R} ${C_DOT}▄▄${R}`,
        ].join('\n'),
        confirmPrefix: `${C_ACCENT}JPMorganChase Engineering${R} ${C_MUTED}(Powered by Agentic Return)${R}`,
      };
    }

    if (key === 'custom' || customMeta.customName) {
      const [r, g, b] = hexToRgb(customMeta.customColor || '#FF4D8D');
      const C_BODY = useAnsi ? `\x1b[38;2;${r};${g};${b}m` : '';
      const C_ACCENT = useAnsi ? `\x1b[1;38;2;${r};${g};${b}m` : '';
      const disp = customMeta.customName || 'Enterprise Engineering';
      const ws = customMeta.customWorkspace || disp.split(' ')[0];
      return {
        key: 'custom',
        displayName: disp,
        workspaceName: ws,
        accentBold: C_ACCENT,
        header: [
          ` ${C_BODY}██████  ██   ██${R}      ${C_WHITE_BOLD}${disp}${R}`,
          ` ${C_BODY}██      ▀██ ██▀${R}      ${C_MUTED}Powered by ${R}${C_WHITE_BOLD}Agentic Return${R}`,
          ` ${C_BODY}██       ▄███▄ ${R}      ${C_MUTED}AI spend & work attribution${R}`,
          ` ${C_BODY}██████  ██▀ ▀██${R} ${C_ACCENT}▄▄${R}   ${C_MUTED}Workspace: ${ws}  ${C_ACCENT}·${R}${C_MUTED}  Work policy: Categorized${R}`,
        ].join('\n'),
        confirmPrefix: `${C_ACCENT}${disp}${R} ${C_MUTED}(Powered by Agentic Return)${R}`,
      };
    }

    // Default: Agentic Return (Copper)
    const C_DOT = useAnsi ? '\x1b[38;2;245;190;158m' : '';
    const C_BODY = useAnsi ? '\x1b[38;2;230;161;126m' : '';
    const C_ACCENT = useAnsi ? '\x1b[1;38;2;230;161;126m' : '';
    return {
      key: 'default',
      displayName: 'Agentic Return',
      workspaceName: opts.repo_name,
      accentBold: C_ACCENT,
      header: [
        `  ${C_DOT}▄███▄${R}  ${C_BODY}█████▄${R}       ${C_WHITE_BOLD}Agentic Return — Session context${R}`,
        ` ${C_BODY}██▄▄▄██ ██▄▄██▀${R}      ${C_MUTED}Every agent accountable. Every dollar defensible.${R}`,
        ` ${C_BODY}██   ██ ██  ██▄${R}      ${C_MUTED}AI spend & work attribution${R}`,
        ` ${C_BODY}██   ██ ██   ██${R} ${C_DOT}▄▄${R}   ${C_MUTED}Workspace: ${opts.repo_name}  ${C_ACCENT}·${R}${C_MUTED}  Work policy: Categorized${R}`,
      ].join('\n'),
      confirmPrefix: `${C_ACCENT}Agentic Return${R}`,
    };
  }

  function renderFullTenantView(brand) {
    const C_ACCENT_BOLD = brand.accentBold;

    const formatLeftRow = (tag, isAccentTag, idStr, projStr) => {
      const plainLen = 1 + tag.length + 2 + idStr.length + (projStr ? 1 + projStr.length : 0);
      const padSpaces = ' '.repeat(Math.max(2, 42 - plainLen));
      const coloredTag = isAccentTag ? `${C_ACCENT_BOLD}${tag}${R}` : `${C_MUTED}${tag}${R}`;
      const coloredId = projStr ? `${C_WHITE}${idStr}${R}` : `${C_MUTED}${idStr}${R}`;
      const coloredProj = projStr ? ` ${C_MUTED}${projStr}${R}` : '';
      return ` ${coloredTag}  ${coloredId}${coloredProj}${padSpaces}`;
    };

    const row1Left = formatLeftRow('#1', true, t1.work_item_id.padEnd(9, ' '), t1.project);
    const row2Left = formatLeftRow('#2', true, t2.work_item_id.padEnd(9, ' '), t2.project);
    const row3Left = formatLeftRow('#3', true, t3.work_item_id.padEnd(9, ' '), t3.project);
    const row4Left = formatLeftRow('#0', false, 'No ticket', '');
    const row5Left = ' '.repeat(42);

    const twoColumnTable = [
      `🎫 ${C_ACCENT_BOLD}YOUR OPEN TICKETS${R}                      🧭 ${C_ACCENT_BOLD}WORK ACTIVITY${R}`,
      `${C_MUTED}Where does this work belong?              What are you doing?${R}`,
      `${C_DIM}────────────────────────────────────      ──────────────────────────${R}`,
      `${row1Left}${C_ACCENT_BOLD}#a${R}  🛠️ ${C_WHITE}Dev / Feature${R}`,
      `${row2Left}${C_ACCENT_BOLD}#b${R}  ⚡ ${C_WHITE}Ad-hoc${R}`,
      `${row3Left}${C_ACCENT_BOLD}#c${R}  📚 ${C_WHITE}Learn${R}`,
      `${row4Left}${C_ACCENT_BOLD}#d${R}  🔬 ${C_WHITE}R&D Research${R}`,
      `${row5Left}${C_ACCENT_BOLD}#e${R}  🐛 ${C_WHITE}Bug / Incident${R}`,
      ``,
      `🔗 ${C_WHITE}Example: ${t3.work_item_id} [${C_ACCENT_BOLD}#3${R}${C_WHITE}] + Dev/Feature [${C_ACCENT_BOLD}#a${R}${C_WHITE}] → ${C_ACCENT_BOLD}#3a${R}`,
      `▶  ${C_WHITE_BOLD}Example prompt: ${C_ACCENT_BOLD}#3a${R} ${C_WHITE_BOLD}${userPromptSample}${R}`,
      ``,
      `💡 ${C_MUTED}No ticket? Start your first prompt with an activity tag.${R}`,
      `   ${C_MUTED}Example: ${C_ACCENT_BOLD}#b${R}${C_MUTED} Explain this API → No ticket + Ad-hoc.${R}`,
      ``,
      `❓ ${C_MUTED}Show open tickets: type ${C_ACCENT_BOLD}#?${R}`,
    ].join('\n');

    const friendlyStartBanner = [
      '',
      brand.header,
      ``,
      `${C_WHITE}Link this session to your work.${R}`,
      `${C_WHITE}Type your tag at the start of your first prompt, then your request.${R}`,
      ``,
      twoColumnTable,
    ].join('\n');

    const menuCard = ['', brand.header, ``, twoColumnTable].join('\n');

    const isDemoMode =
      process.argv.includes('--demo') ||
      process.argv.includes('--demo-all') ||
      process.argv.includes('--demo-intel') ||
      process.argv.includes('--demo-stripe') ||
      process.argv.includes('--demo-nvidia') ||
      process.argv.includes('--demo-jpmorgan') ||
      process.argv.includes('--demo-ar');

    const rawResolvedActivity = result.vector_2_what_work_happened?.activity_type;
    const resolvedWorkItemId = isDemoMode
      ? t3.work_item_id
      : result.vector_1_where_spend_belongs?.work_item_id || priorCtx.work_item_id || '__unticketed__';
    const resolvedProject = isDemoMode
      ? t3.project
      : result.vector_1_where_spend_belongs?.project || 'Innovation Allowance';
    const resolvedActivityCode = isDemoMode
      ? 'DEVELOPMENT'
      : (rawResolvedActivity && rawResolvedActivity !== 'UNKNOWN' ? rawResolvedActivity : '') ||
        priorCtx.activity_type ||
        'ADHOC';
    const activityLabel = ACTIVITY_DISPLAY_LABELS[resolvedActivityCode] || resolvedActivityCode;
    const ticketDisplay =
      resolvedWorkItemId === '__unticketed__'
        ? 'No ticket (Innovation Allowance)'
        : `${resolvedWorkItemId}: ${resolvedProject}`;

    const consolidatedConfirmation = [
      `✅ ${brand.confirmPrefix} | ${C_WHITE_BOLD}${ticketDisplay}${R} | ${C_ACCENT_BOLD}${activityLabel}${R}`,
      `${C_MUTED}${segmentNote ? `${segmentNote}. ` : ''}Context set. No need to tag again unless your work changes.${R}`,
      ``,
      `🔄 ${C_MUTED}Change activity: use ${C_ACCENT_BOLD}#a–#e${R}${C_MUTED} (keeps ticket).${R}`,
      `🎫 ${C_MUTED}Change ticket + activity: use a tag like ${C_ACCENT_BOLD}#3a${R}${C_MUTED}.${R}`,
      `❓ ${C_MUTED}Show open tickets: type ${C_ACCENT_BOLD}#?${R}`,
    ].join('\n');

    return { friendlyStartBanner, friendlyBlockMessage: friendlyStartBanner, menuCard, consolidatedConfirmation };
  }

  // Handle --demo-all (renders all 5 enterprise tenant styles sequentially)
  if (process.argv.includes('--demo-all')) {
    for (const preset of ['intel', 'stripe', 'nvidia', 'jpmorgan', 'default']) {
      const b = buildTenantBrandBundle(preset);
      const v = renderFullTenantView(b);
      console.log(`\n${C_DIM}════════════════════════════════════════════════════════════════════${R}`);
      console.log(`  TENANT PRESET: ${b.displayName.toUpperCase()} (--set-tenant ${preset})`);
      console.log(`${C_DIM}════════════════════════════════════════════════════════════════════${R}\n`);
      console.log(v.friendlyStartBanner + '\n');
      console.log(`${C_DIM}────────────────────────────────────────────────────────────────────${R}\n`);
      console.log(v.consolidatedConfirmation + '\n');
    }
    process.exit(0);
  }

  // Determine which tenant preset to render
  const savedCfg = loadSavedTenantConfig();
  let activeTenantKey = savedCfg.tenant || 'default';
  const demoIdx = process.argv.indexOf('--demo');
  if (demoIdx !== -1 && process.argv[demoIdx + 1]) {
    activeTenantKey = process.argv[demoIdx + 1].toLowerCase();
  } else if (process.argv.includes('--demo-intel')) {
    activeTenantKey = 'intel';
  } else if (process.argv.includes('--demo-stripe')) {
    activeTenantKey = 'stripe';
  } else if (process.argv.includes('--demo-nvidia')) {
    activeTenantKey = 'nvidia';
  } else if (process.argv.includes('--demo-jpmorgan')) {
    activeTenantKey = 'jpmorgan';
  } else if (process.argv.includes('--demo-ar')) {
    activeTenantKey = 'default';
  }

  const activeBrand = buildTenantBrandBundle(activeTenantKey, savedCfg);
  const {
    friendlyStartBanner,
    friendlyBlockMessage,
    menuCard,
    consolidatedConfirmation,
  } = renderFullTenantView(activeBrand);

  const hasSavedSession = Boolean(priorCtx.activity_type && priorCtx.activity_type !== 'UNKNOWN');
  const effectiveStartBanner = hasSavedSession ? consolidatedConfirmation : friendlyStartBanner;

  if (
    process.argv.includes('--demo') ||
    process.argv.includes('--demo-intel') ||
    process.argv.includes('--demo-stripe') ||
    process.argv.includes('--demo-nvidia') ||
    process.argv.includes('--demo-jpmorgan') ||
    process.argv.includes('--demo-ar')
  ) {
    console.log('\n' + friendlyStartBanner + '\n');
    console.log(`${C_DIM}────────────────────────────────────────────────────────────────────${R}\n`);
    console.log(consolidatedConfirmation + '\n');
    process.exit(0);
  }

  if (opts.interactive_cli) {
    if (isBlocked) {
      console.error('\n' + friendlyBlockMessage + '\n');
      process.exit(2);
    } else {
      console.log('\n' + (inlineTags.show_menu ? menuCard : consolidatedConfirmation) + '\n');
      process.exit(0);
    }
  } else {
    if (isBlocked) {
      // For Claude Code UserPromptSubmit and Cursor beforeSubmitPrompt: returning Exit Code 0 with decision:"block" / continue:false
      // blocks the prompt cleanly WITHOUT printing an ugly shell exit-code error prefix!
      if (
        (opts.agent_tool === 'claude-code' && eventLower === 'userpromptsubmit') ||
        (opts.agent_tool === 'cursor' && eventLower === 'beforesubmitprompt')
      ) {
        process.stdout.write(
          JSON.stringify({
            continue: false,
            stopReason: friendlyBlockMessage,
            decision: 'block',
            reason: friendlyBlockMessage,
            permission: 'deny',
            user_message: friendlyBlockMessage,
            agent_message: friendlyBlockMessage,
          }) + '\n'
        );
        process.exit(0);
      }

      process.stderr.write(friendlyBlockMessage + '\n');
      if (opts.agent_tool !== 'claude-code') {
        process.stdout.write(
          JSON.stringify({
            continue: false,
            stopReason: friendlyBlockMessage,
            decision: 'block',
            reason: friendlyBlockMessage,
            permission: 'deny',
            user_message: friendlyBlockMessage,
            agent_message: friendlyBlockMessage,
            permissionDecision: 'deny',
            permissionDecisionReason: friendlyBlockMessage,
          }) + '\n'
        );
      }
      process.exit(2);
    } else {
      // Only show a message in the UI on SessionStart OR when the user just tagged/switched the session!
      // Stay 100% silent on Stop, PreToolUse, and subsequent already-tagged prompts!
      const shouldShowBanner = isSessionStart || (didUserProvideInlineTag && !isSilentLifecycleEvent);

      const optDelivery = deliverOptimizations(result, sessionKey, opts.agent_tool, opts.cwd, eventLower);

      if (!shouldShowBanner) {
        // Quiet path; still hand newly delivered fixes to Claude Code once per session.
        const quietContext =
          optDelivery && optDelivery.agentText
            ? {
                systemMessage: optDelivery.bannerLine,
                hookSpecificOutput: {
                  hookEventName: isSessionStart ? 'SessionStart' : 'UserPromptSubmit',
                  additionalContext: optDelivery.agentText,
                },
              }
            : {};
        process.stdout.write(
          JSON.stringify({
            continue: true,
            suppressOutput: !optDelivery || !optDelivery.agentText,
            permission: 'allow',
            permissionDecision: 'allow',
            ...quietContext,
          }) + '\n'
        );
        process.exit(0);
      }

      const baseMessage = isSessionStart
        ? effectiveStartBanner
        : inlineTags.show_menu
          ? menuCard
          : consolidatedConfirmation;
      const brief = result && result.memory_brief;
      const briefHuman = brief && brief.human ? String(brief.human) : '';
      const withBrief = briefHuman
        ? isSessionStart
          ? `${briefHuman}\n\n${baseMessage}`
          : `${baseMessage}\n\n${briefHuman}`
        : baseMessage;
      const cleanMessage = optDelivery && optDelivery.bannerLine ? `${withBrief}\n\n${optDelivery.bannerLine}` : withBrief;
      // Claude Code: put the full project -> feature -> ticket context into the agent's context window.
      const agentParts = [
        brief && brief.agent && opts.agent_tool === 'claude-code' ? String(brief.agent) : '',
        optDelivery && optDelivery.agentText ? optDelivery.agentText : '',
      ].filter(Boolean);
      const agentContext = agentParts.length
        ? {
            hookSpecificOutput: {
              hookEventName: isSessionStart ? 'SessionStart' : 'UserPromptSubmit',
              additionalContext: agentParts.join('\n\n'),
            },
          }
        : {};

      process.stdout.write(
        JSON.stringify({
          continue: true,
          suppressOutput: false,
          systemMessage: cleanMessage,
          permission: 'allow',
          user_message: cleanMessage,
          agent_message: cleanMessage,
          permissionDecision: 'allow',
          permissionDecisionReason: cleanMessage,
          ...agentContext,
        }) + '\n'
      );
      process.exit(0);
    }
  }
} catch (err) {
  const errMsg = `[AgentReturn Hook Warning] Backend unreachable (${(err && err.message) || err}) — failing open.`;
  if (opts.interactive_cli) {
    console.error(errMsg);
  } else {
    process.stdout.write(
      JSON.stringify({
        continue: true,
        permission: 'allow',
        permissionDecision: 'allow',
      }) + '\n'
    );
  }
  process.exit(0);
}
