# Companion Agent Standard — v1.0
## Gold Standard for Health/Wellness Companion Agents
**Version:** 1.0 | **Date:** March 25, 2026 | **Derived from:** Forge (Tyler) fix — 167 messages of chat history reconciliation

---

## CONSUMER EXPERIENCE PRINCIPLES

These are non-negotiable. If the agent violates any of these, it's broken.

1. **The agent provides expertise.** It knows the science, the protocols, the mechanisms. It speaks with authority.
2. **The user adapts based on their own thinking.** The agent gives recommendations. The user decides what to follow. The agent respects that.
3. **The agent adapts to where the user is at.** Not where the plan says they should be. If the user skipped training, acknowledge it and move forward. Don't lecture.
4. **It stores information.** Every piece of data the user shares is captured and used. Nothing gets lost.
5. **It always keeps context.** Never ask about something the user already told you. Never contradict a previous agreement. Never repeat a full briefing the user has already received.
6. **It always flows intuitively.** Conversations feel natural, not robotic. The user should never feel like they're talking to a form.
7. **It never changes the plan without user input.** If the agent wants to modify calories, training, supplements — it proposes and waits for agreement. The plan is the user's, not the agent's.
8. **It doesn't over check-in or send multiple messages.** One message per scheduled slot. No dumping 3 messages at once. No walls of text.
9. **It's clear, simple, concise.** Short sentences. Actionable items. Easy to read on a phone in 60-90 seconds.
10. **It's always on track.** Every message references the actual plan and moves the user forward. No tangents, no motivational fluff without substance.

---

## REQUIRED FILE STRUCTURE

Every companion agent must have:

```
agents/<agent-name>/
├── AGENT.md              — Identity, personality, user profile, recovery model
├── knowledge.md          — Learned patterns over time (agent-maintained)
├── state/
│   ├── CURRENT_PLAN.md   — THE SOURCE OF TRUTH (see spec below)
│   └── CONTEXT.md        — Phase status, metrics, live updates
├── skills/               — Template protocols (REFERENCE ONLY — see rules below)
│   ├── nutrition-protocol.md
│   ├── training-protocol.md (or exercise-protocol.md)
│   └── [domain-specific].md
└── training/
    └── MASTERS.md        — Clinical frameworks and thought leader knowledge
```

---

## CURRENT_PLAN.md SPECIFICATION

This is the single most important file for any companion agent. It defines what the user is ACTUALLY doing right now.

### Required Sections:
1. **Phase & Status** — Current phase name, start date, day count, transition criteria
2. **Training Split** — Day-by-day schedule with specific exercises, sets, reps, weights (or equivalent for non-fitness agents)
3. **Nutrition Plan** — Exact meals, calories, macros, specific foods agreed with user
4. **Supplement Stack** — Every supplement with exact dosing and timing (AM/PM/with meals)
5. **Active Constraints** — Everything the agent must respect: medical conditions, eliminations, equipment limitations, time restrictions, known-broken devices/trackers
6. **Substance/Behavioral Tracking** — Where applicable (sobriety counters, habit targets)
7. **Medical Flags** — Anything requiring professional follow-up, current medications
8. **What's NOT Started Yet** — Items discussed but not yet actioned (e.g., blood work, new supplements not yet purchased)

### Format Rules:
- Plain markdown, no tables
- Bullet points with specific numbers (not ranges where possible)
- Each section clearly headed
- Total file size should be 3000-6000 chars (enough for full context, not so much it overwhelms)

### Maintenance Rules:
- **Auto-evolve** updates this file after every manual conversation where the plan changes
- **Skills files are TEMPLATES** — they provide the reference framework. CURRENT_PLAN.md is what the user is actually doing.
- If a user agrees to a change in conversation, it goes into CURRENT_PLAN.md immediately
- If a user rejects a suggestion, that rejection is respected — the plan doesn't change
- The agent NEVER silently reverts to skills-file defaults

---

## AUTO-EVOLVE RULES

The `_auto_evolve_plan()` function runs after every manual message from a companion agent user.

### How it works:
1. **Detection:** Sends the conversation + current plan to the model. Asks: "Did anything change?"
2. **Rewrite:** If changes detected, rewrites CURRENT_PLAN.md with all changes incorporated
3. **Truncation limit:** Detection prompt sees `current_plan[:6000]` — must be large enough to include ALL sections

### What triggers a rewrite:
- User agrees to a new meal, exercise, supplement, or schedule change
- User reports a medical update (new condition, cleared by doctor, etc.)
- User confirms or denies they did something (e.g., "I didn't actually do the RDL")
- Agent and user agree to modify calorie targets, macro splits, or training intensity

### What does NOT trigger a rewrite:
- User asks a question without changing anything
- Agent gives education/explanation without proposing changes
- General conversation that doesn't affect the plan

---

## BRAIN LOADING ORDER

When `load_agent_brain()` runs, files are loaded in this order:

1. Date context (current date, day of week)
2. AGENT.md (identity + full user profile)
3. knowledge.md (learned patterns)
4. **CURRENT_PLAN.md** ← Loaded HERE, ABOVE skills
5. Session diary (last 7 days of logs)
6. training/MASTERS.md (clinical frameworks)
7. playbooks/
8. skills/ (template protocols)
9. intelligence/
10. state/CONTEXT.md (phase status, metrics)
11. decisions/
12. User memory (permanent facts from user_memory.db)

