# CluClaw — MVP Product Spec

## Vision

An open-source AI agent that lives inside group chats (WhatsApp + Telegram) and passively helps groups get things done. It listens to natural conversation, understands context, and performs useful tasks — without anyone needing to open a separate app or manually enter data.

**The first skill: Expense Splitting** — the agent passively tracks who paid what from natural conversation and settles balances on demand.

**The long-term play:** A skill-based platform where the community builds and contributes new group skills (trip planning, action tracking, polls, shared lists, etc.) — the "OpenClaw for group chats."

---

## What Makes This Different

| Existing tools | This agent |
|---|---|
| Splitwise: Open app → tap "Add expense" → fill amount, who paid, split type → save | Just talk in your group chat naturally. The AI extracts expenses silently. |
| ChatGPT/Claude: 1-to-1 only. Can't observe group dynamics. | Lives in the group. Sees everyone's messages. Understands group context. |
| OpenClaw: Personal AI agent (1-to-1) | Group-first AI agent (many-to-one). Solves coordination, not personal productivity. |
| WhatsApp bots: Require @mention + structured commands | Passive listening. Understands natural, messy, unstructured conversation. |

**Key insight:** Groups already communicate everything needed to coordinate — they just lack a silent, intelligent agent that can extract structure from that conversation.

---

## MVP Scope (Skill #1: Expense Splitting)

### User Journey

1. **Setup (30 seconds)**
   - Someone in a group runs the self-hosted agent (or uses a hosted version)
   - Links it to their WhatsApp/Telegram via QR code (Baileys) or bot token (Telegram)
   - Adds the agent to a group chat
   - Agent introduces itself: "Hey! I'll track expenses from your chat. Just talk normally — say 'splits' anytime to see balances."

2. **Passive Tracking (zero effort)**
   - Group members chat naturally during a trip/event:
     - "Paid ₹2400 for the Airbnb"
     - "Lunch was ₹1600, I got it"
     - "Ravi and I split a cab — ₹400"
     - "Beers on me tonight 🍺 ₹900"
     - [sends a photo of a restaurant bill]
     - [sends a voice note: "paid three hundred for petrol"]
   - Agent silently parses each message, extracts: amount, who paid, who it's split among
   - Agent does NOT respond to every message — it stays quiet unless:
     - It's unsure and needs clarification ("Was that ₹1600 split between everyone or just you and Priya?")
     - Someone explicitly asks it something

3. **On-Demand Summary**
   - Anyone types "splits" or "who owes what" or "settle up"
   - Agent responds with a clean settlement:
     ```
     🧾 Trip Expenses Summary
     Total: ₹5,300 across 8 expenses

     Settlements:
     → Ravi owes Vishak ₹850
     → Priya owes Vishak ₹650
     → Ravi owes Priya ₹200

     Type "details" to see all expenses
     ```

4. **Corrections**
   - "That dinner was actually ₹1800 not 1600" → agent updates
   - "Remove the last expense" → agent deletes
   - "Priya wasn't at lunch" → agent recalculates

### Message Parsing — What the AI Must Understand

| Natural message | Extracted data |
|---|---|
| "Paid ₹2400 for the Airbnb" | Payer: message sender. Amount: ₹2400. Split: everyone in group. Category: accommodation. |
| "Lunch was ₹1600, I got it" | Payer: message sender. Amount: ₹1600. Split: everyone. Category: food. |
| "Ravi and I split a cab — ₹400" | Payer: message sender. Amount: ₹400. Split: sender + Ravi only. Category: transport. |
| "Beers on me tonight 🍺 ₹900" | Payer: message sender. Amount: ₹900. Split: everyone. Category: drinks. |
| [photo of receipt] | OCR → extract total, optionally line items. Payer: sender. |
| [voice note: "paid three hundred for petrol"] | STT → parse amount (₹300) + category (petrol). Payer: sender. |
| "I paid for Ravi's ticket too, ₹500 each" | Payer: sender. Amount: ₹1000. Split: sender + Ravi. |

### When the Agent Should Speak vs Stay Silent

**Stay silent (default):**
- Regular group conversation
- Messages with no expense signals
- Messages it confidently parsed (log silently, confirm only if asked)

