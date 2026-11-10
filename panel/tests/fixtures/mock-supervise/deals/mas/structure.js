window.MAS_STRUCTURE = {
  "title": "Headphone deals",
  "version": 2,
  "locked": true,
  "topology": "staged",
  "lead": {
    "id": "lead",
    "name": "Lead",
    "emoji": "🧭",
    "job": "Plan the run and write the answer with claim tags",
    "backend": "claude-code"
  },
  "groups": [
    {
      "id": "A",
      "label": "Search",
      "after": null
    },
    {
      "id": "B",
      "label": "Check",
      "after": "A"
    }
  ],
  "roles": [
    {
      "id": "retail-finder",
      "name": "Retail finder",
      "emoji": "🔎",
      "job": "Search major UK retailers for the lowest new price",
      "group": "A",
      "handsTo": "catch-checker",
      "backend": "claude-code",
      "tools": [
        "web search",
        {
          "name": "browse the web",
          "effect": "ask"
        }
      ]
    },
    {
      "id": "marketplace-finder",
      "name": "Marketplace finder",
      "emoji": "🛒",
      "job": "Search eBay and Amazon marketplace sellers",
      "group": "A",
      "handsTo": "catch-checker",
      "backend": "codex",
      "tools": [
        "web search"
      ]
    },
    {
      "id": "catch-checker",
      "name": "Catch checker",
      "emoji": "🛡️",
      "job": "Check every offer for refurbs, imports and hidden shipping",
      "group": "B",
      "handsTo": "lead",
      "backend": "codex",
      "tools": [
        "web search"
      ],
      "reviewerOf": [
        "retail-finder",
        "marketplace-finder"
      ],
      "cleanContext": true
    }
  ]
};
