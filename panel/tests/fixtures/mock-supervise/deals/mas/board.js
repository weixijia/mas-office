window.MAS_BOARD = {
  "tasks": [
    {
      "taskId": "t1",
      "agentId": "retail-finder",
      "title": "Lowest new price at UK retailers",
      "brief": "Search Currys, John Lewis, Argos and Richer Sounds. New stock only. Save a source card per offer.",
      "from": "lead",
      "round": 1,
      "attempt": 1,
      "state": "working",
      "say": "Reading Currys",
      "outcome": null,
      "summary": null,
      "assignedAt": "2026-11-10T09:04:00.000Z",
      "finishedAt": null
    },
    {
      "taskId": "t2",
      "agentId": "marketplace-finder",
      "title": "Marketplace sellers",
      "brief": "eBay and Amazon sellers with UK stock; add postage to every total.",
      "from": "lead",
      "round": 1,
      "attempt": 2,
      "state": "working",
      "say": null,
      "outcome": null,
      "summary": null,
      "assignedAt": "2026-11-10T09:04:00.000Z",
      "finishedAt": null
    },
    {
      "taskId": "t3",
      "agentId": "catch-checker",
      "title": "Check every offer",
      "brief": "Refurbished stock, parallel imports, hidden shipping.",
      "from": "lead",
      "round": 1,
      "attempt": 1,
      "state": "working",
      "say": null,
      "outcome": null,
      "summary": null,
      "assignedAt": "2026-11-10T09:24:00.000Z",
      "finishedAt": null
    }
  ],
  "ledger": {
    "satisfied": false,
    "looping": false,
    "progressing": true,
    "next": "catch-checker",
    "instruction": "Hold the checker at the stage gate until the offers are approved.",
    "reason": "Both finders reported; one revise round done.",
    "plan": [
      "Finders search in parallel",
      "Stage gate: you look at the offers",
      "Checker verifies every offer",
      "Lead writes the shortlist with claim tags"
    ],
    "stalls": 0,
    "updated": "2026-11-10T09:28:00.000Z"
  },
  "reviews": [
    {
      "reviewer": "catch-checker",
      "target": "retail-finder",
      "verdict": "accept",
      "round": 1,
      "note": null,
      "at": "2026-11-10T09:23:00.000Z"
    },
    {
      "reviewer": "catch-checker",
      "target": "marketplace-finder",
      "verdict": "revise",
      "round": 1,
      "note": "The eBay listing says \"Excellent – Refurbished\". Find a new-only seller.",
      "at": "2026-11-10T09:23:00.000Z"
    }
  ],
  "recoveries": [],
  "usage": {
    "lead": {
      "inputTokens": 41200,
      "outputTokens": 5300,
      "costUsd": 0.62,
      "turns": 4,
      "limit": null,
      "updated": "2026-11-10T09:28:00.000Z"
    },
    "retail-finder": {
      "inputTokens": 88400,
      "outputTokens": 7100,
      "costUsd": 0,
      "turns": 9,
      "limit": null,
      "updated": "2026-11-10T09:26:00.000Z"
    },
    "marketplace-finder": {
      "inputTokens": 64100,
      "outputTokens": 6200,
      "costUsd": 0,
      "turns": 7,
      "limit": {
        "status": "allowed_warning",
        "resetsAt": "14:00",
        "kind": "five_hour"
      },
      "updated": "2026-11-10T09:27:00.000Z"
    },
    "catch-checker": {
      "inputTokens": 12800,
      "outputTokens": 900,
      "costUsd": 0,
      "turns": 1,
      "limit": null,
      "updated": "2026-11-10T09:29:00.000Z"
    }
  },
  "agents": {
    "lead": {
      "backend": "claude-code",
      "model": null,
      "session": {
        "backend": "claude-code",
        "id": "s-lead"
      },
      "accepts": [
        "message",
        "interrupt",
        "respond"
      ],
      "reviewerOf": []
    },
    "retail-finder": {
      "backend": "claude-code",
      "model": null,
      "session": {
        "backend": "claude-code",
        "id": "s-rf"
      },
      "accepts": [
        "message",
        "interrupt",
        "respond"
      ],
      "reviewerOf": []
    },
    "marketplace-finder": {
      "backend": "codex",
      "model": null,
      "session": {
        "backend": "codex",
        "id": "th-mf"
      },
      "accepts": [
        "message",
        "interrupt",
        "respond"
      ],
      "reviewerOf": []
    },
    "catch-checker": {
      "backend": "codex",
      "model": null,
      "session": {
        "backend": "codex",
        "id": "th-cc"
      },
      "accepts": [
        "respond"
      ],
      "reviewerOf": [
        "retail-finder",
        "marketplace-finder"
      ]
    }
  }
};
