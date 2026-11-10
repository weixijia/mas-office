window.MAS_STRUCTURE = {
  "title": "Headphone deal finder",
  "version": 1,
  "locked": true,
  "signature": "sha256:f4a5b427a67aa37e5202b12ac873010ef7a4e260e9eaa90587e771f49faac9cc",
  "topology": "staged",
  "rationale": "Two finders search at the same time: one for the Sony WH-1000XM6 itself and one for similar models, since you said 'or similar' and the Sony may be over budget. Then two checkers run at the same time: the Catch checker verifies new-only, delivery within 3 days and UK sellers, and the Budget checker verifies the total including delivery stays under £280 (added at your request). The Lead merges everything into your 2-3 offer shortlist.",
  "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "Combine the checked offers into a shortlist of the 2-3 best, with total prices and links", "serves": ["R4"],
           "backend": "claude-code",
           "delegate": [{"effect": "allow", "kind": "approval", "tools": ["web search"]}]},
  "budget": {"maxParallel": 2},
  "groups": [
    {"id": "A", "label": "Search in parallel", "after": null},
    {"id": "B", "label": "Check", "after": "A"}
  ],
  "roles": [
    {"id": "sony-deal-finder", "name": "Sony deal finder", "emoji": "🛒", "serves": ["R1", "R3"],
     "job": "Find UK shop prices, delivery costs and delivery times for the Sony WH-1000XM6", "tools": ["web search"],
     "output": "A table of UK offers: shop, price, delivery cost, delivery time, condition and link, each citing its source card",
     "group": "A", "handsTo": "catch-checker", "why": "Different source from the similar-model finder; can run at the same time"},
    {"id": "similar-model-finder", "name": "Similar-model finder", "emoji": "🔀", "serves": ["R1", "R3"],
     "job": "Find UK offers on similar noise-cancelling headphones (e.g. Bose, Apple, Sennheiser) under £280 with delivery", "tools": ["web search"],
     "output": "A table of UK offers on similar models under £280: model, shop, price, delivery, condition and link, each citing its source card",
     "group": "A", "handsTo": "catch-checker", "why": "Different expertise (alternative models) and can run in parallel"},
    {"id": "catch-checker", "name": "Catch checker", "emoji": "🛡️", "serves": ["R2", "R3"],
     "job": "Re-check every offer for refurbished stock, slow delivery and non-UK sellers", "tools": ["web search"],
     "backend": "codex", "reviewerOf": ["sony-deal-finder", "similar-model-finder"], "cleanContext": true,
     "review": {"maxRounds": 2, "onExceed": "ask-human"},
     "output": "A verdict per offer: new / refurbished, delivery days, UK seller, with the evidence for each",
     "group": "B", "handsTo": "lead", "why": "Independent check: mistakes on new-only and delivery are costly; a different vendor catches different mistakes"},
    {"id": "budget-checker", "name": "Budget checker", "emoji": "🧮", "serves": ["R1"],
     "job": "Check that each offer's total including delivery (and any extra fees) stays under £280", "tools": ["web search"],
     "group": "B", "handsTo": "lead", "why": "Independent check of the price limit; can run at the same time as the Catch checker"}
  ],
  "gates": [
    {"id": "g-offers", "after": "A", "kind": "stage", "title": "Look at the offers before they are checked", "blocking": true}
  ],
  "verify": {"claims": true, "urlHealth": true}
};
