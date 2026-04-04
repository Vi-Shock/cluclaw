<p align="center">
  <img src="assets/cluclaw-logo.png" alt="CluClaw" width="200" />
</p>

<h1 align="center">CluClaw</h1>

<p align="center">
  <strong>The AI that silently manages your group chats.</strong><br/>
  WhatsApp · Telegram · Open Source · Self-Hosted · Skill-Based
</p>

<p align="center">
  <a href="SETUP.md">Quickstart</a> ·
  <a href="#how-it-works">How it Works</a> ·
  <a href="#skills">Skills</a> ·
  <a href="#build-a-skill">Build a Skill</a> ·
  <a href="https://github.com/Vi-Shock/cluclaw/issues">Issues</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/Vi-Shock/cluclaw?style=social" />
  <img src="https://img.shields.io/github/license/Vi-Shock/cluclaw" />
  <img src="https://img.shields.io/badge/platforms-WhatsApp%20%7C%20Telegram-25D366" />
  <img src="https://img.shields.io/badge/LLM-any%20provider-blueviolet" />
</p>

---

## Your group chat already has the data. CluClaw finds the clues.

Every group chat is full of decisions, expenses, plans, and action items — buried in noise. CluClaw is an AI agent that **passively listens** to your group conversations and **silently does useful work** — no forms, no app-switching, no "@bot" tagging required.

**The name:**  
**Clu** → Clue (finds signals in noise)  
**Kulu** (குலு) → Group in Tamil  
**Claw** → Inspired by the OpenClaw ecosystem  

---

## See it in action

```
👤 Vishak: Guys I booked the Airbnb, ₹18,000 for 3 nights
👤 Ravi: Nice! Lunch was ₹3,200 at Martin's Corner, I got it
👤 Priya: Ravi and I split a cab from airport ₹600
👤 Deepa: Beer round on me tonight 🍺 ₹1,800
      ...
      (20 messages of regular conversation, memes, and photos)
      ...
👤 Vishak: splits

🤖 CluClaw:
💰 Settlements

→ Ravi owes Vishak ₹3,100
→ Priya owes Vishak ₹3,400
→ Deepa owes Vishak ₹2,950

Type details to see all expenses.
```

**No one opened Splitwise. No one manually entered an expense. CluClaw just knew.**

---

## Quickstart

```bash
git clone https://github.com/Vi-Shock/cluclaw.git
cd cluclaw
npm install
cp .env.example .env      # configure your LLM provider + Telegram bot token
npm run dev
```

**→ Full step-by-step instructions: [SETUP.md](SETUP.md)**

**Requirements:** Node.js 22+ · Any LLM API key (or local Ollama)

---

<a id="how-it-works"></a>
## How It Works

```
Group Chat Message
    ↓
┌─────────────────────────────┐
│  Channel Adapter             │  Normalizes WhatsApp/Telegram
│  (Baileys / grammY)          │  into unified GroupMessage
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  Media Pre-processing        │  Voice note → STT → text
│  (src/core/agent.ts)         │  Receipt photo → Vision → text
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  Skill Router                │  Each skill checks:
│                              │  "Is this message for me?"
│  ┌─── Expense Split ✓       │  Fast regex check (< 1ms)
│  ├─── Action Tracker ✗      │  No LLM call here
│  ├─── Poll ✗                │
│  └─── Trip Planner ✗        │
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  Active Skill                │  LLM extracts structured
│  (Expense Split)             │  data from natural language
│                              │
│  "Lunch was ₹3,200, I got   │  → { payer: "Ravi",
│   it"                        │      amount: 3200,
│                              │      split: ["all"],
│                              │      category: "food" }
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  SQLite                      │  Persist. Compute balances.
│  (local, per-group)          │  Your data never leaves
│                              │  your machine.
└─────────────────────────────┘
```

### Two-Stage Parsing (keeps costs near-zero)

1. **Fast filter** — Regex checks for `₹`, `$`, `paid`, `spent`, numbers. 90%+ of messages (memes, jokes, "haha") are skipped instantly. No LLM cost.
2. **LLM extraction** — Only triggered for likely matches. Any provider works: GPT-4o-mini, Claude, Groq, Ollama. Returns structured JSON via Zod schema.

### Multi-Language Support

The expense parser handles English, Hindi, and Hinglish out of the box:
- `"Paid ₹2400 for the Airbnb"` ✓
- `"Maine 200 diye petrol ke liye"` ✓ *(I paid 200 for petrol)*
- `"sabne petrol dala, total 450 hua"` ✓ *(Everyone put in petrol, total 450)*

---

<a id="skills"></a>
## Skills

CluClaw is a **platform**, not just an expense tracker. Skills are modular, community-contributed plugins.