**Speak up (rare):**
- Ambiguous expense: "Was that split equally or just between you two?"
- Correction confirmation: "Updated: dinner is now ₹1800. Splits recalculated."
- When asked: "splits", "expenses", "who owes", "help", "details"
- Welcome message when first added to group

**Never:**
- Respond to every message (annoying)
- Volunteer information nobody asked for
- Participate in non-expense conversation

---

## Technical Architecture

### Stack

| Component | Choice | Reasoning |
|---|---|---|
| Runtime | Node.js / TypeScript | Baileys is TS-native. Claude Code's sweet spot. |
| WhatsApp | Baileys (@whiskeysockets/baileys) | Same lib OpenClaw uses. No business API needed. Free. |
| Telegram | grammY | Modern, TS-first Telegram bot framework. |
| AI/LLM | **Provider-agnostic** (Vercel AI SDK) | User configures any provider: OpenAI, Anthropic, Groq, Google, Ollama, etc. |
| Database | SQLite (via better-sqlite3) | Zero infra. Single file. Self-hostable. |
| Voice/STT | **Provider-agnostic** | Configurable: Groq Whisper, OpenAI Whisper, local whisper.cpp |
| OCR/Vision | **Provider-agnostic** | Any vision-capable model: Claude Vision, GPT-4o, Gemini, etc. |

### LLM Configuration (Provider-Agnostic)

The agent does NOT hardcode any specific LLM. Users configure their preferred provider via environment variables:

```env
# LLM for text parsing (expense extraction, intent detection)
LLM_PROVIDER=openai          # openai | anthropic | groq | google | ollama | mistral
LLM_MODEL=gpt-4o-mini        # any model supported by the provider
LLM_API_KEY=sk-...            # API key (not needed for Ollama)
LLM_BASE_URL=                 # optional: custom endpoint (required for Ollama/self-hosted)

# Vision model for receipt/photo parsing
VISION_PROVIDER=openai        # openai | anthropic | google (must support vision)
VISION_MODEL=gpt-4o           # any vision-capable model
VISION_API_KEY=               # falls back to LLM_API_KEY if not set

# Speech-to-text for voice notes
STT_PROVIDER=groq             # groq | openai | local
STT_MODEL=whisper-large-v3    # model name
STT_API_KEY=                  # falls back to LLM_API_KEY if not set
```

**Implementation:** Uses Vercel AI SDK (`ai` package) as the unified abstraction layer. One `callLLM()` function routes to whatever provider is configured. Skills never import provider-specific SDKs — they call `callLLM(prompt, schema)` and get structured JSON back.

```typescript
// src/core/llm.ts — unified LLM interface
import { generateObject } from 'ai';

export async function extractStructured<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  options?: { vision?: boolean; imageBase64?: string }
): Promise<T> {
  const provider = options?.vision ? getVisionProvider() : getLLMProvider();
  return generateObject({ model: provider, prompt, schema });
}
```

**Recommended defaults for different budgets:**

| Budget | LLM | Vision | STT |
|---|---|---|---|
| Free / local | Ollama (llama3.2) | Ollama (llava) | local whisper.cpp |
| Cheap (~$1/mo) | Groq (llama-3.3-70b) | Groq (llama-3.2-90b-vision) | Groq Whisper |
| Best accuracy | Anthropic (claude-sonnet) or OpenAI (gpt-4o-mini) | OpenAI (gpt-4o) | OpenAI Whisper |

### Project Structure

```
cluclaw/
├── src/
│   ├── core/
│   │   ├── agent.ts              # Main agent loop — receives messages, routes to skills
│   │   ├── message-bus.ts        # Unified message format across WhatsApp/Telegram
│   │   ├── skill-loader.ts       # Discovers and loads skills from /skills directory
│   │   └── llm.ts                # Provider-agnostic LLM interface (Vercel AI SDK)
│   ├── channels/
│   │   ├── whatsapp.ts           # Baileys connection, auth, message send/receive
│   │   └── telegram.ts           # grammY bot setup, message send/receive
│   ├── skills/
│   │   └── expense-split/
│   │       ├── SKILL.md           # Skill metadata + LLM instructions
│   │       ├── index.ts           # Skill entry point
│   │       ├── parser.ts          # LLM-based expense extraction from messages
│   │       ├── ledger.ts          # Expense storage + balance calculation
│   │       └── renderer.ts        # Format summaries for chat output
│   ├── memory/
│   │   ├── store.ts              # SQLite wrapper for persistent storage
│   │   └── group-context.ts      # Per-group memory (members, preferences, history)
│   └── utils/
│       ├── stt.ts                # Voice note → text (provider-agnostic)
│       └── vision.ts             # Receipt photo → structured data (provider-agnostic)
├── skills-registry/               # Future: community skill discovery
├── CLAUDE.md                      # Project spec for Claude Code
├── package.json
├── tsconfig.json
├── .env.example                   # All provider config with comments
└── docker-compose.yml             # Optional: one-command self-hosting
```

