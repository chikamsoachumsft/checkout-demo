# Instructions for AI agents working in this repo

This project uses **AgentReturn shared project memory**. Everyone on the project — people and their
agents (Claude Code, Cursor, Copilot, ChatGPT…) — reads from and writes to the same memory, so whoever
joins next can pick up without re-reading everything. Treat it like the project's group chat.

The memory tool is `node scripts/agentreturn.mjs` (aliases below use `npm run`). The project is set in
`.agentreturn.json`; the person's access is in `~/.agentreturn/config.json` (created by `npm run join`).
If a command says the token is missing, ask the person to run `npm run join`.

## 1. Before you start work
1. Read the project context. In Claude Code it is injected automatically at session start and when a
   ticket is picked. In other tools, run:
   ```
   node scripts/agentreturn.mjs brief            # add --ticket DEV-145 for a specific ticket
   ```
2. Respect the **current decisions** listed there. If your work needs to reverse one, say so to the
   person before doing it, and record the new decision with `--supersedes <entry id>`.
3. Need more history? `node scripts/agentreturn.mjs feed --ticket DEV-145 --full` or
   `node scripts/agentreturn.mjs project`.

## 2. After each unit of work, log one entry
A unit of work is a finished piece of work, a decision, a meaningful discussion, or research — **not**
every prompt. Log it before you hand back to the person:

```
node scripts/agentreturn.mjs log \
  --type WORK \
  --title "Idempotency keys for refunds" \
  --summary "refund() now sends an idempotency key; tests added" \
  --ticket DEV-145 \
  --files src/checkout/charge.ts,tests/checkout/idempotency.test.ts \
  --agent "Claude Code" \
  --body-file - <<'EOF'
What was done: …
Why / decisions: …
Dead ends: …
How it was verified (and what was NOT): …
Open items: …
EOF
```
On Windows PowerShell, write the body to a file and use `--body-file notes.md` instead of `-`.

### Entry format
| Field | Rule |
| :--- | :--- |
| `--type` | `WORK` (built/changed something) · `DECISION` (a choice others must respect) · `DISCUSSION` (conclusions of a conversation — a summary, never a transcript) · `RESEARCH` (options compared, findings) |
| `--title` | Short, specific |
| `--summary` | **One line**, ≤ 300 characters — this is what appears in other people's catch-ups |
| `--body` / `--body-file` | What was done, why, dead ends, verification (including what was not tested), open items |
| `--ticket` | The ticket you worked on (e.g. `DEV-145`). Defaults to a ticket key in the git branch name. The feature is filled in automatically. |
| `--files` | Comma-separated files you changed |
| `--agent` | Your tool/agent name, e.g. `Claude Code`, `Cursor`, `GitHub Copilot` |
| `--supersedes` | Entry id of a decision this one replaces |
| `--restricted` | Only for the project owner's private notes — visible to the author and owners only |

The person (author) is taken from their access token, so you never type it.

## 3. Rules
- Log **summaries and conclusions**, not transcripts, secrets or personal data.
- One entry per unit of work; keep the summary to one line.
- Tell the person what you logged (title and id) when you finish.
- Never copy restricted entries into the code, commits or other entries.

## About the code
- `src/checkout/retry-worker.ts` — server-side payment retries (DEV-142). No client-side retries; no queue-based retry (decided 16 Oct).
- `src/checkout/charge.ts`, `src/checkout/idempotency.ts` — idempotency keys on payment writes (DEV-145).
- `src/checkout/webhook-handler.ts` — webhook dedupe by event id (DEV-147).
- `src/checkout/gateway-mock.ts` — fake gateway, sometimes slow.
- `src/legacy-billing/` — deprecated; don't scan it unless the task is about legacy invoices.
- Run: `npm install`, `npm test`, `npm start` → http://localhost:5060
- `TODO(DEV-xxx)` comments mark where each ticket's work goes.