| Skill | Status | What it does |
|---|---|---|
| 💰 **Expense Split** | ✅ Shipped | Passively tracks who paid what. Calculates & simplifies settlements. |
| ✅ **Action Tracker** | 🔜 Next | Extracts commitments from chat. Reminds before deadlines. |
| 📊 **Poll / Vote** | 🔜 Planned | Creates polls from conversation. Tallies votes. |
| 🗺️ **Trip Planner** | 🔜 Planned | Builds itinerary from scattered messages, links, photos. |
| 🧠 **Group Memory** | 🔜 Planned | "What did we decide about the venue?" — answers from history. |
| 📋 **RSVP Tracker** | 🔜 Planned | Collects availability, finds overlap, suggests best time. |
| 🔖 **Content Curator** | 🔜 Planned | Saves and organizes all links/files shared in the group. |
| 📝 **Standup Bot** | 🔜 Planned | Scheduled check-ins. Collects updates. Posts daily digest. |

**Want a skill that doesn't exist?** [Build one](#build-a-skill) or [request it](https://github.com/Vi-Shock/cluclaw/issues/new).

---

## LLM Agnostic — Bring Your Own Model

CluClaw does **not** lock you into any AI provider. Configure any LLM:

| Provider | Model | Cost | Setup |
|---|---|---|---|
| **Groq** | Llama 3.3 70B | Free tier available | `LLM_PROVIDER=groq` |
| **Ollama** | Any local model | Free (runs on your hardware) | `LLM_PROVIDER=ollama` |
| **OpenAI** | GPT-4o-mini | ~$0.15/1M tokens | `LLM_PROVIDER=openai` |
| **Anthropic** | Claude Haiku | ~$0.80/1M tokens | `LLM_PROVIDER=anthropic` |
| **Google** | Gemini Flash | Free tier available | `LLM_PROVIDER=google` |

```env
LLM_PROVIDER=groq
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=gsk_...
```

---

## Privacy First

- **Self-hosted** — CluClaw runs on YOUR machine. Not our servers.
- **No cloud dependency** — Use Ollama for fully local, offline operation.
- **Per-group isolation** — Each group gets its own SQLite database. Groups can't see each other's data.
- **You own your data** — Plain SQLite files in `./data/`. Export, delete, or migrate anytime.
- **Open source** — Audit every line. MIT licensed.

---

<a id="build-a-skill"></a>
## Build a Skill

Skills are simple TypeScript modules. Here's the skeleton:

```typescript
// src/skills/my-skill/index.ts
import type { Skill, GroupMessage, GroupContext, SkillResponse } from '../../types.js';

export default {
  name: 'my-skill',
  description: 'Does something useful for the group',

  // Fast check — regex only, no LLM. Called for EVERY message. Must be < 1ms.
  shouldActivate(message: GroupMessage): boolean {
    return /keyword|pattern/i.test(message.content.text ?? '');
  },

  // Process the message. Call LLM here if needed.
  async handle(message: GroupMessage, context: GroupContext): Promise<SkillResponse | null> {
    const data = await context.llm.extractStructured(
      `Extract X from: "${message.content.text}"`,
      myZodSchema
    );
    // Store in SQLite, return response or null (stay silent)
    return { text: `Got it: ${data.summary}` };
  },

  // Explicit commands users can type
  commands: {
    'my-command': async (args: string, context: GroupContext) => {
      return { text: 'Here is what I found...' };
    }
  }
} satisfies Skill;
```

Every skill gets access to:
- `context.llm` — Provider-agnostic LLM calls (`extractStructured`, `generateText`)
- `context.members` — Who's in the group (with aliases)
- `context.history` — Last 50 messages
- `context.getSkillState() / setSkillState()` — Persistent JSON state per group
- `context.scheduler` — Schedule future messages (reminders, recurring tasks)
- `context.searchHistory(query)` — Full-text search over past messages (SQLite FTS5)

Each skill directory also needs a **`SKILL.md`** with:
- Description and activation signals
- LLM system prompt template
- Few-shot examples for the LLM

See [`src/skills/expense-split/`](src/skills/expense-split/) for a complete reference implementation.

---

## Commands Reference

| Command | Aliases | Description |
|---|---|---|
| `splits` | `balances`, `settle up` | Show simplified settlements (who owes whom) |
| `details` | `expenses`, `detail` | List all expenses with `#N` IDs and edit indicators |
| `history #N` | — | Full audit trail for expense #N |
| `remove #N` | — | Delete expense at position #N |
| `remove last` | `undo` | Delete the most recent expense |
| `edit #N split Ravi, Priya` | — | Change who shares expense #N (equal) |
| `edit #N split Ravi:200, Priya:150` | — | Unequal exact split |
| `edit #N split Ravi:60%, Priya:40%` | — | Percentage-based split |
| `edit #N add Ravi` | — | Add Ravi to the split (recalculates shares) |
| `edit #N remove Priya` | — | Remove Priya from the split |
| `edit #N amount 350` | — | Correct the amount |
| `edit #N payer Supriya` | — | Change who paid |
| `edit #N date 1 Apr` | — | Correct when the expense happened |
| `edit #N description Dinner at Martin's` | — | Rename the expense |
| `settle <name> <amount>` | — | Record a payment between members (e.g. `settle Ravi 500`) |
| `help` | — | Show all commands |

