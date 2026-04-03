# CluClaw Architecture Stress Test: 7 Future Skills

Testing whether the current architecture (GroupMessage → Skill interface → LLM-agnostic extraction → SQLite) holds up across diverse skill types. For each skill, we identify what it needs and where the current design works, bends, or breaks.

---

## Skill 2: Action Item Tracker

**What it does:** Extracts decisions, commitments, and deadlines from natural group conversation. "I'll book the hotel by Friday" → tracks it, reminds the group on Thursday if not done.

**Passive listening example:**
- "Ravi will handle the tickets" → Action: Ravi, task: tickets, deadline: none
- "Let's finalize the menu by Wednesday" → Action: group, task: finalize menu, deadline: Wednesday
- "I'll send the invite list tonight" → Action: sender, task: send invite list, deadline: today evening

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| Passive message parsing | ✅ Yes | Same shouldActivate → handle flow. Keywords: "I'll", "let's", "by Friday", "deadline" |
| LLM extraction to structured data | ✅ Yes | `extractStructured()` with a Zod schema for action items |
| Persistent storage (SQLite) | ✅ Yes | New table: `action_items (group_id, assignee, task, deadline, status)` |
| **Scheduled/timed triggers** | ❌ MISSING | Need to send reminders BEFORE a deadline. No cron/scheduler in current design. |
| Cross-referencing messages | ✅ Yes | GroupContext already has conversation history |

**Architecture gap found:** 🔴 **Scheduled tasks / cron system.** The current design is purely reactive (message in → response out). This skill needs the agent to INITIATE messages at specific times (reminders). We need a simple scheduler.

**Fix:** Add `src/core/scheduler.ts` — a lightweight cron/timer system that skills can register timed callbacks with:
```typescript
interface ScheduledTask {
  skillName: string;
  groupId: string;
  executeAt: Date;
  payload: any;
  callback: (context: GroupContext) => Promise<SkillResponse | null>;
}
```
Store scheduled tasks in SQLite. On agent startup, load pending tasks. Check every minute. This is simple and keeps everything in SQLite — no Redis or external queue needed.

---

## Skill 3: Poll / Voting

**What it does:** Creates quick polls from conversation. Someone says "where should we eat tonight?" and the agent creates a poll with options from the discussion.

**Interaction examples:**
- "Poll: where should we eat? Options: Bombay Brasserie, MTR, Toit" → creates structured poll
- Or passively: detects "where should we go?" followed by people suggesting places → asks "want me to create a poll with these options?"
- People vote by replying with option number or name
- Agent tallies and announces results

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| Explicit command activation | ✅ Yes | `commands: { "poll": handler }` in Skill interface |
| Passive detection of poll-worthy moments | ✅ Yes | shouldActivate detects question patterns |
| LLM extraction of options from conversation | ✅ Yes | `extractStructured()` with poll schema |
| **Tracking individual votes (reactions/replies)** | ⚠️ PARTIAL | Need to map reply messages back to an active poll. Current GroupMessage has `quotedMessage` which helps. But need state for "active polls." |
| **Rich message formatting** | ⚠️ PARTIAL | Polls look better with numbered lists, maybe emojis. WhatsApp and Telegram have different formatting capabilities. |
| Timed auto-close | ❌ NEEDS SCHEDULER | "Close poll in 2 hours" requires the scheduler from Skill 2 |

**Architecture gap found:** 🟡 **Skill-level persistent state machine.** The poll has states: OPEN → VOTING → CLOSED. The current design doesn't have a clean pattern for skills that maintain ongoing state across multiple messages. The expense skill is simpler — each expense is independent.

**Fix:** Extend `GroupContext` to support skill-specific state:
```typescript
interface GroupContext {
  groupId: string;
  members: Member[];
  history: GroupMessage[];  // recent messages
  skillState: Record<string, any>;  // per-skill persistent state, stored in SQLite
}
```
Skills can read/write their own state via `context.skillState['poll'] = { activePoll: {...} }`. Serialized to JSON in SQLite.

---

## Skill 4: Trip Planner / Itinerary Builder

**What it does:** Compiles a group trip itinerary from scattered conversation. Tracks: dates, destinations, accommodations, activities, transport — all from natural chat.

