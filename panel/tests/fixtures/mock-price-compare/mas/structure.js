window.MAS_STRUCTURE = {"title": "Headphone deal finder", "version": 1, "locked": true,
"rationale": "Two finders search different kinds of shop at the same time (R1). A separate checker guards R2 and R3 because mistakes there cost money. The Lead writes the shortlist (R4).",
"lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "Combine the checked offers into a buying shortlist", "serves": ["R4"]},
"groups": [{"id": "A", "label": "Search in parallel", "after": null}, {"id": "B", "label": "Check", "after": "A"}],
"roles": [
 {"id": "retail-finder", "name": "Retail finder", "emoji": "🔎", "serves": ["R1"], "job": "Search major UK retailers for the lowest new price", "tools": ["web search"], "group": "A", "handsTo": "catch-checker", "why": "Different source from marketplaces; can run at the same time"},
 {"id": "marketplace-finder", "name": "Marketplace finder", "emoji": "🛒", "serves": ["R1"], "job": "Search eBay and Amazon marketplace sellers", "tools": ["web search"], "group": "A", "handsTo": "catch-checker", "why": "Different source; can run at the same time"},
 {"id": "catch-checker", "name": "Catch checker", "emoji": "🛡️", "serves": ["R2", "R3"], "job": "Flag refurbished stock, parallel imports and hidden shipping", "tools": ["web search"], "group": "B", "handsTo": "lead", "why": "Independent check: mistakes on R2 and R3 cost money"}
]};
