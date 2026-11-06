// The `mas-office demo` storyline: a simulated 5-agent staged team planning a weekend trip.
// Two finders search in parallel, a checker raises a concern and spawns a helper to fix it,
// a planner builds the days, and the lead writes the result. All data is made up.

export const DEMO_PROJECT = 'lisbon-weekend';

const STRUCTURE = {
  title: 'Lisbon weekend (demo)',
  version: 1,
  topology: 'staged',
  rationale: 'Flights and stays are independent, so two finders search at the same time. One checker adds up the money, then a planner builds the days around the chosen flight times.',
  lead: { id: 'lead', name: 'Lead', emoji: '🧭', job: 'Turn the checked options into one weekend plan', serves: ['R4'] },
  groups: [
    { id: 'A', label: 'Search in parallel', after: null },
    { id: 'B', label: 'Check the budget', after: 'A' },
    { id: 'C', label: 'Plan the days', after: 'B' },
  ],
  roles: [
    { id: 'flight-finder', name: 'Flight finder', emoji: '✈️', job: 'Find return flights London → Lisbon, Friday to Sunday', serves: ['R1', 'R2'], tools: ['flight search'], group: 'A', handsTo: 'budget-checker' },
    { id: 'stay-finder', name: 'Stay finder', emoji: '🏨', job: 'Find central places to stay for two nights', serves: ['R1', 'R3'], tools: ['stay search'], group: 'A', handsTo: 'budget-checker' },
    { id: 'budget-checker', name: 'Budget checker', emoji: '🧮', job: 'Add up flights + stay, including every fee', serves: ['R1'], tools: ['calculator'], group: 'B', handsTo: 'day-planner' },
    { id: 'day-planner', name: 'Day planner', emoji: '🗺️', job: 'Plan Saturday and Sunday around the flight times', serves: ['R2', 'R3', 'R4'], tools: ['maps'], group: 'C', handsTo: 'lead' },
  ],
};

const TASK = {
  summary: 'Plan a weekend in Lisbon for one person: flights from London and two nights somewhere central.',
  requirements: [
    { id: 'R1', text: 'Flights + stay under £350 in total, fees included' },
    { id: 'R2', text: 'Leave Friday, back Sunday evening' },
    { id: 'R3', text: 'Stay within walking distance of the old town' },
    { id: 'R4', text: 'A simple plan for Saturday and Sunday' },
  ],
};

const RESULT = `*Demo data: prices, times and links are made up.*

## Short answer
The weekend fits the budget: **£324** for flights and two nights, £26 under the £350 limit.

## The plan
| | Choice | Cost |
|---|---|---|
| Flights | easyJet, Fri 06:15 out, Sun 19:50 back | £96 |
| Stay | Pensão Rossio, 2 nights, fees included | £228 |
| **Total** | | **£324** |

## Days
- **Saturday** — Alfama on foot in the morning, tram 28 to Graça, sunset at the Miradouro da Senhora do Monte.
- **Sunday** — Belém early (Jerónimos opens at 09:30), lunch by the river, airport by 17:30.

## Check before you book
- The Baixa Loft looked cheaper (£204) but adds a £60 cleaning fee, which breaks the limit — the Budget checker swapped it out.
- Confirm the Pensão Rossio total at checkout.`;

const SOURCES = {
  flightA: { id: 'flight-tap-fri', title: 'TAP Air Portugal LHR → LIS, Fri 18:05 – Sun 20:40', url: 'https://example.com/flights/tap-lhr-lis', evidence: 'A' },
  flightB: { id: 'flight-easyjet-fri', title: 'easyJet LGW → LIS, Fri 06:15 – Sun 19:50', url: 'https://example.com/flights/easyjet-lgw-lis', evidence: 'A' },
  stayA: { id: 'stay-baixa-loft', title: 'Baixa Loft — 2 nights, £204', url: 'https://example.com/stays/baixa-loft', evidence: 'A' },
  stayB: { id: 'stay-pensao-rossio', title: 'Pensão Rossio — 2 nights, fees included', url: 'https://example.com/stays/pensao-rossio', evidence: 'A' },
};

/**
 * Play the storyline (~40 s at speed 1) through an Office.
 * @param {import('@mas-office/sdk').Office} office
 * @param {{speed?: number}} [options] playback speed multiplier
 */