**Passive listening examples:**
- "Let's go to Coorg on the 15th" → destination: Coorg, date: 15th
- "Found a nice homestay for ₹3000/night" → accommodation option
- "We could do the Abbey Falls trek on day 2" → activity, day 2
- [sends a Google Maps link] → extracts location
- [sends a booking confirmation screenshot] → extracts booking details via vision

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| Passive message parsing | ✅ Yes | Keywords: dates, place names, "hotel", "flight", "trek" |
| LLM extraction | ✅ Yes | Extract trip components from messages |
| Vision (screenshots of bookings) | ✅ Yes | Provider-agnostic vision model already in design |
| **URL parsing / link preview** | ❌ MISSING | Google Maps links, Airbnb links, booking.com links. Need to fetch URL metadata. |
| **Multi-entity accumulation** | ⚠️ PARTIAL | Unlike expenses (independent), trip items build on each other. Need to accumulate and merge. The skill-state pattern from Skill 3 helps. |
| **Rich output (formatted itinerary)** | ⚠️ PARTIAL | Need multi-line, well-formatted message. Platform differences in formatting. |
| External API calls (maps, weather) | ❌ MISSING | Skills may want to call external APIs (weather for trip dates, distance calculations). |

**Architecture gaps found:**

🔴 **URL fetching / metadata extraction.** The current design has no way for a skill to fetch a URL and extract metadata (title, description, coordinates from Google Maps link, etc.).

**Fix:** Add `src/utils/url.ts` with a simple `fetchUrlMetadata(url)` function. Skills can use it when they detect URLs in messages.

🟡 **External API access pattern.** Trip planner might want weather APIs, maps APIs, etc. We need a clean pattern for skills to declare and use external service dependencies.

**Fix:** Skills can declare dependencies in their `SKILL.md` and import their own utility functions. The agent doesn't restrict what a skill can do — it's an open plugin model (like OpenClaw). This is fine for v1 — heavier sandboxing can come later.

---

## Skill 5: Group Memory / Q&A

**What it does:** Remembers everything discussed in the group and answers questions about past conversations. "When did we decide to change the venue?" → searches group history and answers.

**Interaction examples:**
- "What was the name of that restaurant Priya suggested?"
- "When did we decide on the budget?"
- "Summarize what we discussed yesterday"
- "What did Ravi say about the flight options?"

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| Command-based activation | ✅ Yes | Triggered by questions directed at the agent |
| **Full conversation history storage** | ⚠️ PARTIAL | Current design stores "recent messages" in GroupContext. This skill needs ALL messages, potentially months of history. |
| **Semantic search over history** | ❌ MISSING | "What did Ravi say about flights?" requires vector/semantic search, not just keyword match. |
| LLM-based answer generation | ✅ Yes | `extractStructured()` or plain `generateText()` from Vercel AI SDK |
| **Embedding generation** | ❌ MISSING | Need to embed messages for semantic search |

**Architecture gaps found:**

🔴 **Long-term message storage + semantic search.** The current SQLite-only design can store messages but can't do semantic search. This skill needs either:
- Option A: SQLite + full-text search (FTS5) — works for keyword search, not semantic
- Option B: SQLite + a lightweight vector extension (sqlite-vec)
- Option C: Optional integration with a vector DB (Qdrant, ChromaDB)

**Fix:** This is the most architecturally significant gap. Recommended approach:
1. Store ALL group messages in SQLite (this is cheap and fast)
2. For basic search: use SQLite FTS5 (built-in, zero dependencies)
3. For semantic search: make it optional via a `VECTOR_STORE` config. Default: none (use FTS5). Optional: sqlite-vec, Qdrant, ChromaDB. Skills that need semantic search call `searchMemory(query)` from a new `src/memory/search.ts` module.

This also directly connects to your Personal Memory Server interest — this search layer could eventually become a shared component.

---

## Skill 6: RSVP / Availability Coordinator

**What it does:** Collects availability from group members for an event or meeting. "When is everyone free next weekend?" → tracks responses, finds overlap, suggests best time.

