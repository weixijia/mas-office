# Operations

Each operation ends with the same things: write its files (and their `.js` twins), rewrite `mas/state.js`, update this MAS's entry in `home/projects.js` (`title`, `step`, `phase`, `agents`, `runs`), and tell the student the one next thing to do. Formats are in `harness/formats.md`. Times are ISO 8601 UTC.

**Paths:** except for `setup` and `choose`, every path below is inside the **current MAS folder** named by `current` in `home/projects.js` — `me/task.md` means `<folder>/me/task.md`. `home/` is the only shared folder.

---

## setup

Goal: make this folder ready and tell the student what their tool can do. Runs once per folder; every MAS shares the result.

1. Note which assistant you are (Claude Code, Codex, Antigravity, …) and the operating system.
2. Write `home/env.md` (a few sentences) — this also proves you can write files. If writing fails, stop and explain how to allow file edits in this tool (see the table below).
3. Web search: try one tiny search (e.g. "UK weather today"). `canSearch` = whether it worked.
4. Subagents — **test, don't guess**: actually start one tiny subagent (instruction: "Reply with the single word ok") the way AGENTS.md → Running roles as agents describes. If it returns, `"parallel"`; if your tool has no way to start one or it fails, `"sequential"`. Say the result in your reply in the same words as the file — never claim parallel agents if the file says sequential.
5. Write `home/env.js`. If `home/projects.js` does not exist, write it with `"current": null` and an empty `projects` list. (Old layout: if this folder already has a top-level `me/task.md`, ask the student for a short name and move `me/`, `mas/`, `team/`, `sources/`, `outputs/` and `raw/` into that MAS folder before going on.)
6. Open the panel (AGENTS.md → Opening the panel).
7. Give tool tips only if needed:

| Tool | Tip |
|---|---|
| Claude Code / Claude app | If asked, choose to trust this folder; allow file edits and web search when prompted. |
| Codex | Web search works by default (cached). For live results start Codex with `--search`. If shell commands can't reach the internet, that's fine — only setup's download needs it. |
| Antigravity | Choose the mode that accepts file edits (e.g. `agy --mode accept-edits`), or approve edits when asked. |
| Other | Allow file edits in this folder and web search. |

8. Reply: one-line welcome, the 4 steps, that this folder can hold several MAS (one folder each), "Keep `office/index.html` open — it follows whichever MAS we work on", and "Type `next` to start your first MAS."

---

## choose  (start of every conversation · `new` · "switch to …")

Goal: agree with the student which MAS this conversation works on.

1. List this folder and read `home/projects.js`. A MAS folder is a folder that contains `me/` or `mas/` — ignore `home/`, `office/`, `harness/`, `examples/` and hidden folders. If a MAS folder is missing from `projects`, add it (title from its `me/task.js`, or the folder name); drop entries whose folder no longer exists.
2. Set `"current": null` in `home/projects.js` — the panel now shows the list of MAS while the student chooses.
3. Ask, one question:
   - **No MAS yet** (or the student typed `new`): "What should we call your new MAS? A few words are enough — e.g. *headphone deals*."
   - **Otherwise** (skip the question if the student already named one): "Start a new MAS, or continue one of these?" and list each as `folder — title — step` (e.g. `headphone-deals — Headphone deal finder — 4 Run, done`).
