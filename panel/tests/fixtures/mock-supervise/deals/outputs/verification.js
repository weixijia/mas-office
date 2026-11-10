window.MAS_VERIFICATION = {
  "claims": [
    {
      "claimId": "c1",
      "text": "Currys sells the WH-1000XM6 new for £279 with free delivery.",
      "sources": [
        "currys-xm6"
      ],
      "serves": "R1",
      "checkworthy": true,
      "author": "lead",
      "status": "supported",
      "verdicts": [
        {
          "by": "catch-checker",
          "status": "supported",
          "sourceId": "currys-xm6",
          "relationship": "supports",
          "method": null,
          "note": "Price and free delivery are on the product page.",
          "backend": "codex",
          "at": "2026-11-10T09:29:00.000Z"
        }
      ]
    },
    {
      "claimId": "c2",
      "text": "John Lewis has it for £289 with next-day delivery.",
      "sources": [
        "johnlewis-xm6"
      ],
      "serves": "R1",
      "checkworthy": true,
      "author": "lead",
      "status": "partial",
      "verdicts": [
        {
          "by": "catch-checker",
          "status": "partial",
          "sourceId": "johnlewis-xm6",
          "relationship": "supports",
          "method": null,
          "note": "Price matches; delivery is 2–3 days, not next day.",
          "backend": "codex",
          "at": "2026-11-10T09:29:00.000Z"
        }
      ]
    },
    {
      "claimId": "c3",
      "text": "eBay seller X's total is £249 including postage.",
      "sources": [
        "ebay-x-xm6"
      ],
      "serves": "R3",
      "checkworthy": true,
      "author": "lead",
      "status": "contradicted",
      "verdicts": [
        {
          "by": "catch-checker",
          "status": "contradicted",
          "sourceId": "ebay-x-xm6",
          "relationship": "refutes",
          "method": null,
          "note": "The listing shows £249 + £15 postage = £264.",
          "backend": "codex",
          "at": "2026-11-10T09:29:00.000Z"
        },
        {
          "by": "lead",
          "status": "supported",
          "sourceId": "ebay-x-xm6",
          "relationship": "supports",
          "method": null,
          "note": null,
          "backend": "claude-code",
          "at": "2026-11-10T09:29:00.000Z"
        }
      ]
    },
    {
      "claimId": "c4",
      "text": "Amazon Warehouse offers are used, not new.",
      "sources": [
        "amazon-wh"
      ],
      "serves": "R2",
      "checkworthy": true,
      "author": "lead",
      "status": "unknown",
      "verdicts": [
        {
          "by": "catch-checker",
          "status": "unknown",
          "sourceId": "amazon-wh",
          "relationship": "irrelevant",
          "method": null,
          "note": "The page was a robot check; nothing to compare.",
          "backend": "codex",
          "at": "2026-11-10T09:29:00.000Z"
        }
      ]
    },
    {
      "claimId": "c5",
      "text": "Every shortlisted shop delivers within 3 days.",
      "sources": [],
      "serves": "R2",
      "checkworthy": true,
      "author": "lead",
      "status": "unchecked",
      "verdicts": []
    },
    {
      "claimId": "c6",
      "text": "The XM6 came out in 2026.",
      "sources": [],
      "serves": null,
      "checkworthy": false,
      "author": "lead",
      "status": "not-checkworthy",
      "verdicts": []
    }
  ],
  "evidence": [
    {
      "sourceId": "currys-xm6",
      "url": "https://www.currys.co.uk/products/sony-wh1000xm6",
      "urlHealth": "live",
      "httpStatus": 200,
      "archivedUrl": null,
      "grade": "A",
      "quote": "£279.00 · Free delivery",
      "note": null,
      "checkedBy": "lead",
      "at": "2026-11-10T09:29:00.000Z"
    },
    {
      "sourceId": "johnlewis-xm6",
      "url": "https://www.johnlewis.com/sony-wh-1000xm6",
      "urlHealth": "live",
      "httpStatus": 200,
      "archivedUrl": null,
      "grade": "A",
      "quote": null,
      "note": null,
      "checkedBy": "lead",
      "at": "2026-11-10T09:29:00.000Z"
    },
    {
      "sourceId": "ebay-x-xm6",
      "url": "https://www.ebay.co.uk/itm/2851",
      "urlHealth": "live",
      "httpStatus": 200,
      "archivedUrl": null,
      "grade": "A",
      "quote": "£249.00 + £15.00 postage",
      "note": null,
      "checkedBy": "lead",
      "at": "2026-11-10T09:29:00.000Z"
    },
    {
      "sourceId": "amazon-wh",
      "url": "https://www.amazon.co.uk/dp/B0XM6WH",
      "urlHealth": "blocked",
      "httpStatus": 503,
      "archivedUrl": null,
      "grade": "C",
      "quote": null,
      "note": "Robot check",
      "checkedBy": "lead",
      "at": "2026-11-10T09:29:00.000Z"
    },
    {
      "sourceId": "best-deals",
      "url": "https://best-xm6-deals.example/",
      "urlHealth": "hallucinated",
      "httpStatus": null,
      "archivedUrl": null,
      "grade": "D",
      "quote": null,
      "note": "No such host",
      "checkedBy": "lead",
      "at": "2026-11-10T09:29:00.000Z"
    }
  ],
  "summary": {
    "claims": 6,
    "checkworthy": 5,
    "supported": 1,
    "partial": 1,
    "contradicted": 1,
    "unknown": 1,
    "unchecked": 1,
    "sources": 5,
    "live": 3,
    "stale": 0,
    "hallucinated": 1,
    "blocked": 1,
    "uncited": 1
  }
};
