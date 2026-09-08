# Aether IDE

> **Agent-First AI Development Environment**
> Decoupled autonomous agent runtime, headless CLI, Fastify daemon, and VS Code integration powered by OpenRouter.

---

## Overview

**Aether** is an agent-first development environment engineered to solve the fundamental architectural limitations of traditional AI coding assistants. Rather than embedding complex agent loops, state management, and long-running subprocesses inside an Electron or VS Code extension host process, Aether decouples the runtime into an out-of-process daemon and standalone CLI.

### Core Architectural Decisions

1. **Decoupled Out-of-Process Runtime**  
   The autonomous agent loop lives in an independent daemon process (`apps/daemon`). Missions survive editor crashes, window reloads, and extension host restarts. The same runtime can run headless in CI, on remote development servers, or via the local CLI.

2. **Thin IDE Adapter**  
   The VS Code extension (`apps/extension`) serves strictly as a lightweight presentation layer: registering UI commands, managing the daemon lifecycle, rendering webview views, and bridging editor events and inline completions.

3. **Tool-First Agent Execution**  
   Autonomous agents do not engage in unbounded free-form conversational chatter. Actions are structured as tool calls with strongly typed schemas, deterministic blackboard state, loop detection, and strict budget governors.

4. **Single-Source LLM Integration via OpenRouter**  
   Unified access to state-of-the-art frontier models (Claude 3.5 Sonnet, GPT-4o, DeepSeek-R1) and ultra-fast inference models (Gemini Flash, Qwen Coder) with streaming text/reasoning deltas and cost accounting.

---

## Workspace Structure

This repository is managed as a `pnpm` monorepo coordinated by **Turborepo**:

```
aether/
├── apps/
│   ├── cli/             # Headless CLI (aether run <goal>) + SQLite persistence
│   ├── daemon/          # Fastify REST & WebSocket agent server (port 0, bearer token)
│   ├── extension/       # VS Code extension (daemon manager, webview sidebar, tab completion)
│   └── manager-ui/      # React mission control dashboard (webview)
├── packages/
│   ├── agent-core/      # Autonomous ReAct agent loop, budget governor, loop detector
│   ├── protocol/        # Shared TypeScript contracts, events, and envelopes
│   ├── providers/       # LLM provider abstractions & streaming OpenRouter client
│   └── tools/           # Security path guard, fs/search/terminal tools, JSON schemas
├── docs/                # Architecture specifications, API schemas, and roadmaps
└── scripts/             # Integration tests and verification smoke tests
```

---

## Components & Packages

### `packages/protocol`
The shared contract between all layers.
- **Event Envelopes**: Typed `MissionEvent` envelopes with monotonic sequence numbers, run IDs, and turn IDs.
- **Tool Result Types**: Uniform `ToolResult` interface with error codes, human-readable recovery steps, and execution latency.
- **Cost Ledger**: Envelopes for tracking token usage, reasoning tokens, and USD expenditures.

### `packages/providers`
LLM provider interfaces and OpenRouter client implementation.
- **`OpenRouterClient`**: Server-Sent Events (SSE) streaming with support for content deltas, reasoning/thinking deltas, multi-tool call assembly, token counting, and abort signals.

### `packages/tools`
Secure workspace tool layer for autonomous execution.
- **Path Security Guard**: Enforces strict directory boundaries to prevent path traversal and symlink escapes.
- **Canonical Tools**:
  - `fs.read`, `fs.list`, `fs.glob`, `fs.patch` (unified diff with context lines)
  - `search.grep` (ripgrep-backed search)
  - `terminal.exec` (isolated process execution with timeouts)
- **Tool Registry**: Unified namespace binding tools to a workspace root.

### `packages/agent-core`
The autonomous agent runtime engine.
- **`runAgentLoop`**: ReAct execution loop yielding asynchronous `MissionEvent` streams.
- **`BudgetTracker`**: Governor monitoring USD spend, token usage, tool call counts, and wall-clock time.
- **`LoopDetector`**: Repetition guard triggering replanning if identical actions are repeated.

