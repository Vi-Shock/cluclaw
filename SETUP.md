# CluClaw — Setup Guide

## Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org)
- **An LLM API key** — Groq (free), OpenAI, Anthropic, or Google
- **A Telegram bot token** — from [@BotFather](https://t.me/BotFather)
- **A WhatsApp number** (optional) — a spare/dedicated number is strongly recommended

---

## Step 1 — Clone and Install

```bash
git clone https://github.com/Vi-Shock/cluclaw.git
cd cluclaw
npm install
```

---

## Step 2 — Configure Environment

Copy the example env file:

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
# Required — your bot's display name in group chats
BOT_NAME=CluClaw

# ── Telegram ──────────────────────────────────────────────
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=         # paste your token from @BotFather

# ── LLM (pick one provider) ───────────────────────────────
LLM_PROVIDER=groq           # groq | openai | anthropic | google | ollama
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=                # your API key

# ── WhatsApp (optional — see Step 5) ──────────────────────
WHATSAPP_ENABLED=false

# ── General ───────────────────────────────────────────────
DEFAULT_CURRENCY=INR        # change to USD, EUR, etc. if needed
DEFAULT_TIMEZONE=Asia/Kolkata
```

### LLM Provider Quick Reference

| Provider | `LLM_PROVIDER` | `LLM_MODEL` | Get API Key |
|---|---|---|---|
| Groq (free tier) | `groq` | `llama-3.3-70b-versatile` | [console.groq.com](https://console.groq.com) |
| OpenAI | `openai` | `gpt-4o-mini` | [platform.openai.com](https://platform.openai.com) |
| Anthropic | `anthropic` | `claude-3-5-haiku-20241022` | [console.anthropic.com](https://console.anthropic.com) |
| Google | `google` | `gemini-1.5-flash` | [aistudio.google.com](https://aistudio.google.com) |
| Ollama (local/free) | `ollama` | `llama3.2` | [ollama.com](https://ollama.com) — no key needed |

---

## Step 3 — Create a Telegram Bot

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**
2. Send `/newbot`
3. Choose a name (e.g. `CluClaw`) and a username (e.g. `cluclaw_bot`)
4. Copy the token and paste it into `.env` as `TELEGRAM_BOT_TOKEN`

### Disable Privacy Mode (Required for passive listening)

By default, Telegram bots only see `/commands`. You must disable this:

1. Message **[@BotFather](https://t.me/BotFather)**
2. Send `/mybots` → select your bot
3. Go to **Bot Settings → Group Privacy → Turn off**

> Without this, the bot will only respond to `/splits` and explicit commands — it won't passively track expenses from natural conversation.

---

## Step 4 — Start the Bot

```bash
# Development (hot reload on file changes)
npm run dev

# Production
npm run build
npm start
```

You should see:
```
2026-04-03T... [INFO ] Starting CluClaw...
2026-04-03T... [INFO ] Loaded 1 skill(s): expense-split
2026-04-03T... [INFO ] Telegram bot @cluclaw_bot started
2026-04-03T... [INFO ] CluClaw is running!
```

---

## Step 5 — Add the Bot to a Group

1. Open Telegram and create a group (or use an existing one)
2. Add your bot (`@cluclaw_bot`) as a member
3. The bot will send a welcome message automatically

That's it — start chatting and tracking expenses!

---

## Step 6 — Test It

Send these messages in the group to verify everything works:

```
Paid ₹2400 for the Airbnb
```
*(bot stays silent — expense recorded)*

```
splits
```
*(bot replies with balance summary)*

```
details
```
*(bot replies with full expense list)*

```
help
```
*(bot shows all available commands)*

---

## Step 7 — WhatsApp (Optional)

> ⚠️ **Warning:** WhatsApp uses an unofficial API. Use a **dedicated phone number**, not your primary one.

1. Set `WHATSAPP_ENABLED=true` in `.env`
2. Start the bot: `npm run dev`
3. A QR code will appear in the terminal
4. Open WhatsApp on your phone → **Linked Devices → Link a Device**
5. Scan the QR code
6. Add the WhatsApp number to a group and start chatting

Auth state is saved in `data/whatsapp-auth/` — you won't need to scan again on restart.

---

## Step 8 — Voice Notes & Receipt Photos (Optional)

### Voice Notes (STT)

Add to `.env`:
```env
STT_PROVIDER=groq           # groq | openai | local
STT_MODEL=whisper-large-v3
STT_API_KEY=                # defaults to LLM_API_KEY if same provider
```

Send a voice note saying *"paid three hundred for petrol"* — it will be transcribed and parsed as an expense automatically.

### Receipt Photos (Vision)

Your LLM model must support vision. Add to `.env`:
```env
VISION_PROVIDER=openai      # must support vision: openai | anthropic | google
VISION_MODEL=gpt-4o
VISION_API_KEY=             # defaults to LLM_API_KEY
```

Send a photo of a restaurant bill — the total will be extracted and recorded as an expense.

---

## Verify Setup

Run the built-in tests to confirm the core logic works:

```bash
npm test
```

Expected output:
```
✔ should detect expense: "Paid ₹2400 for the Airbnb"
✔ should detect expense: "Maine 200 diye petrol ke liye"
✔ should NOT detect expense: "I have 500 reasons to be happy 😄"
...
✔ should simplify A→B and B→C to A→C
✔ should compute balances correctly for a simple 3-way expense
```

---

## Data Storage

All data is stored locally in the `data/` directory:

```
data/
├── agent.db              # global: scheduled tasks, skill registry
├── {groupId}/
│   ├── database.db       # expenses, members, message history, balances
│   └── media/            # downloaded photos and voice notes
└── whatsapp-auth/        # WhatsApp session (if enabled)
```

To reset a group's expense history, delete `data/{groupId}/database.db`.

---

## Troubleshooting

**Bot doesn't respond to "splits"**
- Ensure privacy mode is OFF in BotFather (Step 3)
- Check the terminal for errors

**LLM errors / expenses not being parsed**
- Verify `LLM_API_KEY` is correct
- Try a simpler message: "paid ₹100 for chai"
- Check `LOG_LEVEL=debug` in `.env` for detailed output

**WhatsApp disconnects frequently**
- Use a stable internet connection
- Don't use your primary number — WhatsApp may restrict unofficial clients

**"No channels enabled" error**
- At least one of `TELEGRAM_ENABLED=true` or `WHATSAPP_ENABLED=true` must be set

---

## Commands Reference

| Command | Description |
|---|---|
| `splits` / `balances` | Show simplified who-owes-whom |
| `details` / `expenses` | List all recorded expenses |
| `remove last` / `undo` | Delete the most recent expense |
| `settle <name> <amount>` | Record a payment (e.g. `settle Ravi 500`) |
| `help` | Show this command list |

All commands also work with a `/` prefix: `/splits`, `/details`, etc.