### Skill System Design (OpenClaw-inspired)

Each skill is a directory under `/skills/` containing:

```
skills/expense-split/
├── SKILL.md          # Human + LLM readable description
│                     # - What this skill does
│                     # - What messages it should activate on
│                     # - Example inputs/outputs
│                     # - LLM extraction prompt template
├── index.ts          # Exports: { name, shouldActivate, handle, commands }
└── ...               # Any additional files the skill needs
```

**Skill interface:**
```typescript
interface Skill {
  name: string;
  description: string;

  // Called for EVERY group message. Returns true if this skill
  // wants to process it. Should be fast (keyword/pattern check,
  // NOT an LLM call).
  shouldActivate(message: GroupMessage): boolean;

  // Process the message. Can be async (LLM calls happen here).
  // Returns null if nothing to say, or a response string.
  handle(message: GroupMessage, context: GroupContext): Promise<string | null>;

  // Explicit commands this skill responds to (e.g., "splits", "details")
  commands: Record<string, CommandHandler>;
}
```

**Message flow:**
```
Group Message arrives
    ↓
Channel adapter (WhatsApp/Telegram) normalizes to GroupMessage
    ↓
For each loaded skill:
    if skill.shouldActivate(message) → skill.handle(message, context)
    ↓
If skill returns a response → send to group
If skill returns null → stay silent
    ↓
If message matches a command → route to skill.commands[cmd]
```

### Expense Parser Design

The parser is the core innovation. It uses an LLM to extract structured data from messy natural language.

**Approach: Two-stage parsing**

1. **Fast filter (no LLM):** Regex/keyword check for currency symbols (₹, $, Rs), numbers, expense-related words (paid, spent, cost, split, owe). If no signals → skip entirely. This keeps costs near-zero for non-expense messages.

2. **LLM extraction (only for likely expenses):** Send the message + group context to the configured LLM via the unified `extractStructured()` function:

```
You are an expense parser for a group chat. Extract expense information from this message.

Group members: Vishak, Ravi, Priya, Deepa
Message from: Vishak
Message: "Lunch was ₹1600, I got it"

Return JSON:
{
  "is_expense": true,
  "amount": 1600,
  "currency": "INR",
  "payer": "Vishak",
  "split_among": ["Vishak", "Ravi", "Priya", "Deepa"],
  "split_type": "equal",
  "category": "food",
  "description": "Lunch",
  "confidence": 0.95,
  "needs_clarification": false
}

If confidence < 0.7 or ambiguous, set needs_clarification: true
and add clarification_question: "your question here"
```

### Database Schema (SQLite)

