# 3-day weekend trip to Lisbon — Lead

- version: 1
- locked: true
- job: Write the checked itinerary, costs, sources and unresolved issues, leaving final choices to the student.
- serves: R1, R6, R7

## Rationale
Two finders use different sources and research sights and travel in parallel. A day planner combines their findings, then an independent checker checks costs and timing. The Lead writes the checked result and leaves choices to the student. Four specialist roles keep research, planning and checking distinct; more roles would add context and coordination costs. Exact March dates and year remain TBD; date-dependent prices and availability must remain unconfirmed until those are known.

## Workflow
Group A runs in parallel. Group B waits for A; group C waits for B. The Lead writes the final result after C.

## 🏛️ Sights finder
- id: sights-finder
- serves: R3, R7
- why: Different sources: attraction and market research can run alongside travel research.
- job: Find museums and food markets with opening times, costs, locations and source links.
- tools: web search
- group: A
- hands to: day-planner

## ✈️ Travel finder
- id: travel-finder
- serves: R1, R2, R4, R5, R7
- why: Different sources: flights, accommodation and transport can be researched alongside sights.
- job: Find London return flights departing at or after 8am, accommodation for two, airport transfers and local transport without renting a car; record costs, fees and source links.
- tools: web search
- group: A
- hands to: day-planner

## 🗓️ Day planner
- id: day-planner
- serves: R1, R2, R3, R4, R5, R6, R7
- why: Needs combining: the daily schedule depends on both sights and travel findings.
- job: Combine both finders' results into a three-day timed itinerary with travel time, museums, markets, meals and complete per-person costs linked to sources.
- tools: web search
- group: B
- hands to: budget-clash-checker

## 🧮 Budget and clash checker
- id: budget-clash-checker
- serves: R1, R2, R3, R4, R5, R6, R7
- why: Needs an independent check: omitted costs or timing clashes could make the trip unworkable.
- job: Independently verify that each person's complete trip total is under €450 including return flights, accommodation, meals, attractions, transfers, local transport and fees. Show the sum for each person and flag any total of €450 or more or any unknown cost; never describe an unverified total as within budget. Also check opening times, connections, flight times and source evidence.
- tools: web search
- group: C
- hands to: lead
