# ACP Mode

ACP mode implements the [Agent Client Protocol](https://agentclientprotocol.com/) (JSON-RPC 2.0 over stdio) so pi can be driven directly by any ACP-speaking editor or client — no adapter process in between.

```bash
pi --mode acp [options]
```

Same startup options as [RPC mode](rpc.md) apply (`--provider`, `--model`, `--session-dir`, `--approve`, etc.). Every non-protocol byte pi would otherwise print (extension `console.log`, startup chatter, package-manager output) is redirected to stderr, so stdout carries only JSON-RPC frames.

**Note for Node.js/TypeScript users**: if you're embedding pi in a Node application rather than talking ACP over a subprocess, use `AgentSession` directly from `@earendil-works/pi-coding-agent` instead — see [`src/core/agent-session.ts`](../src/core/agent-session.ts).

## Connecting from Emacs agent-shell

[agent-shell](https://github.com/xenodium/agent-shell) speaks ACP natively. Point it at pi with `agent-shell-define-agent` and add the result to `agent-shell-agent-configs`:

```elisp
(use-package agent-shell
  :config
  (add-to-list 'agent-shell-agent-configs
               (agent-shell-define-agent
                :name "pi"
                :command "pi"
                :args '("--mode" "acp")
                :envs '(("NODE_NO_WARNINGS" . "1")))))
```

If pi isn't on `agent-shell`'s `exec-path`, use an absolute path to the `pi` binary (or to `dist/cli.js` in a source checkout) in `:command`. Run `M-x agent-shell` and select the `pi` config to start a session.

## Manual verification checklist

Run this checklist against a real agent-shell session (against the built `dist/cli.js --mode acp`, not `tsx`) before trusting a change to ACP mode — the automated tests below cover the protocol machinery in isolation, but they use a faux model and never exercise a real editor:

- [ ] **Model selection.** Open Agent Shell's model picker; it lists every model available to pi. Switch models and confirm the header updates before sending the next prompt.
- [ ] **Thinking level.** Open Agent Shell's thought-level picker, change the reasoning effort, and confirm the header updates before the next prompt.
- [ ] **No session modes.** Confirm Agent Shell's session-mode control is empty. Pi has no permission/sandbox modes and deliberately does not alias them to thinking, so nothing is advertised there; the thought-level picker is the only thinking control. Switch between reasoning and non-reasoning models and confirm its available choices refresh.
- [ ] **Streaming text.** Send a prompt; the assistant's reply appears incrementally as it streams, not all at once at the end.
- [ ] **Separate thought sections.** With a reasoning-capable model, thinking content renders in its own section, distinct from the reply text (`agent_thought_chunk` vs `agent_message_chunk`).
- [ ] **Tool calls with diffs.** Ask for a file edit; the tool call shows up with a title and, for edit/write, a rendered diff — not just raw JSON arguments.
- [ ] **Terminal delegation on a bash command.** Ask the agent to run a shell command. With agent-shell's terminal capability advertised, the command runs in a client-owned terminal (`terminal/create`/`terminal/output`/`terminal/wait_for_exit`), not silently in a detached pi subprocess. Killing the buffer mid-command should tear the terminal down cleanly (no orphaned process, no hang on exit).
- [ ] **Usage display.** After a turn, `M-x agent-shell-show-usage` reports non-zero tokens and a context figure; with `agent-shell-show-context-usage-indicator` set (the default), the context indicator appears and tracks the window across turns. Resume a session and confirm the indicator is populated before the first prompt of the new connection.
- [ ] **Kill buffer + resume via `session/load`.** Kill the agent-shell buffer mid-session, then reopen and resume the same session. The prior transcript replays before the client can prompt, and a follow-up prompt continues with the right context.
- [ ] **`--approve` for project trust.** In an untrusted project directory, start pi without `--approve` and confirm project-scoped resources (extensions, prompt templates, etc.) are skipped with a warning on stderr; then restart with `--approve` and confirm they load. ACP mode has no interactive trust prompt — `--approve` (or one prior interactive/trusted run of pi in that directory) is the only headless way to trust a project.

## Scope: what's supported

- Model and thinking-level discovery and switching through ACP session configuration (`session/new`, `session/load`, and `session/set_config_option`)
- Model-specific thinking choices refreshed after model changes (`category: thought_level`)
- Streaming assistant text and thinking (`agent_message_chunk` / `agent_thought_chunk`)
- Tool-call translation (`tool_call` / `tool_call_update`) with kind/title/locations and diff content for edits and writes. Displayable tool-result text is bounded to 2,000 lines or 50 KiB; the complete result remains in Pi's model context and ACP `rawOutput`.
- fs delegation (`fs/read_text_file` / `fs/write_text_file`), gated on `clientCapabilities.fs`
- Terminal delegation (`terminal/*`), gated on `clientCapabilities.terminal`
- Extension UI bridge: `ctx.ui.confirm` / `ctx.ui.select` round-trip through `session/request_permission`
- `session/load` with full transcript replay, and `available_commands_update` for extension commands, prompt templates, and skills
- Usage reporting: cumulative token counts on the `session/prompt` response, plus `usage_update` notifications carrying context fill and session cost
- Multiple concurrent sessions per connection, each an independent pi session

### Usage reporting

ACP splits usage across two channels, and clients read them independently — agent-shell renders its context indicator from the notification and its token breakdown from the response — so pi emits both:

- **`usage_update` notification.** Context tokens and window size, plus cumulative cost in USD. Sent when a turn settles and again after `session/load` replay, so a resumed session shows context before its first prompt. Identical consecutive snapshots are dropped: a turn settles twice internally (once on `agent_settled`, once when the prompt call resolves), and turns that run no model at all — extension slash commands — move no counters.
- **`usage` on the `session/prompt` response.** Cumulative `totalTokens` / `inputTokens` / `outputTokens` / `cachedReadTokens` for the session, with `thoughtTokens` included only when a provider reported a reasoning breakdown.

Both come from `AgentSession.getSessionStats()`, whose totals span every entry ever written to the session — including history compaction dropped — so they reflect what was actually billed rather than what is currently in context. pi buckets cache traffic separately from uncached input, so `inputTokens` is uncached input only and `totalTokens` is the sum of all four buckets.

Two values can read as zero rather than absent: `size` is 0 when no model is selected or the model declares no context window, and `used` is 0 between a compaction and the next assistant response, when the only usage pi could read describes the pre-compaction context. The following turn overwrites it with a real measurement.

### Out of scope

**Session modes are explicitly out of scope.** pi has no permission or sandbox modes, so `session/new` and `session/load` advertise no `modes` and `session/set_mode` is not implemented. An earlier revision (and the external `pi-acp` adapter) aliased the mode control to the thinking level; that made clients label reasoning effort as a "mode", so the alias — both the legacy `modes` list and the duplicate `mode` config option — was removed. Thinking level lives in exactly one place: the `thought_level` config option. Clients that predate `session/set_config_option` therefore have no way to change it.

**MCP passthrough is explicitly out of scope.** pi has no MCP client of its own. `session/new`'s `mcpServers` parameter is accepted and silently ignored, and no `mcpCapabilities` are advertised in `initialize` — an honest reflection of what the agent can actually do, not an oversight.

A few `ExtensionUIContext` methods have no ACP equivalent and degrade the same way they do in RPC mode: `ctx.ui.input`/`ctx.ui.editor` resolve immediately (no round trip) with a note on stderr, `notify` goes to stderr, and widgets/status/footer/header/theme hooks are no-ops. See [`rpc.md`](rpc.md#extension-ui-protocol) for the equivalent RPC-mode behavior these mirror.

## Known limitations

### fs delegation cannot see a file that was never saved to disk

The `read`/`edit` tools check the target file with a local `access()` call before doing anything else — this check is **not** delegated to the client, even when `clientCapabilities.fs.readTextFile` is advertised. In the common case this is invisible: a file that exists on disk with unsaved editor modifications passes the local `access()` check, and the subsequent read is delegated to `fs/read_text_file`, so the agent correctly sees the editor's live buffer content instead of the stale on-disk bytes. That's the motivating case for fs delegation, and it works.

What doesn't work: a file that exists **only** as an unsaved buffer in the editor — created in the editor but never written to disk — fails the local `access()` check (`ENOENT`) before the delegated read is ever attempted, and the tool reports the file as not found. Closing that gap would mean delegating the existence check itself to the client, which ACP has no primitive for beyond the read/write calls; it wasn't worth adding a client-side existence probe for a case this narrow. If you hit this, save the buffer to disk first.

### A resumed session's replayed transcript shows more than the live session did

`session/load` replay is built from `SessionManager.buildContextEntries()` projected through the same conversion pipeline (`convertToLlm`) that builds the model's own context — not from the live `session/update` stream. The two views are not the same thing, and in a couple of cases that shows:

- **Extension `custom_message` entries with `display: true`.** These are part of the model's context (and part of pi's own TUI transcript), but the live ACP event translator only reacts to `message_update` / `tool_execution_*` / `agent_settled` — it has no handler for the underlying `entry_appended` event, so a `custom_message` injected mid-session via `pi.sendMessage()` never produces a `session/update` notification while the session is live. On replay, the same entry is converted to a `user_message_chunk` like any other context message, so it appears then for the first time.
- **Output from the `!` direct-bash command.** A bash command run via pi's `!command` input (as opposed to the agent's own `bash` tool call) is recorded as a session entry and — unless run as `!!command`, which explicitly excludes it from context — reaches the model's context. It never appears live over ACP (same reason as above: it's an appended entry, not a tool-call event), but it does appear on replay as a `user_message_chunk`. (`!!`-excluded output is filtered out of context entirely and correctly stays invisible in both the live stream and replay.)
- Entries explicitly marked hidden — `custom_message` with `display: false` — **are** filtered out of replay on purpose (pi's own TUI hides them too), so this one case does *not* leak.

Net effect: watch a session live, then reload it, and the reloaded transcript can contain messages that were never streamed the first time around. Both views are individually correct by their own rule (live streams tool/message events; replay projects the model's actual context) — they just don't agree with each other. This is left as an open design question rather than a bug fix: is the live stream missing events it should emit, is replay showing the client more than it saw live and thus over-disclosing, or is "the model's context" simply the more honest source of truth and the live gap is what should close? That call belongs to whoever owns the direction of this feature, not to this milestone.

## Automated coverage

- `packages/coding-agent/test/acp/` — in-process protocol tests against a faux model (mode plumbing, tool-call translation, fs/terminal delegation, session/load + replay, extension UI bridge, usage reporting).
- `packages/coding-agent/test/acp/acp-stdio-smoke.test.ts` — the end-to-end gate: spawns the built `dist/cli.js --mode acp` as a real child process, pipes a raw ndjson `initialize` request into stdin, and asserts every line on stdout parses as JSON-RPC (stray output on stdout corrupts the protocol stream for every client). Requires `npm run build` to have run first.
