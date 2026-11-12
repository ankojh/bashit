# bashit

A local agent harness whose model has exactly one tool: **`bash`**. Reading
files, editing them, running Python or Node, installing packages, fetching
URLs — everything is a bash command. A small web UI streams the transcript and
shows each command as a card.

Models run on the subscriptions already signed in on this machine:

- **Claude** through [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), using the local `claude` login.
- **Codex** through `codex exec --json`, using the ChatGPT login in `~/.codex/auth.json`.

No API keys are required or read.

> **No sandbox.** bashit runs commands as your user, with your files and
> network access. The workspace is a starting directory, not a security
> boundary. Only run prompts you would run in your own terminal.

## Requirements

- macOS or Linux, Node 22, `pnpm`.
- Claude Code CLI, logged in with a subscription: `claude` then `/login`.
- Codex CLI, logged in with ChatGPT: `codex login`.
- Verified with `claude` 2.1.322, `codex` 0.158.0, Node 22.21.1.

## Run

```bash
pnpm install
pnpm dev          # tsx watch, http://127.0.0.1:4545
# or
pnpm start        # one process, no watch
```

Open <http://127.0.0.1:4545>. `PORT=...` changes the port. The server binds to
`127.0.0.1` only.

The server must stay running while you use the UI. `pnpm dev` restarts it
whenever a file under `src/` changes, which kills any in-flight turn; use
`pnpm start` for normal use. If the header says "server offline", restart the
server and press Send again.

Scripts:

| command | what it does |
| --- | --- |
| `pnpm dev` | start with file watching |
| `pnpm start` | start once |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Node's test runner over `test/*.test.ts` |

## Use

1. Pick a model. The model is fixed for a chat; changing it starts a new chat.
2. Optionally set an absolute workspace path. Leave it blank for a fresh
   directory under `workspaces/<session-id>/`.
3. Type a prompt. Enter sends, Shift+Enter inserts a newline.
4. Each bash call appears as a collapsible card with the command, live status,
   output and an exit-code badge. **Stop** aborts a running turn and kills the
   command's process group.
5. Follow-up prompts resume the same provider conversation, so the model sees
   the earlier context and files.

Try:

```
create fib.py that prints the first 20 Fibonacci numbers, run it
```

Sessions live in memory only. Restarting the server forgets them.

## Auth

**Claude.** The agent SDK spawns the local `claude` CLI. It uses the
subscription login that `claude` already stores; bashit strips the API-key and
cloud-provider variables from the environment handed to the SDK, so it cannot
silently fall back to API billing. `settingSources: []`, `tools: []`,
`strictMcpConfig: true` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` keep the user's
`CLAUDE.md`, hooks, skills, settings, built-in Claude Code tools and the
account's claude.ai connectors out. The SDK init message reports only
`mcp__bashit__bash`; bashit aborts the turn if any other tool appears, and a
non-bash tool call becomes an `error` event. It also refuses an init whose
`apiKeySource` is not `"none"` or `"oauth"`, so a Console/API-key login cannot
silently bill the API.

**Codex.** bashit creates an isolated `CODEX_HOME` at `.bashit/codex-home/`
(gitignored). `auth.json` is a **symlink** to `~/.codex/auth.json`, so token
refreshes stay shared with the real Codex login. A generated `config.toml`
points at the bash MCP server and pre-approves its `bash` tool. The user's own
MCP servers, hooks, plugins, skills and `AGENTS.md` do not load. `OPENAI_API_KEY`,
`CODEX_API_KEY`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from
the child environment. The symlinked login must be a ChatGPT login
(`auth_mode` `"chatgpt"` with tokens); an API-key login is refused.

## The one tool

`src/bash-mcp.ts` is a stdio MCP server mounted identically by both providers.
It exposes `bash`:

```json
{ "command": "string", "timeout_sec": 120 }
```

- Runs `bash -lc <command>` in the session workspace.
- Every call is a fresh shell; `cd` does not persist. The tool description
  tells the model to chain with `&&` or write a script.
- stdout and stderr are combined.
- Output over 30,000 characters keeps the first 10,000 and last 20,000 with a
  `[... N chars truncated ...]` marker.
- `timeout_sec` defaults to 120 and is capped at 600. On timeout or abort the
  entire process group is killed (`detached: true` + `process.kill(-pid)`).
- The result ends with `[exit code: N]`, or `[timed out after Ns]` and
  `[exit code: null]` when killed.

The system prompt is shared by both providers and tells the model it has one
tool, where the workspace is, to write scripts when useful, and to keep output
small.

## Architecture

```
public/index.html        UI: prompt, model picker, SSE transcript, bash cards
src/server.ts            Hono app, in-memory sessions, SSE, abort
src/bash-mcp.ts          stdio MCP server; the only tool
src/system-prompt.ts     shared prompt
src/models.ts            model ids and labels
src/events.ts            HarnessEvent schema
src/providers/claude.ts  Agent SDK query(), event mapping
src/providers/codex.ts   codex exec --json, JSONL mapping, isolated home
src/mcp-config.ts        absolute tsx + bash-mcp command for both providers
```

HTTP:

- `GET /api/models` → `[{ id, label, provider }]`
- `POST /api/chat` with `{ sessionId?, model, prompt, workspace? }` → SSE
- `POST /api/chat/:id/abort` → abort the running turn

SSE events are exactly the `HarnessEvent` union in `src/events.ts`: `session`,
`text`, `tool_call`, `tool_result`, `done`, `error`. One running turn per
session; a second gets HTTP 409. A model different from the session's model gets
HTTP 400 with `code: "model_mismatch"`.

## Codex specifics

The exact command for a new turn:

```
codex exec --json --skip-git-repo-check -C <workspace> -s danger-full-access \
  -m <model> \
  --disable shell_tool --disable unified_exec --disable shell_snapshot \
  --disable apps --disable browser_use --disable browser_use_external \
  --disable computer_use --disable image_generation --disable view_image \
  --disable multi_agent --disable hooks --disable plugins \
  --disable plugin_sharing --disable skill_search --disable tool_suggest \
  --disable sleep_tool --disable goals --disable memories \
  --disable code_mode --disable in_app_browser --disable realtime_conversation \
  -c developer_instructions="<shared system prompt>" \
  -c mcp_servers.bashit.env.BASHIT_CWD="<workspace>" -