**Interaction examples:**
- "RSVP: Are we doing the housewarming on Saturday?"
- Responses: "I'm in", "Can't make it", "Maybe, depends on work"
- "When can everyone meet? I'm free Tue/Thu after 5"
- Others reply with their availability → agent finds overlap

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| Command activation ("rsvp", "availability") | ✅ Yes | Standard command pattern |
| Tracking individual responses | ⚠️ PARTIAL | Same challenge as Poll skill — need to track who responded to what. Skill-state pattern handles this. |
| **Date/time understanding** | ⚠️ PARTIAL | "Next Saturday", "Tue/Thu after 5", "this weekend" — LLM handles this, but need timezone awareness. |
| **Multi-turn conversation tracking** | ⚠️ PARTIAL | Agent asks "when are you free?" → needs to track that it's waiting for responses from specific people. Skill-state pattern helps. |
| Reminder for non-respondents | ❌ NEEDS SCHEDULER | "Ping Ravi and Deepa — they haven't responded yet" |

**Architecture gap found:** 🟡 **Timezone handling.** Groups may have members across timezones. Need a way to configure group timezone or per-member timezone.

**Fix:** Add `timezone` field to group config (stored in SQLite). Default to `DEFAULT_TIMEZONE` env var (e.g., `Asia/Kolkata`). This is a minor addition to the config schema.

---

## Skill 7: Content Curator / Shared Bookmark

**What it does:** Automatically saves and organizes links, files, and media shared in the group. "Save this", or just passively collects all links. Anyone can ask "what links did we share about hotels?" and get a curated list.

**Interaction examples:**
- Someone shares a YouTube link → auto-tagged and stored
- Someone shares a PDF → stored with extracted title
- "Show me all the links we shared this week"
- "What articles did Priya share?"
- "Save this" (replying to a message) → bookmarks it

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| Passive link/file detection | ✅ Yes | shouldActivate checks for URLs, media attachments |
| URL metadata extraction | ❌ NEEDS URL UTIL | Same gap as Trip Planner — need fetchUrlMetadata() |
| **File/media storage** | ❌ MISSING | Current design doesn't handle storing media files (images, PDFs, voice notes) permanently. |
| Tagging/categorization via LLM | ✅ Yes | `extractStructured()` to categorize links |
| Search over bookmarks | ⚠️ PARTIAL | SQLite FTS5 works for keyword search on titles/descriptions. Semantic search optional. |

**Architecture gap found:** 🔴 **Media/file storage.** The current design only handles text in SQLite. This skill needs to store (or at least reference) media files.

**Fix:** Add a `media/` directory per group in the data folder. Store files there. In SQLite, store the file path + metadata. Don't try to put binary data in SQLite.

```
data/
├── {groupId}/
│   ├── database.db       # SQLite database
│   └── media/             # stored files
│       ├── img_001.jpg
│       └── doc_001.pdf
```

---

## Skill 8: Standup / Check-in Bot

**What it does:** Runs periodic check-ins for teams or accountability groups. Every morning at 9am: "What are you working on today?" Collects responses and posts a summary.

**Interaction examples:**
- 9:00 AM: Agent posts "Good morning! What's everyone working on today?"
- Members respond throughout the morning
- 12:00 PM: Agent posts a compiled summary of everyone's updates
- Tracks who hasn't responded, optionally nudges them

**What it needs from the architecture:**

| Need | Current design supports? | Notes |
|---|---|---|
| **Scheduled/timed messages (proactive)** | ❌ NEEDS SCHEDULER | Agent must initiate conversation at configured times |
| Collecting responses over a time window | ⚠️ PARTIAL | Skill-state pattern handles tracking who responded. But need "collection window" concept (open for 3 hours, then summarize). |
| LLM summarization | ✅ Yes | Summarize all responses into a digest |
| **Recurring schedules** | ❌ NEEDS SCHEDULER WITH RECURRENCE | "Every weekday at 9am" — scheduler needs cron-like recurrence, not just one-shot timers. |
| Per-skill configuration | ⚠️ PARTIAL | Each group might configure standup differently (time, days, questions). Need per-skill per-group config. |

**Architecture gap confirmed:** 🔴 **Scheduler with recurrence** is now critical. Two skills (Action Tracker, Standup) absolutely need it. The Poll and RSVP skills benefit from it. This must be in the core.

---

## Summary of Architecture Gaps