All commands work with or without a `/` prefix (`splits` or `/splits`).

**Natural language also works** — just chat normally:
- *"Actually add Ravi to the cab"* → adds Ravi, recalculates shares
- *"Remove Supriya from the hotel"* → removes Supriya, recalculates shares
- *"Rename the hotel to Airbnb"* → updates the description
- *"Ravi owes 200 and Priya owes 150 for dinner"* → records with unequal shares
- *"Supriya paid Vishak 500"* → records a settlement payment

---

## Roadmap

- [x] Core agent with skill system
- [x] Telegram support (grammY)
- [x] WhatsApp support (Baileys)
- [x] LLM-agnostic provider system (Vercel AI SDK)
- [x] Expense Split skill (Hinglish support, debt simplification, receipt scanning)
- [x] Expense targeting by `#N` position — no ambiguity when editing
- [x] Full audit trail with `history #N` — who changed what and when
- [x] Dual timestamps — expense date vs date recorded (supports backdating)
- [x] Rich edit confirmations — group-visible before→after diffs
- [x] Add / remove people from a split post-creation
- [x] Unequal splits — exact amounts and percentages, NL + command
- [x] Description editing via command and natural language
- [x] Natural language settlement detection ("Supriya paid Vishak 500")
- [x] Voice note support (STT — Groq / OpenAI / local whisper.cpp)
- [x] Receipt photo scanning (Vision — any vision-capable model)
- [x] SQLite FTS5 message history search
- [x] Scheduler (one-shot + recurring cron tasks)
- [ ] Skill registry / marketplace
- [ ] Action Tracker skill
- [ ] Poll / Vote skill
- [ ] Web dashboard
- [ ] Multi-currency conversion (rates API)
- [ ] UPI settlement links

---

## Project Structure

```
src/
├── core/
│   ├── agent.ts          # Main loop: receive → pre-process → route → respond
│   ├── config.ts         # Zod-validated env var loading
│   ├── llm.ts            # Provider-agnostic LLM wrapper (Vercel AI SDK)
│   ├── logger.ts         # Minimal logger with LOG_LEVEL + ANSI colors
│   ├── message-bus.ts    # WhatsApp/Telegram → GroupMessage normalization
│   ├── scheduler.ts      # SQLite task queue (one-shot + cron recurrence)
│   └── skill-loader.ts   # Dynamic skill discovery from src/skills/
├── channels/
│   ├── telegram.ts       # grammY: connect, receive, send, media download
│   └── whatsapp.ts       # Baileys: QR auth, connect, receive, send, rate limit
├── skills/
│   └── expense-split/
│       ├── SKILL.md      # Prompt templates + 10 few-shot examples
│       ├── index.ts      # Skill interface implementation
│       ├── parser.ts     # Fast regex filter + LLM extraction + name resolution
│       ├── ledger.ts     # SQLite CRUD + balance calc + debt simplification
│       ├── renderer.ts   # Message formatters (splits, details, help, welcome)
│       └── schemas.ts    # Zod schemas for LLM output + DB rows
├── memory/
│   ├── store.ts          # SQLite connection pool + migrations
│   ├── group-context.ts  # GroupContext factory
│   └── search.ts         # FTS5 full-text search over message history
├── utils/
│   ├── formatter.ts      # Platform-aware markup (WhatsApp vs Telegram)
│   ├── stt.ts            # Voice → text (Groq / OpenAI / local whisper.cpp)
│   ├── vision.ts         # Image → structured data (receipt parsing)
│   └── url.ts            # URL metadata fetcher (title, description, OG tags)
└── index.ts              # Entry point: load → register channels → start → shutdown
```

---

## Why CluClaw?

**vs Splitwise** — Splitwise makes you open an app, tap 6 buttons, and fill a form for every expense. CluClaw extracts expenses from conversation you're already having. Zero friction.

**vs ChatGPT/Claude** — General AI is 1-to-1. It can't observe a group, can't track state across messages from multiple people, and forgets everything when you close the tab. CluClaw is group-native with persistent memory.

**vs OpenClaw** — OpenClaw is a personal AI agent (1-to-1). CluClaw is a group AI agent (many-to-one). Different problem, complementary tools.

**vs WhatsApp bots** — Most bots need @mentions and structured commands. CluClaw understands natural, messy, unstructured human conversation. "Beers on me 🍺 ₹900" just works.

---

## Contributing

CluClaw is open source and community-driven. We welcome:

- **New skills** — Build something useful for groups
- **Channel adapters** — Discord, Slack, Signal, Matrix
- **Bug reports** — [Open an issue](https://github.com/Vi-Shock/cluclaw/issues)
- **Documentation** — Help others get started

```bash
git clone https://github.com/Vi-Shock/cluclaw.git
cd cluclaw
npm install
cp .env.example .env
npm run dev
```

---

<p align="center">
  <strong>CluClaw</strong> — finds the clues, for the kulu. 🕵️‍♂️
  <br/>
  <sub>Built with ❤️ by <a href="https://github.com/Vi-Shock">Vishak</a> and the community</sub>
</p>
