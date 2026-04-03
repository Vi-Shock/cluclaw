# CLAUDE.md — Group AI Agent Platform

## What This Project Is

An open-source AI agent that lives inside group chats (WhatsApp + Telegram). It passively listens to natural conversation, extracts useful information, and performs tasks — without anyone needing a separate app or manual data entry.

The agent uses a skill-based architecture. The first skill is **Expense Splitting**: the agent silently tracks who paid what from natural group conversation and settles balances on demand. More skills (action tracking, polls, trip planning, etc.) can be added by the community.

Think "OpenClaw, but for groups instead of individuals."

## Tech Stack

- **Runtime:** Node.js + TypeScript (strict mode)
- **WhatsApp:** Baileys (`@whiskeysockets/baileys`) — WebSocket-based, no business API needed
- **Telegram:** grammY — TypeScript-first Telegram bot framework
- **LLM:** Provider-agnostic via Vercel AI SDK (`ai` package). User configures provider (OpenAI, Anthropic, Groq, Google, Ollama, etc.) via env vars. Skills never import provider-specific SDKs.
- **Database:** SQLite via `better-sqlite3`. Single file, zero infra. Expenses are source of truth; balances computed on-the-fly.
- **STT (voice notes):** Provider-agnostic. Configurable: Groq Whisper, OpenAI Whisper, local whisper.cpp
- **Vision (receipts/photos):** Provider-agnostic. Any vision-capable model.
- **Validation:** Zod for all schemas (LLM output, config, messages)

## Architecture Rules

### LLM Abstraction (CRITICAL)
- **NEVER** import `@anthropic-ai/sdk`, `openai`, or any provider SDK directly in skills or core logic
- **ALWAYS** use `src/core/llm.ts` which wraps Vercel AI SDK
- The `extractStructured<T>(prompt, zodSchema)` function is the ONLY way to call an LLM
- Provider is configured via `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` env vars
- Vision calls use `VISION_PROVIDER` / `VISION_MODEL` (falls back to LLM config)
- STT calls use `STT_PROVIDER` / `STT_MODEL`

### Message Bus (CRITICAL)
- WhatsApp and Telegram messages MUST be normalized to `GroupMessage` before any processing
- Skills receive `GroupMessage` — they never know which platform the message came from
- The `GroupMessage` interface:
```typescript
interface GroupMessage {
  id: string;                    // unique message ID
  groupId: string;               // group identifier (platform-specific)
  platform: 'whatsapp' | 'telegram';
  sender: {
    id: string;                  // platform user ID
    name: string;                // display name
    phoneNumber?: string;        // WhatsApp only
  };
  content: {
    text?: string;               // text content
    media?: {                    // photo, voice note, document
      type: 'image' | 'audio' | 'video' | 'document';
      buffer?: Buffer;
      mimeType: string;
      caption?: string;
    };
    quotedMessage?: GroupMessage; // if replying to another message
  };
  timestamp: Date;
  raw: any;                      // original platform message object (for edge cases)
}
```

### Skill System
- Each skill is a directory under `src/skills/`
- Must contain `SKILL.md` (metadata + LLM prompt templates) and `index.ts`
- Skill interface:
```typescript
interface Skill {
  name: string;
  description: string;
  shouldActivate(message: GroupMessage): boolean;  // FAST check, no LLM. regex/keywords only.
  handle(message: GroupMessage, context: GroupContext): Promise<SkillResponse | null>;
  commands: Record<string, CommandHandler>;  // e.g., "splits", "details", "help"

  // Optional: handle scheduled/timed triggers (reminders, recurring check-ins, poll closes)
  onScheduledTask?(task: ScheduledTask, context: GroupContext): Promise<SkillResponse | null>;

  // Optional: setup when skill is first activated in a group
  onInstall?(context: GroupContext): Promise<void>;
}

interface SkillResponse {
  text?: string;            // text to send to group
  replyTo?: string;         // message ID to reply to
  silent?: boolean;         // log only, don't send to group
}

interface ScheduledTask {
  id: string;
  skillName: string;
  groupId: string;
  executeAt: Date;
  recurrence?: string;      // cron expression for recurring tasks (e.g., "0 9 * * 1-5")
  payload: any;             // skill-specific data
}
```
- `shouldActivate()` MUST be fast (< 1ms). Use regex/keyword matching ONLY. Never call LLM here.
- `handle()` can be async and call LLM. Return `null` to stay silent.
- `onScheduledTask()` is called by the scheduler when a timed task fires. Used for reminders, recurring check-ins, poll auto-close, etc.
- Skills get a `GroupContext` with group members, conversation history, skill-specific state, and scheduler access.