```sql
-- Groups the agent is active in
CREATE TABLE groups (
  id TEXT PRIMARY KEY,          -- WhatsApp/Telegram group ID
  platform TEXT NOT NULL,       -- 'whatsapp' | 'telegram'
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Group members
CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT REFERENCES groups(id),
  platform_user_id TEXT,        -- WhatsApp/Telegram user ID
  display_name TEXT,
  UNIQUE(group_id, platform_user_id)
);

-- Expenses (source of truth)
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT REFERENCES groups(id),
  payer_id INTEGER REFERENCES members(id),
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'INR',
  description TEXT,
  category TEXT,
  split_type TEXT DEFAULT 'equal',  -- 'equal' | 'exact' | 'percentage'
  source_message_id TEXT,           -- original message ID for reference
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME              -- soft delete
);

-- Who is part of each expense split
CREATE TABLE expense_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER REFERENCES expenses(id),
  member_id INTEGER REFERENCES members(id),
  share_amount REAL NOT NULL       -- calculated share for this person
);

-- Settlements / payments between members
CREATE TABLE settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT REFERENCES groups(id),
  from_member_id INTEGER REFERENCES members(id),
  to_member_id INTEGER REFERENCES members(id),
  amount REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Balance calculation:** Balances are computed on-the-fly from expenses + splits + settlements. No cached balance table — expenses are the source of truth (same approach as SplitPro).

---

## MVP Feature Checklist

### Must Have (Week 1-2)
- [ ] WhatsApp connection via Baileys (QR code auth)
- [ ] Telegram connection via grammY (bot token)
- [ ] Unified message bus (normalize both platforms to GroupMessage)
- [ ] Skill loader (discovers skills from /skills directory)
- [ ] Expense-split skill: fast filter (regex for ₹/$/numbers)
- [ ] Expense-split skill: LLM extraction (Claude API)
- [ ] SQLite storage for expenses
- [ ] Balance calculation + debt simplification
- [ ] Commands: "splits", "details", "help"
- [ ] Correction handling: "remove last", "change amount"
- [ ] Basic group member tracking

### Should Have (Week 3-4)
- [ ] Voice note support (Groq Whisper STT)
- [ ] Receipt photo parsing (Claude Vision OCR)
- [ ] Multi-currency support
- [ ] Expense categories + category summary
- [ ] "Remind" command — nudge specific people about balances
- [ ] Per-group persistent memory (remembers preferences across sessions)
- [ ] Confidence-based clarification ("Was that split equally?")

### Nice to Have (Month 2+)
- [ ] Skill registry CLI: `agent skill install <name>`
- [ ] Second skill: Action item tracker
- [ ] Third skill: Poll/voting
- [ ] Web dashboard for viewing expense history
- [ ] Export to CSV/PDF
- [ ] UPI deep link generation for settlements

---

## Skill Roadmap (Post-MVP)

| Skill | What it does | Activation signals |
|---|---|---|
| **Expense Split** (MVP) | Tracks who paid what, calculates balances | ₹, $, paid, spent, cost, split |
| **Action Tracker** | Extracts decisions and action items from conversation | "let's do", "I'll handle", "by Friday", "who's doing" |
| **Trip Planner** | Compiles itinerary from scattered chat messages | dates, places, "let's go to", "what about", hotel/flight mentions |
| **Poll / Vote** | Creates quick polls from conversation | "vote", "poll", "what does everyone think", "where should we" |
| **Shared List** | Maintains group lists (packing, shopping, etc.) | "add X to the list", "don't forget", "we need" |
| **Meeting Notes** | Summarizes long group discussions into key points | "summarize", "what did we decide", "tldr" |
| **Birthday/Event Remind** | Tracks and reminds about group members' events | dates, "birthday", "anniversary" |

---

## Open Source + Marketplace Strategy

### Phase 1: Open Core (Launch)
- Full source code on GitHub (MIT license)
- Core agent + expense-split skill included
- Self-hostable with `npx` or Docker
- Accept community PRs for new skills

### Phase 2: Skill Registry (Month 2-3)
- CLI: `agent skill install trip-planner`
- Skills hosted as npm packages or git repos
- README-based discovery (like awesome-lists)
- Community ratings/reviews

### Phase 3: Marketplace (Month 4+)
- Web-based skill discovery
- Verified/audited skills badge
- Optional hosted version (revenue model)
- Premium skills from third-party developers

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp bans account using Baileys | Use a dedicated phone number. Baileys is unofficial but OpenClaw uses it at massive scale. Follow rate limits. Don't spam. |
| LLM costs for parsing every message | Two-stage filter: regex first, LLM only for likely expenses. 90%+ messages skip LLM entirely. |
| False positive expense extraction | Confidence threshold. Ask for clarification when unsure. Easy correction commands. |
| Privacy concerns (bot reads all messages) | Self-hosted by default. Data stays on user's machine. Clear docs on what's stored. |
| Baileys breaking changes | Pin to stable version. OpenClaw community actively maintains Baileys compatibility. |

---

## Success Metrics

- **Demo video gets 1K+ views** on Twitter/X within first week
- **100+ GitHub stars** within first month
- **10+ active groups** using the expense skill
- **2+ community-contributed skills** within 3 months
- **Featured on Hacker News or Product Hunt**
