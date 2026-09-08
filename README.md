# Aether IDE — Agent-First AI Development Environment

> Working codename. Rename before any public build (see `06-security-ops-legal.md` §5 for trademark constraints).

An agent-first IDE with two surfaces — a familiar **Editor View** and an async **Manager View** that
orchestrates parallel autonomous agents — powered entirely by the OpenRouter API.

---

## The three decisions that shape everything else

**1. Do not fork VS Code on day one. Fork it last.**

Almost everything you need is reachable from the stock VS Code extension API: webview panels
(Manager View), inline completions, inline diff/decoration, terminals via `node-pty`, LSP access,
custom editors. A fork buys you exactly four things: your own branding and title bar, your own
marketplace, telemetry control, and a standalone installable product. Those are *distribution*
concerns, not capability concerns.

So: build as an extension + daemon, then fork only to ship. Full decision matrix in
`01-architecture.md` §2.

**2. The agent runtime lives outside the IDE process.**

A long-running agent daemon (`aetherd`), separate from Electron and the extension host. Missions
survive window reloads, crashes, and IDE restarts. The same daemon runs headless in CI or on a
remote box with no IDE at all. The IDE becomes one client among several. This single choice is what
lets you go from "chat sidebar" to "mission control" without a rewrite.

**3. Agents don't chat with each other. They call each other as tools.**

Free-form multi-agent conversation is where token budgets go to die and determinism disappears.
Sub-agents are invoked with typed inputs and return typed outputs. Shared state lives on a
blackboard, not in a transcript. See `02-agent-system.md` §4.

---

## Document map

| Doc | Contents |
|---|---|
| `01-architecture.md` | Tech stack, base-IDE decision matrix, process/component model, repo layout, data model |
| `02-agent-system.md` | Agent roles, orchestration, mission state machine, artifacts, isolation, context engine |
| `03-openrouter-integration.md` | LLM layer, tool-calling loop, model routing, streaming, cost ledger, context budget |
| `04-api-schemas.md` | Daemon REST/WS API, event envelopes, tool JSON Schemas, DB DDL, artifact schemas |
| `05-roadmap.md` | Chronological build plan, Phase 0 → Phase 8, with commands and exit criteria |
| `06-security-ops-legal.md` | Sandboxing, permission engine, secrets, packaging, licensing and trademark |
| `reference/protocol.ts` | Shared TypeScript types — the contract between daemon, IDE and UI |
| `reference/openrouter-client.ts` | Production-shaped OpenRouter client (streaming, tools, retries, cost) |
| `reference/agent-loop.ts` | The core ReAct loop with tool dispatch and budget enforcement |

---

## Stack at a glance

- **Shell** — VS Code fork built via a VSCodium-style patch pipeline (Phase 7 only)
- **Adapter** — TypeScript VS Code extension, thin, no business logic
- **Runtime** — Node.js 22 + TypeScript daemon, Fastify + WebSocket, custom orchestrator
- **State** — SQLite (better-sqlite3) + Drizzle ORM; artifacts on disk under `.aether/`
- **Isolation** — git worktrees per agent, optional Docker sandbox, `node-pty` terminals
- **Context** — ripgrep + web-tree-sitter + sqlite-vec embeddings + LSP passthrough
- **Verification** — Playwright (Chromium) for browser artifacts, test/build/lint runners
- **Manager UI** — React 19 + Vite + Tailwind + shadcn/ui + Zustand, in a webview
- **LLM** — OpenRouter `/api/v1/chat/completions` exclusively
- **Interop** — Model Context Protocol servers as first-class tool providers

---

## Realistic scope

A credible v1 by a small team is 4–6 months. The extension + daemon + single-agent loop
(Phases 0–2) is roughly 5 weeks and is where you learn whether the product is worth building. Do
not start with the fork; teams that do spend their first month on build scripts and code-signing
instead of on the agent loop that is the actual product.
