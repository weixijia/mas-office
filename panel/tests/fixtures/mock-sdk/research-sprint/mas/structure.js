window.MAS_STRUCTURE = {
  "title": "Research sprint",
  "version": 1,
  "locked": true,
  "topology": "dynamic",
  "lead": {"id": "lead", "name": "Lead", "emoji": "🧭", "job": "Answer the research question", "serves": []},
  "groups": [{"id": "dyn", "label": "Spawned at runtime", "after": null}],
  "roles": [
    {"id": "planner", "name": "Planner", "emoji": "🧠", "job": "Split the question", "serves": [], "tools": [], "group": "dyn", "handsTo": "lead", "dynamic": true, "parent": "lead"},
    {"id": "worker-1", "name": "Worker 1", "emoji": "🤖", "job": "Read papers on topic A", "serves": [], "tools": [], "group": "dyn", "handsTo": "reviewer", "dynamic": true, "parent": "planner"},
    {"id": "worker-2", "name": "Worker 2", "emoji": "🤖", "job": "Read papers on topic B", "serves": [], "tools": [], "group": "dyn", "handsTo": "reviewer", "dynamic": true, "parent": "planner"},
    {"id": "worker-3", "name": "Worker 3 <b>&amp;</b>", "emoji": "🤖", "job": "Run the benchmark", "serves": [], "tools": [], "group": "dyn", "handsTo": "reviewer", "dynamic": true, "parent": "planner"},
    {"id": "reviewer", "name": "Reviewer", "emoji": "🔍", "job": "Check the findings", "serves": [], "tools": [], "group": "dyn", "handsTo": "lead", "dynamic": true, "parent": "lead"},
    {"id": "approver", "name": "Approver", "emoji": "✅", "job": "Ask before spending compute", "serves": [], "tools": [], "group": "dyn", "handsTo": "lead", "dynamic": true, "parent": "lead"}
  ]
};
