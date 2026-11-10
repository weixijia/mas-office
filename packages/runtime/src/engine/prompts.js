// What the engine says to the Lead and to the roles. Plain text in, JSON out (for the Lead):
// the engine validates everything that comes back, so a prompt is a request, never a contract.

const list = (items) => items.map((x) => `- ${x}`).join('\n');

/** The task as the team sees it. `task` is `me/task` or `{title, summary}` built from a typed request. */
export function describeTask(task) {
  const lines = [];
  if (task.title) lines.push(`Title: ${task.title}`);
  if (task.summary) lines.push(task.summary);
  const reqs = Array.isArray(task.requirements) ? task.requirements : [];
  if (reqs.length) {
    lines.push('Requirements:');
    for (const r of reqs) lines.push(`- ${r.id ?? ''}${r.id ? ': ' : ''}${r.text ?? r}`);
  }
  if (task.question) lines.push(`Follow-up question: ${task.question}`);
  return lines.join('\n');
}

const roleLine = (r) => `${r.id} — ${r.name}: ${r.job ?? ''}${r.reviewerOf?.length ? ` (reviews: ${r.reviewerOf.join(', ')})` : ''}`;

export function planPrompt(team, task) {
  return `You are the Lead of this team. The team design is locked; you do not change it. You plan, brief and write the final answer. You do not search or browse yourself.

THE TASK
${describeTask(task)}

THE TEAM (stages run in order; roles in one stage run in parallel)
${list(team.roles.map(roleLine))}

Write one brief per role: what exactly to find or check for THIS task, what to leave out, and what a good hand-over looks like. A brief is 2–6 sentences. Do not repeat the role's general job description.

Answer with ONE JSON object and nothing after it:
\`\`\`json
{"plan": ["step 1", "step 2"], "briefs": {"<role id>": "<brief>"}}
\`\`\``;
}

export function writeupPrompt({ task, answerFile, workFiles, sourceIds, reviews, gateNotes, writeupRules, round }) {
  return `All roles have handed in. Write the answer${round > 1 ? ` to the follow-up question (round ${round})` : ''}.

THE TASK
${describeTask(task)}

READ THESE FILES FIRST
${list(workFiles)}
Source cards are in sources/ (ids: ${sourceIds.join(', ') || 'none'}).
${reviews.length ? `\nWHAT THE REVIEWERS DECIDED (pass their findings on as they are; do not soften them)\n${list(reviews)}` : ''}${gateNotes.length ? `\nWHAT THE PERSON SAID AT THE CHECKPOINTS\n${list(gateNotes)}` : ''}

${writeupRules}

Write the complete answer in Markdown to the file ${answerFile} (headings, lists, tables, bold and links only). Start with the answer itself, not with how the team worked.

Then end your message with ONE JSON object and nothing after it:
\`\`\`json
{"title": "<short title of the answer>", "satisfied": true, "next": "<what the person should do with this, one sentence>", "open": ["<anything the team could not settle>"]}
\`\`\``;
}

export function followUpPrompt(team, question, workFiles) {
  return `The person read the answer and asks a follow-up:

"${question}"

First re-read the answer and these files:
${list(workFiles)}

Decide the cheapest honest way to answer:
- If the files already answer it, answer from them.
- If a role must do more work, send back only the roles that are needed (a reviewer comes along when its target is sent back).

THE TEAM
${list(team.roles.map(roleLine))}

Answer with ONE JSON object and nothing after it. Either
\`\`\`json
{"dispatch": [], "reason": "<why no new work is needed>"}
\`\`\`
or
\`\`\`json
{"dispatch": ["<role id>"], "briefs": {"<role id>": "<what to do for this question>"}, "reason": "<why>"}
\`\`\``;
}

export function recoveryPrompt({ role, minutes, lastSay, strategies }) {
  return `${role.name} (${role.id}) has shown no progress for ${minutes} minutes. Its last status line was: "${lastSay}".

Choose ONE recovery: ${strategies.join(', ')}.
- retry: stop it and give it the same brief again
- replan: stop it and give it a new, narrower brief (write it in "brief")
- ask-human: let the person decide

Answer with ONE JSON object and nothing after it:
\`\`\`json
{"strategy": "retry", "brief": null, "note": "<one sentence why>"}
\`\`\``;
}

/** The Lead may decide this request only among the listed options. */
export function delegatedDecisionPrompt(request, agentName) {
  const options = request.options.map((o) => `${o.optionId} (${o.name})`).join(', ');
  return `${agentName} asks for a decision that the person has delegated to you.

${request.title}
${request.description ?? ''}
${request.subject ? `Details: ${JSON.stringify(request.subject).slice(0, 2000)}` : ''}

Options: ${options}, or "escalate" to pass it to the person.
Approve only what the task plainly needs. When in doubt, escalate.

Answer with ONE JSON object and nothing after it:
\`\`\`json
{"optionId": "<one of the option ids, or escalate>", "note": "<one sentence why>"}
\`\`\``;
}

export function roleBrief({ role, task, brief, inputs, attempt, note, round, personNotes }) {
  const file = round > 1 ? `outputs/work/${role.id}-round${round}.md` : `outputs/work/${role.id}.md`;
  const parts = [
    `THE TASK\n${describeTask(task)}`,
    `YOUR ASSIGNMENT\n${brief}`,
  ];
  if (inputs.length) parts.push(`READ FIRST (handed to you)\n${list(inputs)}`);
  if (round > 1) parts.push(`This is follow-up round ${round}. Read your earlier file outputs/work/${role.id}.md first and write only what is new.`);
  if (attempt > 1 && note) parts.push(`THIS IS ATTEMPT ${attempt}. Your reviewer sent your work back:\n${note}\nFix exactly that, and update your file.`);
  if (personNotes?.length) parts.push(`THE PERSON ADDED\n${list(personNotes)}`);
  parts.push(`Write your work to ${file}. When you are finished, end your message with one line:\nDONE: <one sentence saying what you found>`);
  return parts.join('\n\n');
}

export function reviewBrief({ role, task, targets, round, checkerRules, files, notes = [] }) {
  const read = files?.length ? files : targets.map((t) => `outputs/work/${t}.md`);
  return `THE TASK
${describeTask(task)}

YOUR REVIEW (round ${round})
You review the work of: ${targets.join(', ')}. You have not seen how they worked, only what they wrote. Read:
${list(read)}
and the source cards they cite in sources/.
${notes.length ? `\nTHE PERSON ADDED\n${list(notes)}\n` : ''}
${checkerRules}

Write your notes to outputs/work/${role.id}.md.`;
}

export function claimCheckBrief({ answerFile, claims, checkerRules, notes = [] }) {
  return `The Lead has written the answer in ${answerFile}. Check its claims one by one against the source cards in sources/ (and the pages they point to, when you can open them).

CLAIMS
${list(claims.map((c) => `${c.claimId} [sources: ${c.sources.join(', ') || 'none cited'}]: ${c.text}`))}
${notes.length ? `\nTHE PERSON ADDED\n${list(notes)}\n` : ''}
${checkerRules}`;
}

export const NUDGE = 'You have been quiet for a while. Say in one line what you are doing right now. If you are stuck, say what you need.';
