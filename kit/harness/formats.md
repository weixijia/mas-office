# File formats

Every step writes two kinds of file:

- a **Markdown file** for people (and agents) to read and edit, and
- a **`.js` data file** that the panel (`office/index.html`) reads. The panel cannot read Markdown when opened by double-click, so keep the two in sync: whenever you change one, rewrite the other.

**Where files go:** `home/` is shared by the whole folder. Every other path in this file is inside the current MAS folder — `me/task.md` means e.g. `headphone-deals/me/task.md`.

All data files are plain JavaScript that assign one global. Write valid JSON inside the assignment (double quotes, no trailing commas, no comments). Write each file whole with your file tool; inside JSON strings write a newline as `\n` and a double quote as `\"`. Don't use a script to generate or check these files.

Times (`t`, `updated`, `setupAt`, …) are optional. Only write a time you actually know (e.g. shown by your environment or in a tool result you already have); never run a command just to get the time, and never guess one — leave the field out instead.

---

## `home/env.md` + `home/env.js` — written by `setup` (shared)

```js
window.MAS_ENV = {
  "tool": "Claude Code",            // the assistant you are: Claude Code, Codex, Antigravity, Gemini CLI, ...
  "os": "macOS",                    // macOS | Windows | Linux
  "canWrite": true,
  "canSearch": true,                // could you run a web search?
  "subagents": "parallel",          // parallel | sequential — tested in setup; the panel shows "Real agents" or "Role-play mode"
  "setupAt": "2026-11-05T14:00:00Z"
};
```

`home/env.md` says the same in sentences, plus any tip the student needs for their tool.

## `home/projects.js` — written by `setup`, `choose` and every operation (shared)

```js
window.MAS_HOME = {
  "current": "headphone-deals",     // folder of the MAS this conversation works on; null while the student is choosing
  "projects": [
    {"folder": "headphone-deals", "title": "Headphone deal finder", "step": 4, "phase": "done", "agents": 4, "runs": 1},
    {"folder": "lisbon-trip", "title": "3-day weekend in Lisbon", "step": 2, "phase": "design"}
  ]
};
```

- `folder`: lower-case letters, digits and hyphens (max 40), the MAS folder's name. Required.
- `title`, `step`, `phase`: copied from the MAS's `me/task.js` and `mas/state.js` whenever you write them.
- `agents`: number of agents including the Lead (once designed). `runs`: number of finished runs.
- The panel shows the MAS named by `current`; with `null` it shows this list.

## `mas/state.js` — rewritten at the end of every operation

```js
window.MAS_STATE = {
  "mode": "kit",                    // always "kit" here; SDK-driven projects write "sdk"
  "step": 1,                        // 0 not started · 1 describe · 2 design · 3 refine & lock · 4 run
  "phase": "describe",              // setup | describe | design | refine | locked | running | done
  "next": "Type next in your assistant to design your team.",   // one plain sentence: what the student does now
  "version": 1,                     // structure version
  "locked": false,
  "updated": "2026-11-05T14:05:00Z"
};
```

## `me/answers.md` — written by you during the interview

```markdown
# My answers
1. What should your assistant help you do?
<answer>
2. Your preferences and limits?
<answer>
3. What does a good result look like? How will you judge it?
<answer>
4. Will you do this again? How often?
<answer>
5. Any of your own material to use? (put files in raw/)
<answer>
```

An unanswered question is left as an empty line.

## `me/task.md` + `me/task.js` — written by `describe`

```markdown
# Headphone deal finder
## In my words
1. ... (the student's answers, verbatim)
## Requirements
- R1 Cheapest new price in the UK
- R2 New only (no refurbished), delivered within 3 days
- R3 A short buying shortlist I can act on
## Repeat
Monthly — I also need to buy a monitor later.
```

```js
window.MAS_TASK = {
  "title": "Headphone deal finder",
  "summary": "Find the best UK deal on noise-cancelling headphones under £300.",
  "requirements": [
    {"id": "R1", "text": "Cheapest new price in the UK"},
    {"id": "R2", "text": "New only (no refurbished), delivered within 3 days"},
    {"id": "R3", "text": "A short buying shortlist I can act on"}
  ],
  "repeat": "Monthly",
  "updated": "2026-11-05T14:05:00Z"
};
```

Requirement ids are `R1`, `R2`, … in order. Keep each requirement to one short line in the student's language.

## `mas/structure.md` + `mas/structure.js` — written by `design`, `refine`, `lock`

```markdown
# 🧭 Headphone deal finder — Lead
- job: Combine the checked offers into a buying shortlist
- serves: R3
## 🔎 New-price finder
- serves: R1
- job: Search major UK retailers for the lowest new price
- why: Different source from the marketplace finder; can run at the same time
- tools: web search
- group: A
- hands to: Catch checker
## 🛡️ Catch checker
- serves: R2
- job: Flag refurbished stock, parallel imports and hidden shipping
- why: Independent check: R2 mistakes are costly
- tools: web search
- group: B
- hands to: Lead
```

```js
window.MAS_STRUCTURE = {
  "title": "Headphone deal finder",
  "version": 1,
  "locked": false,
  "rationale": "Two finders search different shops at the same time (R1); a separate checker guards R2 because mistakes there are costly.",
  "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "Combine the checked offers into a buying shortlist", "serves": ["R3"]},
  "groups": [
    {"id": "A", "label": "Search in parallel", "after": null},
    {"id": "B", "label": "Check", "after": "A"}
  ],
  "roles": [
    {"id": "new-price-finder", "name": "New-price finder", "emoji": "🔎", "serves": ["R1"],
     "job": "Search major UK retailers for the lowest new price", "tools": ["web search"],
     "group": "A", "handsTo": "catch-checker", "why": "Different source from the marketplace finder; can run at the same time"},
    {"id": "catch-checker", "name": "Catch checker", "emoji": "🛡️", "serves": ["R2"],
     "job": "Flag refurbished stock, parallel imports and hidden shipping", "tools": ["web search"],
     "group": "B", "handsTo": "lead", "why": "Independent check: R2 mistakes are costly"}
  ]
};
```

