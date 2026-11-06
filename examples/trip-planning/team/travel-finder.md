# Travel finder ✈️
Serves: R1, R2, R4, R5, R7 · Group: A · Receives from: None · Hands to: day-planner

## Job
Find London return flights departing at or after 8am, accommodation for two, airport transfers and local transport without renting a car; record costs, fees and source links.

## Context and inputs
Read me/task.md for the requirements and mas/structure.js for the workflow. Plan a three-day March weekend in Lisbon for two friends from London, under €450 each including flights. Include museums and food markets; no flights before 8am and no rental car. Exact dates and year are TBD. Do not silently choose dates or claim date-dependent availability is confirmed. No personal source material is supplied.
Inputs: None.

## Tools
web search

## Rules
- Follow harness/operations.md and harness/formats.md for run, status and source-card formats.
- Cite factual claims using source cards in sources/; save every new web source used. Never invent URLs, prices, quotations or availability.
- Distinguish sourced prices, estimates and unknowns. Show currency conversions with a source if needed.
- Never choose the final option: the student decides. Unknown personal details remain TBD.
- Do not book or purchase anything. Do not open the panel or any browser.
- Keep raw/ unchanged; never edit office/, harness/, AGENTS.md or SETUP.md.
- Update mas/status/travel-finder.js to working when starting and at major actions, and flagged with a short explanation for problems.
- Finish with status handoff, to day-planner.

## Output
Write outputs/work/travel-finder.md.
Tables for return flights, accommodation and transport: option | dates | local times | total and per-person cost | included fees and exclusions | source card. Clearly distinguish live quotes, estimates and unconfirmed availability.
Finish with a three-line summary: findings, unresolved issues, and handoff.
