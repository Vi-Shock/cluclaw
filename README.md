<p align="center">
  <img src="assets/cluclaw-logo.png" alt="CluClaw" width="200" />
</p>

<h1 align="center">CluClaw</h1>

<p align="center">
  <strong>The AI that silently manages your group chats.</strong><br/>
  WhatsApp · Telegram · Open Source · Self-Hosted · Skill-Based
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-it-works">How it Works</a> ·
  <a href="#skills">Skills</a> ·
  <a href="#build-a-skill">Build a Skill</a> ·
  <a href="https://discord.gg/cluclaw">Discord</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/cluclaw/cluclaw?style=social" />
  <img src="https://img.shields.io/github/license/cluclaw/cluclaw" />
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
┌─────────────────────────────────┐
│  🧾 Goa Trip — 4 expenses       │
│  Total: ₹23,600                 │
│                                 │
│  Settlements:                   │
│  → Ravi owes Vishak ₹3,100     │
│  → Priya owes Vishak ₹3,400    │
│  → Deepa owes Vishak ₹2,950    │
│                                 │
│  Type "details" for breakdown   │
└─────────────────────────────────┘
```

**No one opened Splitwise. No one manually entered an expense. CluClaw just knew.**

---

<a id="quickstart"></a>
## Quickstart

```bash
# Install
npx cluclaw@latest init

# Follow the setup wizard:
# 1. Choose your LLM provider (OpenAI, Anthropic, Groq, Ollama, etc.)
# 2. Connect WhatsApp (scan QR) and/or Telegram (paste bot token)
# 3. Add CluClaw to a group chat
# 4. Start talking. That's it.
```

Or with Docker:
```bash
git clone https://github.com/cluclaw/cluclaw.git
cd cluclaw
cp .env.example .env      # configure your LLM provider
docker compose up
```

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
2. **LLM extraction** — Only triggered for likely matches. Any provider works: GPT-4o-mini, Claude, Groq, Ollama. Returns structured JSON.

---

<a id="skills"></a>
## Skills

CluClaw is a **platform**, not just an expense tracker. Skills are modular, community-contributed plugins.

| Skill | Status | What it does |
|---|---|---|
| 💰 **Expense Split** | ✅ Shipped | Passively tracks who paid what. Calculates settlements. |
| ✅ **Action Tracker** | 🔜 Next | Extracts commitments from chat. Reminds before deadlines. |
| 📊 **Poll / Vote** | 🔜 Planned | Creates polls from conversation. Tallies votes. |
| 🗺️ **Trip Planner** | 🔜 Planned | Builds itinerary from scattered messages, links, photos. |
| 🧠 **Group Memory** | 🔜 Planned | "What did we decide about the venue?" — answers from history. |
| 📋 **RSVP Tracker** | 🔜 Planned | Collects availability, finds overlap, suggests best time. |
| 🔖 **Content Curator** | 🔜 Planned | Saves and organizes all links/files shared in the group. |
| 📝 **Standup Bot** | 🔜 Planned | Scheduled check-ins. Collects updates. Posts daily digest. |

**Want a skill that doesn't exist?** [Build one](#build-a-skill) or [request it](https://github.com/cluclaw/cluclaw/issues/new).

---

## LLM Agnostic — Bring Your Own Model

CluClaw does **not** lock you into any AI provider. Configure any LLM:

| Provider | Model | Cost | Setup |
|---|---|---|---|
| **Groq** | Llama 3.3 70B | Free tier available | `LLM_PROVIDER=groq` |
| **Ollama** | Any local model | Free (runs on your hardware) | `LLM_PROVIDER=ollama` |
| **OpenAI** | GPT-4o-mini | ~$0.15/1M tokens | `LLM_PROVIDER=openai` |
| **Anthropic** | Claude Sonnet | ~$3/1M tokens | `LLM_PROVIDER=anthropic` |
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
- **You own your data** — Plain SQLite files. Export, delete, or migrate anytime.
- **Open source** — Audit every line. MIT licensed.

---

<a id="build-a-skill"></a>
## Build a Skill

Skills are simple TypeScript modules. Here's the skeleton:

```typescript
// skills/my-skill/index.ts
import type { Skill, GroupMessage, GroupContext } from '../../types';

