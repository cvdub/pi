# Native ACP Support in pi (`pi --mode acp`)

## Context

Christian uses pi from **Emacs agent-shell** via the external [svkozak/pi-acp](https://github.com/svkozak/pi-acp) adapter, which spawns `pi --mode rpc` and translates. It works but lacks fs/terminal delegation, MCP passthrough, a separate thought stream, and robust session resume. This plan builds ACP (Agent Client Protocol — JSON-RPC 2.0 over stdio) **directly into pi** as a new core mode on branch `claude/pi-acp-support-2gpbj2` — a personal-fork feature, not an upstream PR, structured so coding agents can build it under minimal supervision.

Decisions confirmed with Christian:
- **Client**: Emacs agent-shell — verified to support fs delegation, terminal, `request_permission`, thought chunks, session load, and slash-command discovery, so every planned feature gets exercised.
- **Priorities**: (1) fs/terminal delegation, (2) thought stream, (3) session resume/history replay. **MCP passthrough is out of scope** — pi has no MCP support out of the box and we're not adding one; `session/new`'s `mcpServers` param is accepted and ignored, and no `mcpCapabilities` are advertised. IDE permission prompts are not a goal, but extension UI calls must not break.
- **Protocol layer**: official `@agentclientprotocol/sdk` — pin **exactly 1.3.0** (verified on npm; `AgentSideConnection` is deprecated there in favor of a new App API, so pinning protects against removal; the legacy `@zed-industries/agent-client-protocol` package is stale — don't use it).
- **Fork hygiene**: rebase-friendly — all logic in new files under `packages/coding-agent/src/modes/acp/`; existing files get only the surgical plumb-throughs listed below.

Upstream discussion [earendil-works/pi#4444](https://github.com/earendil-works/pi/discussions/4444) proposes the same architecture, with maintainer guidance we follow: each ACP sessionId maps to exactly one authoritative pi session record; advertise only capabilities that actually work.

## Architecture

RPC mode (`src/modes/rpc/rpc-mode.ts`) is the structural template. ACP mode is a sibling: `runAcpMode(runtime, deps)` builds an SDK `Stream` over stdio and hands it to `startAcpAgent(stream, deps)` (exported separately so tests drive it with in-memory streams). `PiAcpAgent` implements the SDK `Agent` interface; an `AcpSessionRegistry` maps ACP sessionId → `AcpSessionHandle` (one `AgentSessionRuntime` + event translator + pending prompt trackers per session). **ACP sessionId == pi session id** (the SessionManager UUID) — no mapping file; `session/load` resolves via `SessionManager.list/.listAll`.

### New files

```
packages/coding-agent/src/acp-entry.ts        # published entry, mirrors rpc-entry.ts
packages/coding-agent/src/modes/acp/
  acp-mode.ts             # runAcpMode + startAcpAgent(stream, deps); stdio wiring, signals, shutdown
  acp-agent.ts            # PiAcpAgent: initialize/newSession/loadSession/prompt/cancel/authenticate
  session-registry.ts     # AcpSessionRegistry; handle creation wraps CreateAgentSessionRuntimeFactory
  event-translator.ts     # AgentSessionEvent -> session/update notifications; TurnTracker for stopReason
  tool-call-mapper.ts     # kind/title/locations/content (diffs), status mapping, update throttling
  content.ts              # ACP ContentBlock[] <-> pi text/images (shared with replay)
  history-replay.ts       # session/load: SessionManager entries -> ordered session/update stream
  fs-delegation.ts        # createAcpRead/Edit/WriteOperations (cap-gated, local fallback)
  terminal-delegation.ts  # createAcpBashOperations over terminal/* (poll deltas, kill, release)
  extension-ui.ts         # confirm/select -> session/request_permission; rest headless fallback
  types.ts                # AcpModeOptions, AcpSessionHandle, ClientCaps
packages/coding-agent/test/acp/
  acp-harness.ts + per-milestone test files (see milestones)
```

### Surgical edits to existing files (the complete list — nothing else changes)

- **E1 `src/cli/args.ts`**: add `"acp"` to `Mode` (line 10) and to the `--mode` validation (line 80 — currently *silently drops* unknown modes, so pi would launch the wrong mode without this); mention in `printHelp`. Never add a bare `--acp` flag — the parser would swallow it as an extension flag.
- **E2 `src/core/project-trust.ts:12`**: add `"acp"` to `AppMode`.
- **E3 `src/core/extensions/types.ts:304`**: add `"acp"` to `ExtensionMode` (so `ctx.mode === "acp"`). If `InputSource` is a closed union, prefer reusing `"rpc"` over widening more types.
- **E4 `src/main.ts`**: `resolveAppMode` returns `"acp"`; include acp in the `@file`-args rejection (~line 546), the piped-stdin skip (~line 768 — otherwise `readPipedStdin` eats the client's `initialize`), the background `modelRuntime.refresh()` (~line 812); add dispatch branch `await runAcpMode(runtime, { createRuntime, ... })` (~line 816); `createRuntime` closure forwards a new optional factory field (`toolsOptions`) into `createAgentSessionFromServices`.
- **E5 `src/core/agent-session-runtime.ts:35`**: add optional `toolsOptions?: ToolsOptions` to `CreateAgentSessionRuntimeFactory` options (ACP injects it by *wrapping* the factory, so `/new`/fork rebinds inherit delegation automatically).
- **E6 `src/core/agent-session-services.ts`**: pass `toolsOptions` through `createAgentSessionFromServices`.
- **E7 `src/core/sdk.ts` + `src/core/agent-session.ts`**: add `toolsOptions?: ToolsOptions` to options/config; in `_buildRuntime` (agent-session.ts:2562, verified) merge into the `createAllToolDefinitions(this._cwd, {...})` call, keeping settings-derived defaults (`autoResizeImages`, `commandPrefix`, `shellPath`) unless overridden. ~10 lines; the seam that makes fs/terminal delegation possible.
- **E8/E9 `src/modes/index.ts` + `src/index.ts`**: export `runAcpMode` and public ACP types alongside `runRpcMode`.
- **E10 `package.json`**: dep `@agentclientprotocol/sdk@1.3.0`; add `"./acp-entry"` export; add `dist/acp-entry.js` to the build chmod list.

## Key design decisions

- **Stdout purity**: `takeOverStdout()` already fires for non-interactive modes and redirects `process.stdout.write` to stderr. Build the outbound `WritableStream` on `writeRawStdout` + `waitForRawStdoutBackpressure` (`src/core/output-guard.ts:85-103`, verified) — never on `process.stdout` directly, and never call `restoreStdout()` (the guard keeps extension `console.log` off the wire). Inbound: `Readable.toWeb(process.stdin)`; framing via the SDK's `ndJsonStream` (do NOT reuse `modes/rpc/jsonl.ts` — mixing framers double-buffers stdin).
- **Runtime per session**: dispose the bootstrap runtime main.ts builds, create a fresh runtime per `session/new`/`session/load` via the wrapped factory so each session binds the client's cwd. On extension-driven session replacement (`/new`, fork), keep serving the same ACP sessionId over the new pi session using the `setRebindSession` pattern (rpc-mode.ts:312-363): re-subscribe, re-`bindExtensions`, re-register backpressure — forgetting this silently kills all updates after `/new`.
- **Prompt lifecycle**: resolve `session/prompt` on **`agent_settled`** (not `agent_end` — `willRetry` turns would return early). `session/cancel` → `session.abort()` with the TurnTracker pre-marked so the prompt resolves `stopReason: "cancelled"` after final updates flush. Mid-turn second prompt → `session.prompt(text, { streamingBehavior: "steer" })`, both pending requests resolve at the next settle. Preflight failures → JSON-RPC error via the `preflightResult` hook (rpc-mode.ts:393-414 pattern).
- **Event translation**: `text_delta` → `agent_message_chunk`; `thinking_delta` → `agent_thought_chunk` (priority 2 falls out here); assistant `toolcall_end` → `tool_call` (pending, with kind/title/locations/rawInput); `tool_execution_start` → `in_progress`; `tool_execution_update` → snapshot `tool_call_update` — **`partialResult` is cumulative, not a delta**; ACP content replaces, so send snapshots throttled ≥100ms per toolCallId, always flush final; `tool_execution_end` → `completed`/`failed` + content + rawOutput. Emit `available_commands_update` after bind/rebind (build like rpc-mode.ts:663-692; clients invoke via `/name` text which `session.prompt()` already expands). Backpressure: await the notify tail in a subscriber like rpc-mode.ts:360-362.
- **Tool-call mapping**: kinds — read→`read`, edit/write→`edit`, bash→`execute`, grep/find/ls→`search`, extension/unknown→`other`. Edit tool input `{path, edits:[{oldText,newText}]}` → one ACP `diff` content block per edit (exact, input-derived); write → diff with `oldText: null`.
- **fs delegation** (gated on `clientCapabilities.fs`): delegate text reads to `fs/read_text_file` (the point is seeing unsaved editor buffers), writes to `fs/write_text_file`; keep local: image/binary sniffing and reads, `mkdir` (ACP has no mkdir; agent and client share a filesystem over stdio), and fall back to local on client `RequestError`. Ops interfaces already receive absolute paths — ACP's requirement is satisfied as-is.
- **Terminal delegation** (gated on `clientCapabilities.terminal`): `BashOperations.exec` → `terminal/create` (argv form `sh -c <cmd>`; pass only `PI_*`/spawn-hook env deltas, not full env), poll `currentOutput()` ~150ms emitting suffix deltas to `onData`, `waitForExit` for exit code, abort/timeout → `kill()` with pi's existing error formats, **always `release()` in `finally`**. No cap → `createLocalBashOperations` fallback.
- **session/load**: advertise `loadSession: true`. Resolve id via `SessionManager.list`, open with client cwd as override (authoritative; avoids `MissingSessionCwdError`), replay `getContextEntries()` (leaf path, compaction-aware) as user/agent/thought chunks + completed `tool_call`s through the same mapper, then return.
- **Extension UI bridge**: `confirm`/`select` → `session/request_permission` (yes-no / one option per choice; cancelled → default), honoring signal/timeout like rpc's dialogs; `input`/`editor` → resolve default + stderr note; `notify` → stderr; widgets/status → no-ops (rpc-mode.ts:135-310 is the template). Project trust stays headless — document `--approve` / one-time interactive trust, warn on stderr when untrusted.
- **initialize** response: `{ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [] }` — no `mcpCapabilities` (honest advertisement; `session/new`'s `mcpServers` param is ignored). Stash `clientCapabilities`.

## Milestones

Each is independently landable and verified by `./test.sh` + `npm run check` with **no real model or editor**: the harness registers a faux provider (`registerFauxProvider` from `@earendil-works/pi-ai/compat`) in a real runtime factory — copy the setup from `test/suite/agent-session-runtime.test.ts:38-90`, NOT `test/rpc.test.ts` (that one needs real API keys and is CI-skipped) — and connects the SDK client side over two crossed `TransformStream`s to `startAcpAgent`. Faux provider registration is process-global: always unregister in `afterEach`.

- **M1 — Mode plumbing + core loop.** E1-E9, `acp-entry.ts`, acp-mode/agent/registry, translator (text+thinking), content, types, harness. Accept: initialize negotiates; `session/new` returns a UUID matching the pi session file id in a temp session dir; prompt streams `agent_message_chunk`s and resolves `end_turn`; scripted reasoning yields `agent_thought_chunk`s; mid-stream `session/cancel` → `cancelled`; mid-turn second prompt steers, both resolve; unknown sessionId → JSON-RPC error; `parseArgs(["--mode","acp"]).mode === "acp"`.
- **M2 — Tool-call translation.** tool-call-mapper + wiring. Accept: read/bash/edit/write (real local tools, temp cwd) produce pending → in_progress → completed with correct kind/title/locations; failure → `failed`; edit emits exact diff content; bash partial output yields throttled snapshot updates (assert no duplicated concatenation); `available_commands_update` after session/new.
- **M3 — fs delegation.** fs-delegation + handle toolsOptions. Accept: with fs caps, read returns client content differing from disk (unsaved-buffer sim); edit round-trips through client; write mkdirs locally then delegates; caps off → disk only; image read bypasses; client error → disk fallback.
- **M4 — Terminal delegation.** Accept: scripted client terminal (cumulative "a","ab", exit 0) → onData deltas "a","b", exitCode 0; nonzero exit → error result; abort → kill + release + "Command aborted"; timeout path; no cap → real local `echo hi` works.
- **M5 — session/load + replay + multi-session.** Accept: create/prompt/dispose, reconnect, `session/load` streams full history **before** resolving, follow-up prompt carries prior context (assert in faux request); wrong id → error; two concurrent sessions interleave independently; cancel targets only its session.
- **M6 — Extension UI bridge + rebind.** Accept: inline extension's `ctx.ui.confirm` → `request_permission` round-trip; cancelled → false; select maps options; input resolves without round-trip; extension `/new` command → same ACP sessionId keeps streaming (rebind regression test); `ctx.mode === "acp"`.
- **M7 — Packaging, docs, manual verification.** E10, `acp-entry.ts` chmod, short `docs/acp.md`. Accept: `npm run build` → executable `dist/acp-entry.js`; piping a raw ndjson `initialize` into `node dist/cli.js --mode acp` returns a valid response with **zero non-protocol bytes on stdout**. Manual recipe (goes in docs/acp.md): point agent-shell at `pi --mode acp` via `agent-shell-agent-configs` / `agent-shell-define-agent`; checklist — streaming text, separate thought sections, tool calls with diffs, terminal delegation on a bash command, kill buffer + resume via session/load, `--approve` for project trust.

Order: M1 → M2, then **M3/M4 are mutually independent and parallelizable across agents**, then M5, M6, M7.

## Gotchas for executing agents

1. E1 must land first — today `--mode acp` silently falls through and print mode eats stdin.
2. Outbound stream on `writeRawStdout`, never `process.stdout` (takeover redirects it to stderr); don't call `restoreStdout()`.
3. `partialResult` is cumulative — send replacing snapshots, don't diff-append.
4. Resolve prompts on `agent_settled`, never `agent_end`.
5. Rebind pattern is mandatory after any `newSession/switchSession/fork` (rpc-mode.ts:312-363).
6. `session/load` must pass client cwd override to `SessionManager.open` or deleted-cwd sessions throw.
7. Tests under `packages/coding-agent/test/` (root `test.sh` runs per-package); unregister faux providers in `afterEach`.
8. Terminal handles: `release()` in `finally` on every path including kill/timeout.
9. Anchor edits by function names, not line numbers, when rebasing on upstream.

## Verification

Automated: `npm run check` (biome + tsgo) and `./test.sh` from repo root after every milestone — the in-process harness makes each milestone's acceptance criteria a vitest assertion. End-to-end: M8's stdio smoke test, then live agent-shell session against the built `dist/cli.js --mode acp` exercising the M8 checklist. Commit per milestone; push to `claude/pi-acp-support-2gpbj2`.