### Database
- SQLite via `better-sqlite3`.
- Global database at `./data/agent.db` (scheduled tasks, skill registry)
- Per-group database at `./data/{groupId}/database.db` (expenses, skill state, message history)
- Media files stored at `./data/{groupId}/media/`
- Expenses are the source of truth. Balances are COMPUTED, not stored.
- Use Zod schemas to validate all data going in/out of the database.
- All queries must be parameterized (no string concatenation for SQL).

### Scheduler (IMPORTANT — must exist from day one)
- Located at `src/core/scheduler.ts`
- SQLite-backed task queue (stored in `agent.db`)
- Supports one-shot tasks (remind at specific time) and recurring tasks (cron syntax)
- Agent main loop checks scheduler every 60 seconds
- When a task fires: loads the skill, calls `skill.onScheduledTask(task, context)`
- Skills schedule tasks via `context.scheduler.schedule({ ... })`
- Skills cancel tasks via `context.scheduler.cancel(taskId)`
- Even though the expense skill (MVP) doesn't need the scheduler, it MUST be built into the core. Future skills (action tracker reminders, poll auto-close, standup check-ins) critically depend on it.

### Skill State (per-skill per-group persistent state)
- Skills can persist their own state across messages via GroupContext
- `context.getSkillState<T>(skillName)` → reads from SQLite, returns parsed JSON or null
- `context.setSkillState<T>(skillName, state)` → serializes to JSON, writes to SQLite
- Use cases: active polls, pending RSVPs, trip itinerary accumulation, standup collection windows
- Each skill owns its own state. Skills cannot read other skills' state.

### GroupContext (what skills receive)
```typescript
interface GroupContext {
  groupId: string;
  platform: 'whatsapp' | 'telegram';
  members: Member[];
  history: GroupMessage[];               // recent messages (last N, configurable)
  timezone: string;                      // group timezone (default from env)
  getSkillState<T>(skillName: string): T | null;
  setSkillState<T>(skillName: string, state: T): void;
  scheduler: {
    schedule(task: Omit<ScheduledTask, 'id'>): string;  // returns task ID
    cancel(taskId: string): void;
    listPending(skillName: string): ScheduledTask[];
  };
  searchHistory(query: string): GroupMessage[];  // SQLite FTS5 search over message history
}
```

### Agent Behavior
- The agent is SILENT by default. It only speaks when:
  1. Someone uses a command ("splits", "details", "help")
  2. It needs clarification on an ambiguous expense (confidence < 0.7)
  3. It confirms a correction
  4. It's first added to a group (welcome message)
- The agent NEVER participates in non-skill conversation
- The agent NEVER responds to every message

## Project Structure

```
src/
├── core/
│   ├── agent.ts              # Main loop: receive message → route to skills → send response
│   │                         # Also runs scheduler check every 60s
│   ├── message-bus.ts        # GroupMessage interface + normalization utilities
│   ├── skill-loader.ts       # Discovers and loads skills from /skills directory
│   ├── llm.ts                # Provider-agnostic LLM (Vercel AI SDK wrapper)
│   ├── config.ts             # Env var loading + validation with Zod
│   └── scheduler.ts          # SQLite-backed task queue (one-shot + cron recurrence)
├── channels/
│   ├── whatsapp.ts           # Baileys: connect, auth (QR), receive/send messages
│   ├── telegram.ts           # grammY: bot setup, receive/send messages
│   └── types.ts              # Channel-specific types
├── skills/
│   └── expense-split/
│       ├── SKILL.md           # Skill description + LLM prompt templates
│       ├── index.ts           # Implements Skill interface
│       ├── parser.ts          # Two-stage: regex filter → LLM extraction
│       ├── ledger.ts          # SQLite CRUD for expenses + balance calculation
│       ├── schemas.ts         # Zod schemas for expense data
│       └── renderer.ts        # Format expense summaries for chat
├── memory/
│   ├── store.ts              # SQLite connection wrapper (global + per-group DBs)
│   ├── group-context.ts      # Per-group state: members, preferences, skill state, history
│   └── search.ts             # Message history search (SQLite FTS5, optional vector search)
├── utils/
│   ├── stt.ts                # Voice note → text transcription
│   ├── vision.ts             # Image → structured data extraction
│   ├── url.ts                # URL metadata fetching (title, description, OG tags)
│   └── formatter.ts          # Platform-aware message formatting (WhatsApp vs Telegram)
├── index.ts                   # Entry point: load config → init channels → start agent + scheduler
└── types.ts                   # Shared types (GroupMessage, Skill, ScheduledTask, etc.)
```

