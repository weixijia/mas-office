window.MAS_RESULT = {
  "title": "Headphone deals — run 1",
  "run": 1,
  "updated": "2026-11-10T09:30:00.000Z",
  "markdown": "## Shortlist\n| Shop | Total | Notes |\n|---|---|---|\n| Currys | **£279** | <claim id=\"c1\" src=\"currys-xm6\">new, £279, free delivery</claim> |\n| John Lewis | £289 | <claim id=\"c2\" src=\"johnlewis-xm6\">£289 with next-day delivery</claim> |\n| eBay seller X | £249 | ⚠️ <claim id=\"c3\" src=\"ebay-x-xm6\">total £249 including postage</claim> |\n\n## Notes\n<claim id=\"c4\" src=\"amazon-wh\">Amazon Warehouse offers are used, not new</claim>, so they are left out. <claim id=\"c5\">Every shortlisted shop delivers within 3 days.</claim> <claim id=\"c6\">The XM6 came out in 2026.</claim>\n\nHostile input stays text: <claim id='x\" onmouseover=\"alert(1)'>bad id</claim> · <claim id=open>never closed · <img src=x onerror=alert(1)>",
  "sources": [
    {
      "id": "currys-xm6",
      "title": "Sony WH-1000XM6 — Currys",
      "url": "https://www.currys.co.uk/products/sony-wh1000xm6",
      "evidence": "A",
      "foundBy": "retail-finder"
    },
    {
      "id": "johnlewis-xm6",
      "title": "Sony WH-1000XM6 — John Lewis",
      "url": "https://www.johnlewis.com/sony-wh-1000xm6",
      "evidence": "A",
      "foundBy": "retail-finder"
    },
    {
      "id": "ebay-x-xm6",
      "title": "Sony WH-1000XM6 — eBay seller X",
      "url": "https://www.ebay.co.uk/itm/2851",
      "evidence": "A",
      "foundBy": "marketplace-finder"
    },
    {
      "id": "amazon-wh",
      "title": "Amazon Warehouse listing",
      "url": "https://www.amazon.co.uk/dp/B0XM6WH",
      "evidence": "C",
      "foundBy": "marketplace-finder"
    }
  ],
  "flags": [
    {
      "by": "catch-checker",
      "kind": "concern",
      "text": "The eBay total does not include postage."
    }
  ],
  "work": [
    {
      "by": "retail-finder",
      "summary": "- Searched Currys, John Lewis and Argos\n- Lowest new price: **£279** at Currys"
    }
  ]
};