export default {
  name: 'my-skill',
  description: 'Does something useful for the group',

  // Fast check — regex only, no LLM. Called for EVERY message.
  shouldActivate(message: GroupMessage): boolean {
    return /keyword|pattern/i.test(message.content.text ?? '');
  },

  // Process the message. Call LLM here if needed.
  async handle(message: GroupMessage, context: GroupContext) {
    const data = await context.llm.extractStructured(
      `Extract X from: "${message.content.text}"`,
      myZodSchema
    );
    // Store in SQLite, return response or null (stay silent)
    return { text: `Got it: ${data.summary}` };
  },

  // Explicit commands users can type
  commands: {
    'my-command': async (args, context) => {
      return { text: 'Here is what I found...' };
    }
  }
} satisfies Skill;
```

Every skill gets:
- `context.llm` — Provider-agnostic LLM calls
- `context.members` — Who's in the group
- `context.history` — Recent messages
- `context.getSkillState() / setSkillState()` — Persistent state
- `context.scheduler` — Schedule future messages (reminders, recurring tasks)
- `context.searchHistory(query)` — Full-text search over past messages

```bash
# Install a community skill
cluclaw skill install @cluclaw/action-tracker

# List installed skills
cluclaw skill list

# Create a new skill from template
cluclaw skill create my-awesome-skill
```

---

## Roadmap

- [x] Core agent with skill system
- [x] WhatsApp support (Baileys)
- [x] Telegram support (grammY)
- [x] LLM-agnostic provider system
- [x] Expense Split skill
- [ ] Voice note support (STT)
- [ ] Receipt photo scanning (Vision)
- [ ] Skill registry / marketplace
- [ ] Action Tracker skill
- [ ] Poll / Vote skill
- [ ] Web dashboard
- [ ] Multi-currency support
- [ ] UPI settlement links

---

## Why CluClaw?

**vs Splitwise** — Splitwise makes you open an app, tap 6 buttons, and fill a form for every expense. CluClaw extracts expenses from conversation you're already having. Zero friction.

**vs ChatGPT/Claude** — General AI is 1-to-1. It can't observe a group, can't track state across messages from multiple people, and forgets everything when you close the tab. CluClaw is group-native with persistent memory.

**vs OpenClaw** — OpenClaw is a personal AI agent (1-to-1). CluClaw is a group AI agent (many-to-one). Different problem, complementary tools. CluClaw can even run as an OpenClaw skill.

**vs WhatsApp bots** — Most bots need @mentions and structured commands. CluClaw understands natural, messy, unstructured human conversation. "Beers on me 🍺 ₹900" just works.

---

## Contributing

CluClaw is open source and community-driven. We welcome:

- **New skills** — Build something useful for groups. [Skill development guide](docs/SKILLS.md)
- **Channel adapters** — Discord, Slack, Signal, Matrix. [Channel guide](docs/CHANNELS.md)
- **Bug reports** — [Open an issue](https://github.com/cluclaw/cluclaw/issues)
- **Documentation** — Help others get started

```bash
git clone https://github.com/cluclaw/cluclaw.git
cd cluclaw
npm install
cp .env.example .env
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Star History

If CluClaw is useful, **star the repo** — it helps others discover it.

[![Star History Chart](https://api.star-history.com/svg?repos=cluclaw/cluclaw&type=Date)](https://star-history.com/#cluclaw/cluclaw&Date)

---

<p align="center">
  <strong>CluClaw</strong> — finds the clues, for the kulu. 🕵️‍♂️
  <br/>
  <sub>Built with ❤️ by <a href="https://github.com/vishak">Vishak</a> and the community</sub>
</p>