| Gap | Severity | Skills affected | Recommended fix |
|---|---|---|---|
| **Scheduler / cron system** | 🔴 Critical | Action Tracker, Poll, RSVP, Standup | Add `src/core/scheduler.ts` with SQLite-backed task queue. Support one-shot + recurring (cron syntax). Check every 60s. |
| **Skill-level persistent state** | 🟡 Important | Poll, RSVP, Trip Planner, Standup | Add `skillState: Record<string, any>` to GroupContext. JSON serialized in SQLite. |
| **URL metadata fetching** | 🟡 Important | Trip Planner, Content Curator | Add `src/utils/url.ts` with `fetchUrlMetadata(url)` |
| **Semantic search / embeddings** | 🟡 Important (optional) | Group Memory/Q&A | Add optional vector search in `src/memory/search.ts`. Default: SQLite FTS5. Optional: sqlite-vec or external vector DB. |
| **Media/file storage** | 🟡 Important | Content Curator | Add `media/` directory per group. SQLite stores metadata + file path. |
| **Timezone awareness** | 🟢 Minor | RSVP, Standup, Action Tracker | Add `timezone` to group config. Default from env var. |
| **Platform-specific formatting** | 🟢 Minor | All skills that output rich content | Add `src/utils/formatter.ts` that renders differently for WhatsApp vs Telegram (bold, lists, etc.) |

---

## Architecture Changes Needed in CLAUDE.md

Based on this analysis, the following should be added to the core design BEFORE building:

### 1. Scheduler (add to core)
```
src/core/scheduler.ts
```
- SQLite-backed task queue
- One-shot tasks (remind at specific time)
- Recurring tasks (cron-style: "every weekday at 9am")
- Skills register tasks via: `scheduler.schedule({ skillName, groupId, executeAt, recurrence?, payload })`
- Agent main loop checks scheduler every 60 seconds
- On trigger: loads skill, calls a new `onScheduledTask(payload, context)` method on the Skill interface

### 2. Extended Skill Interface
```typescript
interface Skill {
  name: string;
  description: string;
  shouldActivate(message: GroupMessage): boolean;
  handle(message: GroupMessage, context: GroupContext): Promise<SkillResponse | null>;
  commands: Record<string, CommandHandler>;

  // NEW: handle scheduled/timed triggers
  onScheduledTask?(task: ScheduledTask, context: GroupContext): Promise<SkillResponse | null>;

  // NEW: skill-specific setup when added to a group
  onInstall?(context: GroupContext): Promise<void>;
}
```

### 3. Extended GroupContext
```typescript
interface GroupContext {
  groupId: string;
  platform: 'whatsapp' | 'telegram';
  members: Member[];
  history: GroupMessage[];       // recent messages (last N)
  timezone: string;              // group timezone
  getSkillState<T>(skillName: string): T | null;     // read skill state
  setSkillState<T>(skillName: string, state: T): void;  // write skill state
  scheduler: SchedulerInterface;  // schedule future tasks
}
```

### 4. Updated Project Structure
```
src/
├── core/
│   ├── agent.ts
│   ├── message-bus.ts
│   ├── skill-loader.ts
│   ├── llm.ts
│   ├── config.ts
│   └── scheduler.ts          ← NEW
├── channels/
│   ├── whatsapp.ts
│   └── telegram.ts
├── skills/
│   └── expense-split/
├── memory/
│   ├── store.ts
│   ├── group-context.ts
│   └── search.ts             ← NEW (FTS5 + optional vector search)
├── utils/
│   ├── stt.ts
│   ├── vision.ts
│   ├── url.ts                ← NEW
│   └── formatter.ts          ← NEW (platform-aware message formatting)
└── index.ts
```

### 5. Data Directory Structure
```
data/
├── agent.db                    # global: scheduled tasks, skill registry
├── {groupId}/
│   ├── database.db             # group-specific: expenses, action items, polls, etc.
│   └── media/                  # stored files, images, documents
```

---

## Verdict

**The current architecture is 80% right.** The core pattern (message bus → skill router → LLM extraction → SQLite) is solid and works for all 7 skills. The four additions needed (scheduler, skill state, URL util, optional vector search) are all clean extensions that don't require rethinking the core. No fundamental redesign needed.

The most critical addition is the **scheduler** — without it, 4 out of 7 future skills are either impossible or severely limited. It should be in the core from day one, even if the expense skill doesn't use it yet.