### `apps/cli`
Headless command-line interface for running autonomous coding missions.
- **Command**: `aether run <goal> --repo <path>`
- **Database**: Embedded SQLite persistence via `better-sqlite3` and **Drizzle ORM** in `<repo>/.aether/aether.db` (WAL mode enabled).
- **Console Output**: Live colored turn logs using `chalk`.

### `apps/daemon`
Local agent server exposing the runtime over Fastify REST and WebSockets.
- **Loopback Binding**: Listens strictly on `127.0.0.1` with dynamic OS port allocation.
- **Auth**: Ephemeral cryptographically secure tokens written to `~/.aether/daemon.json` with strict `0600` permissions.
- **Endpoints**:
  - `GET /v1/health` — Daemon status and uptime.
  - `POST /v1/missions` — Validates payload with TypeBox, initializes SQLite, spawns unawaited background loop, and returns HTTP `202`.
  - `WS /v1/stream` — Real-time event streaming for subscribed mission IDs.
  - `POST /v1/inline/completion` — Fast-path Fill-In-The-Middle (FIM) tab completion.

### `apps/extension`
VS Code extension adapter.
- **Daemon Lifecycle Manager**: Automatically starts the detached daemon process on launch and cleans up gracefully without terminating surviving runs.
- **Agent Sidebar (`aether.sidebar`)**: Webview activity bar view receiving live mission streams over the WebSocket bridge.
- **Inline Tab Completion**: Debounced (150ms) Fill-In-The-Middle provider with keystroke cancellation wired to VS Code `CancellationToken`.
- **Context Bridge**: Exposes editor LSP diagnostics to the daemon.

---

## Getting Started

### Prerequisites

- **Node.js**: `v20.0.0` or higher (Node 22+ recommended)
- **pnpm**: `v12.0.0` or higher
- **OpenRouter API Key**: Obtainable from [openrouter.ai](https://openrouter.ai)

### Installation

Clone the repository and install workspace dependencies:

```bash
git clone https://github.com/avishka-hashara/aether-intelligent-ide.git
cd aether
pnpm install
```

### Environment Configuration

Create a `.env` file in the root directory:

```bash
OPENROUTER_API_KEY="your-openrouter-api-key-here"
```

---

## Build & Test Workflows

The monorepo uses Turborepo for cached, parallel builds:

```bash
# Build all packages and applications
pnpm run build

# Run TypeScript typechecks across the monorepo
pnpm run typecheck

# Run test suites across all packages and applications (Vitest)
pnpm run test

# Run ESLint with architectural boundary rule enforcement
pnpm run lint
```

---

## Running the Components

### 1. Headless CLI

Run an autonomous coding mission against any target workspace:

```bash
# Build CLI
pnpm --filter @aether/cli run build

# Execute mission
node apps/cli/dist/index.js run "Refactor logger to structured JSON" --repo ./my-project
```

### 2. Agent Daemon

Start the daemon manually in standalone mode:

```bash
node apps/daemon/dist/index.js
```

The daemon prints the assigned port and writes authentication metadata to `~/.aether/daemon.json`.

### 3. VS Code Extension

1. Open this repository in VS Code.
2. Ensure dependencies are built: `pnpm run build`.
3. Press `F5` (or launch via the Run & Debug panel using the preconfigured **"Launch Extension"** profile).
4. An Extension Development Host window will launch with the Aether Activity Bar view and commands available (`aether.chat.focus`, `aether.inlineEdit`, `aether.openManager`).

---

## Architectural Rules

To maintain modularity, ESLint enforces architectural boundaries via `eslint-plugin-boundaries`:
- **Adapters (`apps/extension`)** and **UI (`apps/manager-ui`)** must never import business logic directly from core packages (`agent-core`, `providers`, `tools`).
- Communications between the IDE and the Agent Runtime must go through the **Protocol (`@aether/protocol`)** over REST and WebSockets.

---

## License

ISC License. See [LICENSE](LICENSE) for details.
