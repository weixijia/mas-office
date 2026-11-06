# How to design the team

You **recommend** a team; the student **decides**. There is no hard limit on the number of roles — but every extra agent costs tokens and time, so explain the trade-off.

## When to create a separate role

Split work into a new role **only if at least one** of these is true, and name the reason in the role's `why`:

| Reason | Question to ask | Example (price comparison) |
|---|---|---|
| **Different expertise or source** | Does this part need different knowledge or a different place to look? | Retail shops vs. second-hand marketplaces |
| **Can run in parallel** | Can it be done at the same time as other work, independently? | Two finders search different shops at once |
| **Needs an independent check** | Is a mistake here costly, so a second pair of eyes helps? | A checker hunting for refurbished stock and hidden fees |
| **Needs combining or writing up** | Must several results be merged into one product? | The Lead writes the shortlist |

If none applies, **don't split** — let an existing role (or the Lead) do it. One role = one job.

## Recommended size (a recommendation, not a limit)

- Most personal tasks: **Lead + 2–4 roles**, two levels (Lead → roles).
- A simple task may need only 1–2 roles. Say so: "This task is simple — one finder plus the Lead is enough."
- Cost: each agent reads and writes its own context, so tokens grow roughly with the number of agents: **N agents ≈ N× the tokens of one assistant** (rough guide). Anthropic reported its research multi-agent system used about 15× the tokens of a chat. More agents ≠ better.

## Requirements → roles

1. List the requirements `R1…Rn` from `me/task.md`.
2. For each requirement, ask: who **finds** the information, who **checks** it, who **plans** with it, who **writes** the final result?
3. Merge roles that would do the same job with the same sources.
4. Make sure every requirement is served by at least one role (or the Lead), and every role serves at least one requirement.
5. Group roles: independent roles share a group (they run together); roles that need others' output go in a later group.

## Role patterns (to explain, not a fixed menu)

| Pattern | Does | Price comparison | Trip planning | Thesis feasibility |
|---|---|---|---|---|
| Finder | gathers information | Retail finder | Sights finder | Literature finder |
| Checker | verifies, looks for problems | Catch checker | Clash checker | Feasibility critic |
| Planner | arranges options into a plan | — | Day planner | Timeline planner |
| Writer | turns results into the final product | (Lead) shortlist | Itinerary writer | (Lead) summary |

## Examples

**Weekend trip to Lisbon** (R1 under €400, R2 museums + food, R3 no early flights, R4 day-by-day plan)
- Group A (parallel): 🏛️ Sights finder (R2) · ✈️ Travel finder (R1, R3)
- Group B: 🗓️ Day planner (R4) — needs both finders' results
- Group C: 🧮 Budget checker (R1) — checks the plan's total
- Lead: writes the final itinerary

**Thesis: mmWave person identification** (R1 can it be built in 6 months, R2 what exists already, R3 privacy risks)
- Group A (parallel): 📚 Literature finder (R2) · 🔐 Privacy scout (R3)
- Group B: 🧪 Feasibility critic (R1) — uses both finders' results
- Lead: summary with open questions

## How to present a design

In chat, show a small table: role · serves · why · group. Then:
- "These run at the same time: …"
- "Cost: N agents ≈ N× the tokens of one assistant."
- "Change anything by telling me — the panel shows the updated team. When you're happy, type `next` to lock."