```

Resume replaces the `-C`/`-s` pair with
`codex exec resume <thread_id> ... --dangerously-bypass-approvals-and-sandbox ...`
because `exec resume` does not accept `-s` in 0.158.0. The prompt is written to
stdin (`-`) to avoid argv limits. Codex's own sandbox is irrelevant to command
execution: bashit's MCP server runs the command, not Codex's shell. The
generated config sets `startup_timeout_sec = 30` and `tool_timeout_sec = 660`,
so Codex's default MCP call timeout cannot undercut bashit's 600 s cap.

### Why a local model catalog?

Codex 0.158's models are `tool_mode = "code_mode_only"`. The model gets a
`functions.exec` JavaScript wrapper (Code Mode), and every real tool is nested
inside it. This build also locks `tool_search_always_defer_mcp_tools` on while
removing `tool_search`, so MCP tools configured in `config.toml` are connected
but not model-visible. Direct tool mode is not a workaround: Codex concatenates
namespace and name without a separator, so a direct MCP call fails as
`unsupported call: mcp__bashitbash` (openai/codex#31748).

bashit therefore generates `.bashit/codex-home/models.json` from
`codex debug models` and removes the native `apply_patch`, web search,
multi-agent and clock tool metadata. The result is:

- `functions.exec` and `functions.wait` — Code Mode's wrapper, not command tools;
- nested `mcp__bashit__bash` — the only command tool the model can call.

Codex's JSONL stream emits `mcp_tool_call` items for `bashit.bash`; the harness
maps those to `tool_call`/`tool_result`. This was verified against a local mock
Responses API, which also produced the fixture in
`test/fixtures/codex-mock-turn.jsonl`.

## Known gaps

- **Live Codex runs are blocked on this machine by an account-side spend cap.**
  Every current `codex exec` call returns:
  `You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.`
  bashit shows that as one clean `error` event. Raise the cap or switch the
  ChatGPT login, then rerun the Codex prompt. The Codex provider, tool surface,
  flags and JSONL mapping were verified end-to-end against the mock provider.
- **Codex's Code Mode wrapper is unavoidable.** The model's top-level tools are
  `functions.exec` and `functions.wait`. It reaches bash through
  `functions.exec`; there is no direct top-level bash tool in this Codex build.
  Native apply_patch, shell, web search, browser, computer use, image and
  multi-agent tools are disabled or removed from the catalog.
- **Codex model ids follow the installed CLI, not a newer cache.** The ticket
  listed `gpt-6.1-*`, which `codex` 0.158.0 does not know (`gpt-6.1-sol`
  returns `model_not_found`). The picker lists `gpt-6-astra`, `gpt-6-sol`,
  `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- **Claude models are passed through by id.** `claude-sonnet-5-5` and
  `claude-haiku-5-5` were exercised; the others are listed from the environment
  and may depend on the account's model access.
- **Claude connectors are blocked, with a backstop.** `strictMcpConfig: true`
  plus `ENABLE_CLAUDEAI_MCP_SERVERS=false` keep the account's claude.ai
  connectors out of the tool list. If a future CLI exposes any tool other than
  `mcp__bashit__bash`, the init guard aborts the turn instead of letting it run.
- **No persistence, no auth on the UI, one user.** Sessions die with the
  process; the server binds loopback only.
- **`.bashit/codex-home/models.json` is generated.** If Codex is upgraded, the
  catalog regenerates on the next Codex turn (keyed by `codex --version`).
- **Codex `auth.json` is symlinked, not copied.** If Codex ever replaces the
  symlink with a regular file during a token refresh, bashit relinks to
  `~/.codex/auth.json`; it deliberately does not copy a newer file back into
  the real Codex home. Run `codex login` again if the login looks stale.

## Tests

`pnpm test` runs Node's built-in test runner through `tsx`. The suite covers the
bash MCP tool (exit codes, truncation, timeout process-group kill), the Codex
JSONL mapper against `test/fixtures/codex-mock-turn.jsonl`, the Claude message
mapper against `test/fixtures/claude-messages.json`, and the server's session
rules (unknown session, model mismatch, concurrent turn 409).

Fixtures were recorded from real runs: the Codex one from a local mock
Responses API that returns a bash MCP call, the Claude one from a real
`claude-haiku-5-5` turn.
