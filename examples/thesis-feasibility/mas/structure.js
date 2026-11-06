window.MAS_STRUCTURE = {
  "title": "mmWave radar Airbnb check-in feasibility",
  "version": 1,
  "locked": true,
  "rationale": "Literature finder and Privacy scout gather technical state-of-the-art and privacy constraints in parallel (Group A); Feasibility critic evaluates the team/time constraints and flags risky components (Group B); Lead combines findings into the final report.",
  "lead": {
    "id": "lead",
    "name": "Lead",
    "emoji": "🧭",
    "job": "Synthesize findings into a structured thesis feasibility report with clear proven/risky components and sources",
    "serves": ["R4"]
  },
  "groups": [
    {"id": "A", "label": "Gather evidence in parallel", "after": null},
    {"id": "B", "label": "Feasibility & risk critique", "after": "A"}
  ],
  "roles": [
    {
      "id": "literature-finder",
      "name": "Literature finder",
      "emoji": "📚",
      "serves": ["R1", "R4"],
      "job": "Search academic literature and benchmarks on TI mmWave radar person identification and gait/biometric recognition",
      "tools": ["web search"],
      "group": "A",
      "handsTo": "feasibility-critic",
      "why": "Different source (academic papers and technical benchmarks); can run in parallel"
    },
    {
      "id": "privacy-scout",
      "name": "Privacy scout",
      "emoji": "🔐",
      "serves": ["R3"],
      "job": "Investigate Airbnb guest privacy regulations, consent requirements, and privacy-preserving radar sensing methods",
      "tools": ["web search"],
      "group": "A",
      "handsTo": "feasibility-critic",
      "why": "Different expertise (legal/ethical compliance and privacy practices); can run in parallel"
    },
    {
      "id": "feasibility-critic",
      "name": "Feasibility critic",
      "emoji": "🧪",
      "serves": ["R1", "R2", "R4"],
      "job": "Assess engineering feasibility, hardware/AI stack viability within 9 months and £1000, and classify proven vs risky components",
      "tools": ["web search"],
      "group": "B",
      "handsTo": "lead",
      "why": "Needs an independent check across technical literature and privacy constraints to evaluate 9-month feasibility"
    }
  ]
};
