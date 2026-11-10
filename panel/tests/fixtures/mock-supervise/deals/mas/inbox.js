window.MAS_INBOX = {
  "pending": [
    {
      "requestId": "req_browse",
      "agentId": "retail-finder",
      "kind": "approval",
      "title": "Open currys.co.uk in the browser?",
      "description": "The search result shows £279 but no delivery terms. The finder wants to read the product page.",
      "subject": {
        "type": "tool_call",
        "tool": "browse the web",
        "input": {
          "url": "https://www.currys.co.uk/products/sony-wh1000xm6-wireless-bluetooth-noisecancelling-headphones-black-10273123.html",
          "actions": [
            {
              "do": "navigate"
            },
            {
              "do": "wait",
              "for": "price block"
            },
            {
              "do": "read",
              "selector": ".product-price"
            },
            {
              "do": "read",
              "selector": ".delivery-options"
            },
            {
              "do": "read",
              "selector": ".condition"
            },
            {
              "do": "screenshot",
              "area": "price block"
            }
          ],
          "note": "Read only: no clicks on Buy, no forms, no cookies kept."
        }
      },
      "toolCallId": "call_6",
      "options": [
        {
          "optionId": "allow-once",
          "name": "Allow once",
          "kind": "allow_once"
        },
        {
          "optionId": "deny",
          "name": "Decline",
          "kind": "reject_once"
        }
      ],
      "responseSchema": null,
      "blocking": true,
      "routeTo": "human",
      "resolver": "anyone",
      "urgency": "normal",
      "expiresAt": null,
      "onExpire": "The finder skips Currys and reports the search-result price only.",
      "source": {
        "backend": "claude-code"
      },
      "openedAt": "2026-11-10T09:26:00.000Z",
      "seq": 41,
      "run": 1
    },
    {
      "requestId": "req_q",
      "agentId": "marketplace-finder",
      "kind": "question",
      "title": "Include Amazon Warehouse (used) offers?",
      "description": "They are £40 cheaper but listed as \"Used – Like New\". Your task says new only.",
      "subject": null,
      "toolCallId": null,
      "options": [
        {
          "optionId": "yes",
          "name": "Yes, list them separately",
          "kind": "choice"
        },
        {
          "optionId": "no",
          "name": "No, new only",
          "kind": "choice"
        }
      ],
      "responseSchema": null,
      "blocking": true,
      "routeTo": "human",
      "resolver": "anyone",
      "urgency": "normal",
      "expiresAt": null,
      "onExpire": "The finder leaves Amazon Warehouse out.",
      "source": null,
      "openedAt": "2026-11-10T09:27:00.000Z",
      "seq": 44,
      "run": 1
    },
    {
      "requestId": "req_gate",
      "agentId": "lead",
      "kind": "gate",
      "title": "Look at the offers before checking",
      "description": "Search is done: 5 offers from 4 shops. The checker starts when you accept.",
      "subject": {
        "type": "stage",
        "after": "A",
        "label": "Search → Check",
        "summary": "Currys £279 · John Lewis £289 · eBay seller X £249 + £15 · Amazon Warehouse £239 (used) · Argos £299"
      },
      "toolCallId": null,
      "options": [],
      "responseSchema": null,
      "blocking": true,
      "routeTo": "human",
      "resolver": "human_only",
      "urgency": "normal",
      "expiresAt": null,
      "onExpire": "The checker does not start.",
      "source": null,
      "openedAt": "2026-11-10T09:28:00.000Z",
      "seq": 47,
      "run": 1
    },
    {
      "requestId": "req_flag",
      "agentId": "catch-checker",
      "kind": "flag",
      "title": "The eBay total does not match the listing",
      "description": "The finder wrote £249 including postage; the listing adds £15 postage.",
      "subject": {
        "type": "claim",
        "claimId": "c3",
        "text": "eBay seller X's total is £249 including postage."
      },
      "toolCallId": null,
      "options": [
        {
          "optionId": "use-checker",
          "name": "Use £264 (checker)",
          "kind": "choice"
        },
        {
          "optionId": "use-finder",
          "name": "Keep £249 (finder)",
          "kind": "choice"
        }
      ],
      "responseSchema": null,
      "blocking": true,
      "routeTo": "human",
      "resolver": "not_creator",
      "urgency": "high",
      "expiresAt": null,
      "onExpire": "The Lead uses the checker’s figure and marks it.",
      "source": null,
      "openedAt": "2026-11-10T09:29:00.000Z",
      "seq": 50,
      "run": 1
    },
    {
      "requestId": "req_cmd",
      "agentId": "marketplace-finder",
      "kind": "approval",
      "title": "Run a command?",
      "description": null,
      "subject": {
        "type": "command",
        "command": "curl -s \"https://www.ebay.co.uk/sch/i.html?_nkw=sony+wh-1000xm6&LH_ItemCondition=1000\" | head -c 20000"
      },
      "toolCallId": "item_9",
      "options": [
        {
          "optionId": "once",
          "name": "Allow once",
          "kind": "allow_once"
        },
        {
          "optionId": "always",
          "name": "Always allow curl",
          "kind": "allow_always"
        },
        {
          "optionId": "no",
          "name": "Decline",
          "kind": "reject_once"
        }
      ],
      "responseSchema": null,
      "blocking": true,
      "routeTo": "human",
      "resolver": "anyone",
      "urgency": "low",
      "expiresAt": null,
      "onExpire": null,
      "source": {
        "backend": "codex"
      },
      "openedAt": "2026-11-10T09:25:00.000Z",
      "seq": 39,
      "run": 1
    },
    {
      "requestId": "req_lead1",
      "agentId": "retail-finder",
      "kind": "approval",
      "title": "Search the John Lewis outlet?",
      "description": null,
      "subject": {
        "type": "tool_call",
        "tool": "web search",
        "input": {
          "query": "john lewis outlet sony wh-1000xm6"
        }
      },
      "toolCallId": "call_5",
      "options": [
        {
          "optionId": "allow-once",
          "name": "Allow once",
          "kind": "allow_once"
        },
        {
          "optionId": "deny",
          "name": "Decline",
          "kind": "reject_once"
        }
      ],
      "responseSchema": null,
      "blocking": true,
      "routeTo": "lead",
      "resolver": "anyone",
      "urgency": "normal",
      "expiresAt": null,
      "onExpire": null,
      "source": null,
      "openedAt": "2026-11-10T09:29:00.000Z",
      "seq": 49,
      "run": 1
    }
  ],
  "recent": [
    {
      "requestId": "req_r4",
      "agentId": "marketplace-finder",
      "kind": "approval",
      "title": "Read ebay.co.uk/itm/2851?",
      "options": [
        {
          "optionId": "allow-once",
          "name": "Allow once",
          "kind": "allow_once"
        }
      ],
      "blocking": true,
      "routeTo": "human",
      "urgency": "normal",
      "openedAt": "2026-11-10T09:20:00.000Z",
      "seq": 30,
      "run": 1,
      "outcome": "superseded",
      "optionId": null,
      "payload": null,
      "note": null,
      "by": {
        "kind": "terminal"
      },
      "cmdId": null,
      "resolvedAt": "2026-11-10T09:21:00.000Z"
    },
    {
      "requestId": "req_r3",
      "agentId": "retail-finder",
      "kind": "approval",
      "title": "Search Argos?",
      "options": [
        {
          "optionId": "allow-once",
          "name": "Allow once",
          "kind": "allow_once"
        },
        {
          "optionId": "deny",
          "name": "Decline",
          "kind": "reject_once"
        }
      ],
      "blocking": true,
      "routeTo": "human",
      "urgency": "normal",
      "openedAt": "2026-11-10T09:14:00.000Z",
      "seq": 22,
      "run": 1,
      "outcome": "selected",
      "optionId": "allow-once",
      "payload": null,
      "note": null,
      "by": {
        "kind": "human"
      },
      "cmdId": "cmd_c",
      "resolvedAt": "2026-11-10T09:15:30.000Z"
    },
    {
      "requestId": "req_r2",
      "agentId": "catch-checker",
      "kind": "question",
      "title": "Count parallel imports as new?",
      "options": [],
      "blocking": true,
      "routeTo": "lead",
      "urgency": "normal",
      "openedAt": "2026-11-10T09:09:00.000Z",
      "seq": 15,
      "run": 1,
      "outcome": "submitted",
      "optionId": null,
      "payload": {
        "text": "No: the task says UK stock only."
      },
      "note": null,
      "by": {
        "kind": "agent",
        "id": "lead"
      },
      "cmdId": "cmd_l1",
      "resolvedAt": "2026-11-10T09:09:24.000Z"
    },
    {
      "requestId": "req_r1",
      "agentId": "retail-finder",
      "kind": "approval",
      "title": "Search the web for \"currys sony wh-1000xm6\"?",
      "options": [
        {
          "optionId": "allow-once",
          "name": "Allow once",
          "kind": "allow_once"
        }
      ],
      "blocking": true,
      "routeTo": "human",
      "urgency": "normal",
      "openedAt": "2026-11-10T09:05:00.000Z",
      "seq": 8,
      "run": 1,
      "outcome": "selected",
      "optionId": "allow-once",
      "payload": null,
      "note": null,
      "by": {
        "kind": "policy",
        "rule": "web search"
      },
      "cmdId": null,
      "resolvedAt": "2026-11-10T09:05:00.000Z"
    }
  ],
  "commands": [
    {
      "cmdId": "cmd_l1",
      "type": "command.respond",
      "agentId": "catch-checker",
      "origin": {
        "kind": "agent",
        "id": "lead"
      },
      "text": null,
      "delivery": null,
      "requestId": "req_r2",
      "status": "applied",
      "reason": null,
      "sentAt": "2026-11-10T09:09:24.000Z",
      "ackAt": "2026-11-10T09:09:24.000Z",
      "seq": 16
    },
    {
      "cmdId": "cmd_c",
      "type": "command.respond",
      "agentId": "retail-finder",
      "origin": {
        "kind": "human"
      },
      "text": null,
      "delivery": null,
      "requestId": "req_r3",
      "status": "applied",
      "reason": null,
      "sentAt": "2026-11-10T09:15:30.000Z",
      "ackAt": "2026-11-10T09:15:30.000Z",
      "seq": 23
    },
    {
      "cmdId": "cmd_a",
      "type": "command.message",
      "agentId": "retail-finder",
      "origin": {
        "kind": "human"
      },
      "text": "Prefer retailers with free delivery.",
      "delivery": "steer",
      "requestId": null,
      "status": "applied",
      "reason": "delivered after the current turn",
      "sentAt": "2026-11-10T09:18:00.000Z",
      "ackAt": "2026-11-10T09:19:00.000Z",
      "seq": 26
    },
    {
      "cmdId": "cmd_b",
      "type": "command.message",
      "agentId": "marketplace-finder",
      "origin": {
        "kind": "agent",
        "id": "lead"
      },
      "text": "Skip sellers outside the UK.",
      "delivery": "queue",
      "requestId": null,
      "status": "accepted",
      "reason": null,
      "sentAt": "2026-11-10T09:22:00.000Z",
      "ackAt": "2026-11-10T09:22:00.000Z",
      "seq": 33
    }
  ]
};