4. **New:** make a folder name from the student's words: lower-case letters, digits and hyphens, at most 40 characters, not an existing folder and not `home`, `office`, `harness` or `examples` (e.g. "Headphone deals!" → `headphone-deals`). Create `<folder>/raw/README.md` (one line: "Put your own files for this MAS here. Your assistant reads them but never changes them."). Write `<folder>/mas/state.js` (`step: 1`, `phase: "describe"`, `next: "Type next to describe your task."`). Add `{"folder": …, "title": <the student's words>, "step": 1, "phase": "describe"}` to `projects`.
   **Continue:** the folder the student picked.
5. Set `"current"` to that folder in `home/projects.js`.
6. Reply: `MAS: <folder>`, then one line on where it stands (read its `mas/state.js` → `next`) — or for a new MAS, "Type `next` to describe your task."

---

## describe  (step 1 · ingredient: memory)

1. Interview the student, **one question at a time**, waiting for each answer:
   1. What should your assistant help you do? *(Examples: compare prices before a purchase, plan a trip, check if a thesis idea is feasible, find a flat, plan meals, make a study plan, organise an event, prepare job applications — anything.)*
   2. What are your preferences and limits? *(budget, time, things to avoid…)*
   3. What does a good result look like? How will you judge it?
   4. Will you do this again? How often?
   5. Do you have your own material for it? *(If yes, put the files in `<folder>/raw/` — tell them the real folder name.)*
   If an answer is unclear, ask one short follow-up. Don't suggest a different task or add features.
2. Write `me/answers.md` as you go, then `me/task.md` and `me/task.js`:
   - title (short, in the student's words), one-line summary — also update `title` in `home/projects.js`;
   - **requirements R1…Rn**: 3–7 short, checkable lines drawn only from what the student said;
   - repeat.
3. `mas/state.js`: `step: 2`, `phase: "design"`, `next: "Type next and I'll design a team for this task."`
4. Reply: show the requirements. Then the **"a chat can't do this"** moment: "Try it: close this conversation, start a new one in this folder — I'll list your MAS and pick this one up from `me/task.md`. A web chat forgets when you close it." End with "Type `next` to design your team."

---

## design  (step 2 · ingredient: division of labour)

1. Read `me/task.md` and `harness/roles.md`.
2. Derive the team: Lead + roles, each with `serves`, `why`, `job`, `tools`, `group`, `handsTo`. Prefer the smallest team that serves every requirement well.
3. Write `mas/structure.md` and `mas/structure.js` (`version: 1`, `locked: false`, a one-paragraph `rationale`).
4. `mas/state.js`: `step: 3`, `phase: "refine"`, `version: 1`, `locked: false`, `next: "Tell me anything you want to change, then type next to lock your team."`
5. Reply as described in `harness/roles.md` → How to present a design.

---

## refine  (step 3)

Input: the student's change in plain words.

1. Apply the change to the structure (both files). Keep role ids stable; new ids are lower-case-with-hyphens.
2. Explain the effect in one or two lines: speed (what still runs in parallel), cost (agent count), coverage (requirements served). If a role now serves no requirement, or a requirement is no longer served, say so — but the student's choice stands.
3. If the student edited `mas/structure.md` by hand, apply the same change to `mas/structure.js` (or the other way round) and briefly confirm what the team now is.
4. `mas/state.js`: unchanged step/phase, update `updated` and `next`.

---

## lock  (step 3 → 4)

1. Show the final team (table) and ask "Lock this team?" — continue on yes. Ask only once: if the student just said yes to "Happy with your team? I'll lock it.", that counts — don't ask again.
2. Write `team/lead.md` and one `team/<role-id>.md` per role (format in `harness/formats.md`). Write them so a fresh agent can do the job from the file alone.
3. Set `"locked": true` in both structure files.
4. Write `mas/status/lead.js` and `mas/status/<role-id>.js` for every role with `state: "idle"`, `say: "Ready"` — one write per file with your file tool, not a shell loop.
5. `mas/state.js`: `step: 4`, `phase: "locked"`, `locked: true`, `next: "Type next to run your team."`
6. Reply: "Your team is locked — each role now has a desk in the office panel." Ask the student to open one file in `team/` and read it: "This file *is* the agent — its whole job description."

---

## run  (step 4 · ingredients: tools, division of labour, workflow)

The panel animates the office from the status files, so **status updates are part of the job, not optional**. Do steps 0–2 before starting any role.

0. If `outputs/result.md` already exists, copy it unchanged to `outputs/result-run<N>.md` (N = its run number) **before anything else**.
1. Read `me/task.md`, `mas/structure.js`, every file in `team/`, and `raw/` if any role uses `read my files`.
2. Rewrite **every** status file (one write per file with your file tool): each role `waiting` ("Waiting for my turn"); `lead.js` `working` ("Planning the run"). `mas/state.js`: `phase: "running"`, `next: "Watch the office panel — your team is working."`
3. For each group in order (A, then the group whose `after` is A, …): start every role in the group **at the same time** (AGENTS.md → Running roles as agents), giving each this **role brief**:

   > You are **<role name>** in a small multi-agent team. **Work only inside the folder `<folder>/`** — every path below is inside it (write `<folder>/mas/status/<role-id>.js`, not `mas/status/<role-id>.js`).
   > Your job description is in `team/<role-id>.md` — read it first and follow it exactly.
   > Read and write files with your file tools, one file per call — no shell commands, heredocs or scripts (they trigger approval prompts for the student), and never write outside `<folder>/`.
   > The task is in `me/task.md`. Your inputs: <list the files from roles that hand to you, or "none">.
   > While you work, keep `mas/status/<role-id>.js` updated (format in `harness/formats.md`) — the student is watching these live: `working` when you start, a new short `say` for each major action (e.g. "Searching Currys…"), and finally `handoff` with `"to": "<handsTo>"`. **Whenever you find a problem** (something that breaks a requirement, a doubtful source, a mistake in your input), set `flagged` with a short `flag` (e.g. "Refurbished — breaks R2"), then go back to `working`. Include a rough `progress` (0–100) in every update — the panel shows it as a progress bar under your name.
   > Save each web source you use as a card in `sources/` (format in `harness/formats.md`); never invent sources, prices or quotes.
   > Write your result to `outputs/work/<role-id>.md` and finish with a 3-line summary.

   Wait for the whole group to finish. In sequential mode, do the same yourself for each role in turn.
4. After each role finishes: make sure its status shows `handoff` to its `handsTo`, then set it to `done` ("Handed over"). Between groups, update `lead.js` (`working`, e.g. "Group A done — starting the checkers").
5. Lead: status `working` ("Writing the result"). Combine `outputs/work/*.md` into `outputs/result.md` — the answer to the task, every fact linked to its source card, problems the checkers found clearly marked, and a closing line that leaves the decision to the student. **Keep it short and readable for a non-specialist**: start with a 2–3 line answer, then at most one main table and a short "what the checkers caught" list (about one screen in total). Link to `outputs/work/<role-id>.md` for detail instead of copying it. Write `outputs/result.js` directly with your file tool, not with a script (`run` = previous run + 1), including `work`: one 3–5 line summary per role of what it found or decided (the panel shows it when the student clicks that agent). If an earlier `outputs/result.md` exists, first copy it to `outputs/result-run<N>.md`.
6. Lead status `done` ("Result ready"). `mas/state.js`: `phase: "done"`, `next: "Done! Change a condition in me/task.md and type run again — or type unlock to change your team."`
7. Reply: the headline result in 2–4 lines, a link to `outputs/result.md`, and the **"a chat can't do this"** moments the student just saw: agents working at the same time, a checker catching what a finder missed (if it happened), every claim linked to a source they can open, and that `run again` repeats the whole workflow in one line.

---

## unlock

1. Set `"locked": false` and add 1 to `version` in both structure files.
2. Set every status to `idle`.
3. `mas/state.js`: `step: 3`, `phase: "refine"`, `locked: false`, new `version`, `next: "Change your team, then type next to lock it again."`
4. Reply briefly. Existing `team/` files are rewritten at the next `lock`.