Rules:
- `id` is lower-case-with-hyphens, unique, never `lead` (reserved for the Lead).
- `group` ids are `A`, `B`, `C`… Roles in the same group run **at the same time**; a group starts after the group named in `after` finishes. `after: null` = starts first.
- `handsTo` is another role id or `lead`; if it is missing, it means `lead`.
- `serves` lists requirement ids from `me/task.js`. Every role serves at least one.
- `tools` uses only: `web search`, `read my files` (reads `raw/`). No tools → `[]` in JS and `- tools: none` in Markdown.
- `why` is one short sentence naming the split reason (see `harness/roles.md`).
- On `lock`: set `"locked": true`. On `unlock`: set `"locked": false` and add 1 to `version`.
- `structure.js` is the complete record. Fields that `structure.md` does not show (`rationale`, group `label`/`after`, `version`, `locked`, ids) are kept from `structure.js` when you sync the Markdown back.

## `team/<role-id>.md` — written by `lock`, one per role (and `team/lead.md`)

```markdown
# Catch checker 🛡️
Serves: R2 · Group: B · Receives from: New-price finder, Marketplace finder · Hands to: Lead
## Job
Flag refurbished stock, parallel imports and hidden shipping costs in every offer you receive.
## Tools
web search
## Rules
- Cite a source for every claim; save each new source as a card in sources/.
- Never choose the final option — the student decides.
- Update mas/status/catch-checker.js when you start, at each major action, and when done.
## Output
A table: offer | issue | evidence | severity (low / medium / high).
```

## `mas/status/<role-id>.js` — written while running (one file per role, plus `lead.js`)

```js
window.MAS_STATUS = window.MAS_STATUS || {};
window.MAS_STATUS["catch-checker"] = {
  "state": "working",              // idle | waiting | working | handoff | flagged | done
  "say": "Checking eBay seller X…",  // max ~60 characters, plain words
  "to": null,                      // role id when state is handoff
  "flag": null,                    // short warning when state is flagged
  "progress": 40,                  // optional: this role's own rough completion 0–100 (write 100 when done), shown as a progress bar
  "t": "2026-11-05T14:21:03Z"
};
```

## `sources/<slug>.md` — one card per web source

```markdown
---
title: Sony WH-1000XM6 — Currys
url: https://www.currys.co.uk/...
accessed: 2026-11-05
evidence: A            # A can be bought/run · B study with data · C demo or marketing · D opinion
found by: new-price-finder
---
> "£279.00 · Free delivery in 2–3 days"   (verbatim from the page)

Relevance: R1 — lowest new price found at a major retailer.
```

## `outputs/work/<role-id>.md` — each role's own result during `run`

Free Markdown in the format the role's `team/` file asks for, linking source cards. The Lead combines these into the result.

## `outputs/result.md` + `outputs/result.js` — written by `run` and `follow-up`

`result.md` is the final answer for the student. Every factual claim links its source card.

```js
window.MAS_RESULT = {
  "title": "Headphone deal finder — run 1",
  "run": 1,
  "updated": "2026-11-05T14:30:00Z",
  "markdown": "## Shortlist\n| Shop | Total | Notes |\n|---|---|---|\n| Currys | £279 | new, 2–3 days |\n...",
  "sources": [
    {"id": "currys-xm6", "title": "Sony WH-1000XM6 — Currys", "url": "https://...", "evidence": "A", "foundBy": "new-price-finder"}
  ],
  "flags": [
    {"by": "catch-checker", "text": "eBay seller X lists a refurbished unit as 'new-like'"}
  ],
  "work": [
    {"by": "catch-checker", "summary": "Checked 6 offers. **eBay seller X** is refurbished (breaks R2). Currys and John Lewis are new with free delivery."}
  ]
};
```

After a follow-up, the result is the latest **round** of the same run and carries the earlier rounds:

```js
window.MAS_RESULT = {
  "title": "Headphone deal finder — run 1, follow-up 1",
  "run": 1,
  "round": 2,                       // 1 = the run's own result; 2, 3 … = answers to follow-ups
  "question": "Could you also check Argos?",   // the follow-up this round answers, in the student's words
  "markdown": "Follow-up: Could you also check Argos?\n\nArgos is £319 — above your £300 limit, so the shortlist stands. ...",
  "previous": [                     // earlier rounds of this run, oldest first, copied unchanged
    {"round": 1, "title": "Headphone deal finder — run 1", "markdown": "## Shortlist\n...", "updated": "2026-11-05T14:30:00Z"}
  ],
  "sources": [ ... every source of every round ... ],
  "flags": [ ... ],
  "work": [ ... ]
};
```

`markdown` (also in `previous`) and each `work` summary may use headings, lists, tables, bold and links only. `work` has one entry per role (an entry for `lead` is optional). A new `run` starts again at `round: 1` without `question` or `previous`; earlier rounds are kept in `outputs/rounds/run<N>-round<K>.md`, and each role's follow-up work in `outputs/work/<role-id>-round<K>.md`. Relative links in `result.md` and in `markdown` are relative to the `outputs/` folder (e.g. `../sources/currys-xm6.md`, `work/catch-checker.md`).