### Data Directory Structure
```
data/
├── agent.db                    # Global: scheduled tasks, skill registry, global config
├── {groupId}/
│   ├── database.db             # Group-specific: expenses, action items, polls, messages, skill state
│   └── media/                  # Stored files, images, documents (for content curator skill)
│       ├── img_001.jpg
│       └── doc_001.pdf
```

## Coding Conventions

- **TypeScript strict mode** — `"strict": true` in tsconfig
- **Zod for all external data** — LLM responses, env vars, incoming messages, DB rows
- **No `any` types** except for `raw` field on GroupMessage
- **Error handling:** All LLM calls and channel operations wrapped in try/catch. Failures should be logged, not crash the agent.
- **Logging:** Use a simple logger (console with timestamps). Log level configurable via `LOG_LEVEL` env var.
- **No classes for skills** — use plain objects implementing the Skill interface
- **Functional style preferred** — pure functions where possible, minimize mutable state
- **ESM modules** — `"type": "module"` in package.json

## Environment Variables (.env)

```env
# === Channel Configuration ===
WHATSAPP_ENABLED=true
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=             # from @BotFather

# === LLM Configuration ===
LLM_PROVIDER=groq               # openai | anthropic | groq | google | ollama | mistral
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=
LLM_BASE_URL=                   # required for ollama (http://localhost:11434)

# === Vision Model (for receipt photos) ===
VISION_PROVIDER=                 # defaults to LLM_PROVIDER
VISION_MODEL=                    # defaults to LLM_MODEL (must support vision)
VISION_API_KEY=                  # defaults to LLM_API_KEY

# === Speech-to-Text (for voice notes) ===
STT_PROVIDER=groq               # groq | openai | local
STT_MODEL=whisper-large-v3
STT_API_KEY=                     # defaults to LLM_API_KEY

# === General ===
LOG_LEVEL=info                   # debug | info | warn | error
DATA_DIR=./data                  # where SQLite databases are stored
DEFAULT_CURRENCY=INR             # default currency for expense parsing
```

## Build & Run Commands

```bash
# Install dependencies
npm install

# Development (with hot reload)
npm run dev

# Production
npm run build
npm start

# Run with Docker
docker compose up
```

## Key Dependencies

```json
{
  "@whiskeysockets/baileys": "^6.7.x",
  "grammy": "^1.x",
  "ai": "^4.x",
  "better-sqlite3": "^11.x",
  "zod": "^3.x",
  "dotenv": "^16.x"
}
```

Plus one provider SDK based on user config (e.g., `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/groq`, etc.)

## Current Development Phase

**Phase: MVP — Expense Split Skill**

Priority order:
1. Core infrastructure (config, llm.ts, message-bus, skill-loader, scheduler)
2. Telegram channel (simpler to test with, bot API is straightforward)
3. Expense-split skill (parser + ledger + renderer)
4. WhatsApp channel (Baileys, QR auth)
5. Platform-aware formatter (WhatsApp vs Telegram formatting differences)
6. Voice note support (STT)
7. Receipt photo support (Vision)

## Testing Approach

- Test expense parser with a bank of example messages (see `SKILL.md` for examples)
- Test against a private Telegram group first (faster iteration than WhatsApp)
- Manual testing initially — unit tests for parser and ledger logic
- Keep a `test-messages.json` with edge cases:
  - Mixed languages ("Paid 500 rupees for chai")
  - Ambiguous splits ("me and Ravi split it")
  - Corrections ("actually that was 1800")
  - Non-expense messages that look like expenses ("I have 500 reasons to be happy")
