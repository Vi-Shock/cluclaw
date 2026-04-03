# CLAUDE.md — CluClaw

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
- **ALWAYS** access LLM via `context.llm.extractStructured()` or `context.llm.generateText()` inside skills
- `src/core/llm.ts` exports the underlying functions — only `src/core/agent.ts` and `src/memory/group-context.ts` import from it directly
- Provider is configured via `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` env vars
- Vision calls use `VISION_PROVIDER` / `VISION_MODEL` (falls back to LLM config)
- STT calls use `STT_PROVIDER` / `STT_MODEL` — STT uses `openai`/`groq-sdk` directly in `src/utils/stt.ts` (not Vercel AI SDK, which has no STT abstraction)

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
  skillMd?: string;  // loaded automatically from SKILL.md at startup — use for few-shot prompts

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
  history: GroupMessage[];               // recent messages (last N, configurable via HISTORY_LIMIT)
  timezone: string;                      // group timezone (default from DEFAULT_TIMEZONE env)
  llm: {                                 // provider-agnostic LLM access
    extractStructured<T>(prompt: string, schema: ZodSchema<T>, options?: { vision?: boolean; imageBase64?: string; systemPrompt?: string }): Promise<T>;
    generateText(prompt: string, options?: { systemPrompt?: string }): Promise<string>;
  };
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
# === Bot Identity ===
BOT_NAME=CluClaw

# === Channel Configuration ===
WHATSAPP_ENABLED=false          # default false — uses unofficial API, use a dedicated number
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=             # from @BotFather — disable Group Privacy in BotFather settings

# === LLM Configuration ===
LLM_PROVIDER=groq               # openai | anthropic | groq | google | ollama | mistral
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=
LLM_BASE_URL=                   # required for ollama (http://localhost:11434)

# === Vision Model (for receipt photos) ===
VISION_PROVIDER=                 # defaults to LLM_PROVIDER (model must support vision)
VISION_MODEL=                    # defaults to LLM_MODEL
VISION_API_KEY=                  # defaults to LLM_API_KEY

# === Speech-to-Text (for voice notes) ===
STT_PROVIDER=groq               # groq | openai | local
STT_MODEL=whisper-large-v3
STT_API_KEY=                     # defaults to LLM_API_KEY

# === General ===
LOG_LEVEL=info                   # debug | info | warn | error
DATA_DIR=./data                  # where SQLite databases are stored
DEFAULT_CURRENCY=INR             # fallback when no currency symbol is detected
DEFAULT_TIMEZONE=Asia/Kolkata    # group timezone for scheduled tasks
HISTORY_LIMIT=50                 # how many recent messages to load into GroupContext
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

# Type check
npm run typecheck

# Unit tests
npm test
```

## Key Dependencies

```json
{
  "@whiskeysockets/baileys": "^6.7.x",
  "grammy": "^1.x",
  "ai": "^4.x",
  "@ai-sdk/openai": "^1.x",
  "@ai-sdk/anthropic": "^1.x",
  "@ai-sdk/groq": "^1.x",
  "@ai-sdk/google": "^1.x",
  "better-sqlite3": "^11.x",
  "zod": "^3.x",
  "dotenv": "^16.x",
  "openai": "^4.x",
  "groq-sdk": "^0.7.x"
}
```

All four `@ai-sdk/*` provider packages are bundled. Users switch between them via `LLM_PROVIDER` env var — no reinstall needed. `openai` and `groq-sdk` are used directly in `src/utils/stt.ts` for the Whisper STT API.

## Current Development Phase

**Phase: Expense-Split Feature Complete — Next: Second Skill**

All 7 MVP phases are shipped, plus a full post-MVP feature pass on the expense-split skill:
1. ✅ Core infrastructure (config, llm.ts, message-bus, skill-loader, scheduler)
2. ✅ Telegram channel (grammY, privacy mode OFF, media download, group join detection)
3. ✅ Expense-split skill — see full capability list below
4. ✅ WhatsApp channel (Baileys, QR auth, rate limiting, exponential backoff reconnection)
5. ✅ Platform-aware formatter (WhatsApp vs Telegram markup differences)
6. ✅ Voice note support (STT — Groq / OpenAI / local whisper.cpp)
7. ✅ Receipt photo support (Vision — any vision-capable model)

**Expense-Split Skill — Shipped Capabilities:**
- Natural language extraction (English, Hindi, Hinglish) + two-stage regex→LLM pipeline
- Debt simplification algorithm (minimises transaction count)
- Auto-registration of unknown members as placeholders (expenses never lost)
- Expense targeting by `#N` position (DESC order — newest = #1, matches `details` display)
- `resolveExpenseTarget()` — position → description fuzzy match → most recent fallback
- Dual timestamps: `expense_date` (when money changed hands) vs `created_at` (when recorded)
- LLM resolves relative dates ("yesterday", "last Tuesday") into YYYY-MM-DD
- Append-only `expense_events` audit log; `history #N` shows full change timeline per expense
- Rich group-visible before→after edit confirmations for all edit operations
- `✏️` indicator on edited expenses in `details` list
- Edit ops (command + NL): split members, add person, remove person, amount, payer, date, description
- Unequal splits: exact amounts (`Ravi:200, Priya:150`) and percentages (`Ravi:60%, Priya:40%`)

Next priorities:
1. Action Tracker skill (extracts commitments + deadlines, scheduler-driven reminders)
2. Poll / Vote skill (skill-state machine pattern)
3. Trip Planner skill (uses url.ts for link metadata)

## Testing Approach

- **Unit tests** (automated): `npm test` — Node.js built-in test runner, no extra deps
  - `src/skills/expense-split/parser.test.ts` — 25+ regex filter tests (no LLM, fast)
  - `src/skills/expense-split/ledger.test.ts` — balance + debt simplification with in-memory SQLite
  - `src/skills/expense-split/test-messages.json` — 30+ test message bank for manual/LLM testing
- **Manual integration testing**: run `npm run dev`, add bot to a private Telegram group, send messages
- Test against Telegram first (faster iteration than WhatsApp)
- Use `LOG_LEVEL=debug` in `.env` to see detailed parsing output during testing