export async function runDemo(office, { speed = 1 } = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms / speed));
  const work = (ms) => () => sleep(ms); // a fake tool call that takes `ms`

  const project = office.project(DEMO_PROJECT, { title: STRUCTURE.title, task: TASK });
  const run = project.run({ structure: STRUCTURE });
  const { lead } = run;
  const flights = run.agent('flight-finder');
  const stays = run.agent('stay-finder');
  const budget = run.agent('budget-checker');
  const planner = run.agent('day-planner');

  await sleep(2000);
  lead.say('Two finders start together; checks come after');
  await sleep(1500);

  // Group A: both finders at the same time.
  await Promise.all([
    (async () => {
      flights.working('Searching flights from London', { progress: 10 });
      await sleep(1500);
      await flights.tool('flight_search', work(2500), { say: 'Comparing Friday departures' });
      flights.working('TAP, Fri 18:05 · £128 return', { progress: 55 });
      flights.source(SOURCES.flightA);
      await sleep(2000);
      flights.working('easyJet, Fri 06:15 · £96 return', { progress: 85 });
      flights.source(SOURCES.flightB);
      await sleep(1500);
      flights.handoff(budget, { say: 'Two flights for the budget check' });
      await sleep(1200);
      flights.done('Handed over 2 flights');
    })(),
    (async () => {
      await sleep(600);
      stays.working('Looking at Alfama and Baixa', { progress: 10 });
      await sleep(1800);
      await stays.tool('stay_search', work(2200), { say: 'Reading 14 listings' });
      stays.working('Baixa Loft · £204, 5 min to the river', { progress: 60 });
      stays.source(SOURCES.stayA);
      await sleep(2200);
      stays.working('Casa Alfama is full that weekend', { progress: 85 });
      await sleep(1300);
      stays.handoff(budget, { say: 'Baixa Loft is the best central stay' });
      await sleep(1000);
      stays.done('Handed over 1 stay');
    })(),
  ]);
  lead.say('Search done — over to the Budget checker');

  // Group B: the checker finds a hidden fee and spawns a helper to fix it.
  await sleep(1000);
  budget.working('Adding up flights + stay', { progress: 20 });
  await sleep(2000);
  await budget.tool('calculator', work(1000), { say: 'Reading the small print' });
  budget.flag('£60 cleaning fee: total £360, over £350', { kind: 'concern' });
  await sleep(2500);
  const scout = run.agent('fee-scout', {
    name: 'Fee scout', emoji: '🧾', job: 'Find a central stay with every fee included', parent: budget, group: 'B', handsTo: 'budget-checker',
  });
  scout.working('Searching stays with fees included', { progress: 15 });
  await sleep(1800);
  await scout.tool('stay_search', work(2000), { say: 'Re-checking 6 listings for fees' });
  scout.working('Pensão Rossio · £228, fees included', { progress: 80 });
  scout.source(SOURCES.stayB);
  await sleep(1500);
  scout.handoff(budget, { say: 'Found one with no extra fees' });
  await sleep(1000);
  scout.done('Found a fee-free stay');
  budget.resolve();
  budget.working('New total: £96 + £228 = £324', { progress: 85 });
  await sleep(1800);
  budget.handoff(planner, { say: 'Budget OK — £324 of £350' });
  await sleep(1000);
  budget.done('Budget OK: £324 of £350');

  // Group C: the planner.
  await sleep(800);
  planner.working('Planning Saturday around Alfama', { progress: 25 });
  await sleep(2500);
  await planner.tool('maps', work(1500), { say: 'Checking walking times' });
  planner.working('Sunday: Belém, back by 17:30', { progress: 70 });
  await sleep(2000);
  planner.say('Flight home is 19:50 — time for lunch by the river');
  await sleep(1500);
  planner.handoff(lead, { say: 'Day plan ready for the Lead' });
  await sleep(1000);
  planner.done('Handed over the plan');

  // The lead writes the result.
  lead.working('Writing the weekend plan', { progress: 60 });
  await sleep(2500);
  run.result({
    markdown: RESULT,
    work: [
      { by: 'flight-finder', summary: 'Compared Friday flights from Heathrow and Gatwick; the **easyJet 06:15** is £32 cheaper than TAP.' },
      { by: 'stay-finder', summary: 'Read 14 listings in Alfama and Baixa. **Baixa Loft** was the best central option on price.' },
      { by: 'budget-checker', summary: 'Found a £60 cleaning fee on the Baixa Loft, which made the total £360 (over £350), and asked the Fee scout for an alternative. Final total **£324**.' },
      { by: 'fee-scout', summary: 'Re-checked 6 listings for fees; **Pensão Rossio** includes all fees at £228.' },
      { by: 'day-planner', summary: 'Saturday in Alfama and Graça on foot, Sunday in Belém, at the airport by 17:30.' },
    ],
  });
  await sleep(800);
  run.finish('Weekend plan ready');
  return run;
}