**Why CURRENT_PLAN.md loads above skills:** When the model sees conflicting information, it prioritises what it read first. By loading the actual plan before the template skills, the model naturally follows the plan over the templates.

---

## SCHEDULED TASK REQUIREMENTS

Every companion agent should have 3 daily check-ins:

### Morning Check-in (~7-8am)
- Greet by name, reference yesterday if diary data exists
- Ask about sleep (hours, quality)
- Today's plan FROM CURRENT_PLAN.md: training split, meals, supplements
- One teaching moment (rotate through MASTERS.md frameworks)
- One focus priority for the day
- Must say "CRITICAL: Read CURRENT_PLAN.md first" in the task prompt

### Midday Check-in (~12:30-1pm)
- Quick accountability pulse (3-4 questions max)
- Did you eat? Hit protein target?
- Energy level?
- Reminder of evening plans FROM CURRENT_PLAN.md
- Under 100 words total

### Evening Debrief (~6:30-7pm)
- PRIMARY data collection session
- Start open ("How was today?")
- Collect all relevant metrics
- Cross-check adherence against CURRENT_PLAN.md
- Reflect on 7-day patterns
- Name wins explicitly
- Preview tomorrow FROM CURRENT_PLAN.md training split
- Emit [STATE UPDATE:], [METRIC:], [INSIGHT:], [PATTERN:] markers

**Every task prompt must include:** "CRITICAL: Read CURRENT_PLAN.md first. It contains [user]'s ACTUAL plan. Use THAT, not the skills file templates."

---

## SKILLS vs PLAN

| | Skills Files | CURRENT_PLAN.md |
|---|---|---|
| **Purpose** | Reference material, templates, general principles | What the user is ACTUALLY doing right now |
| **Who maintains** | Developer (manual updates) | Auto-evolve system (after every conversation) |
| **Priority** | Lower — used only when CURRENT_PLAN.md doesn't exist yet | Higher — ALWAYS wins over skills if they conflict |
| **Header required** | YES — must say "TEMPLATE ONLY" at top | N/A |
| **Contains** | General exercise phases, generic meal templates, supplement rationale | Exact weights, specific meals, agreed timing, active medical constraints |

Every skills file must have this header:
```
> **TEMPLATE ONLY.** [User]'s ACTUAL current plan is in `state/CURRENT_PLAN.md`.
> If ANYTHING in this file conflicts with CURRENT_PLAN.md, ALWAYS follow CURRENT_PLAN.md.
> This file is reference material for general principles only.
```

---

## ANTI-PATTERNS (What Broke and Why)

### 1. Repeated full briefings
**What happened:** Agent gave the same full 5-paragraph introduction every morning because it had no persistent plan anchor.
**Fix:** CURRENT_PLAN.md exists. Morning check-in references it, not the skills files.

### 2. Contradicting previous agreements
**What happened:** Agent said calories were 2650, then 2100, then 2290 in three consecutive messages. Supplement dosing changed without user agreement.
**Fix:** CURRENT_PLAN.md is the single source of truth. Auto-evolve only updates when user agrees to changes.

### 3. Asking about known-broken devices
**What happened:** Agent kept asking for Fitbit HRV data when user told it the watch was broken.
**Fix:** Active Constraints section in CURRENT_PLAN.md — "Fitbit BROKEN, all readiness via self-report."

### 4. Dumping multiple messages at once
**What happened:** Deploy triggered catch-up of 3 missed cron tasks, sending morning + midday + evening messages simultaneously.
**Fix:** Catch-up logic should limit companion agents to 1 message. Also: init_state.sh must overwrite stale volume state.

### 5. Skills files overriding agreed plan
**What happened:** Skills file said 2500 cal. User and agent agreed to 2290. Next session reverted to 2500 because skills loaded after plan.
**Fix:** CURRENT_PLAN.md loads ABOVE skills in brain loading order. Skills headers say TEMPLATE ONLY.

---

## ONBOARDING FLOW

### First Contact
- Agent introduces itself with identity and approach
- Asks discovery questions (profile, goals, constraints, medical history)
- Does NOT create CURRENT_PLAN.md yet — needs enough data first

### Discovery (1-3 conversations)
- Collect baseline: current diet, exercise, supplements, sleep, medical conditions
- Understand user's communication style and preferences
- Establish what the user is already doing well (don't overhaul)

### Plan Creation
- After enough data: create CURRENT_PLAN.md with everything agreed
- Share the plan with the user for confirmation
- Once confirmed: this becomes the source of truth

### Steady State
- 3 daily check-ins from CURRENT_PLAN.md
- Auto-evolve keeps plan current after every conversation
- Agent never drifts from the plan unless user initiates a change

---

## CHAT_USER_MAP

Companion agents must be registered in `CHAT_USER_MAP` (orchestrator.py) to load the correct user's permanent memory:

```python
CHAT_USER_MAP = {
    "aether": "jackson",
    "apex": "tom",
    "forge": "tyler",
}
```

Without this mapping, the agent loads Tom's (default) memories instead of the user's — causing identity confusion.

---

## VERSION HISTORY

- **v1.0** (March 25, 2026) — Initial standard derived from Forge fix. Covers: file structure, CURRENT_PLAN.md spec, auto-evolve rules, brain loading order, scheduled tasks, skills vs plan hierarchy, anti-patterns, onboarding flow.
