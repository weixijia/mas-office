// Shared test fixtures (not a test file).

export const PROJECT = '/work/space/deals';
export const HOME = '/Users/sam';

/** A v2 design that uses every vocabulary word. */
export function v2Structure() {
  return {
    title: 'Headphone deals',
    version: 2,
    topology: 'staged',
    budget: { maxParallel: 3 },
    lead: {
      id: 'lead', name: 'Lead', backend: 'claude-code',
      delegate: [{ effect: 'allow', kind: 'approval', tools: ['web search', 'browse the web'] }],
    },
    groups: [{ id: 'A', label: 'Search', after: null }, { id: 'B', label: 'Check', after: 'A' }],
    roles: [
      {
        id: 'finder-a', name: 'Retail finder', emoji: '🔎', job: 'Find offers', group: 'A', handsTo: 'checker',
        tools: ['web search', { name: 'browse the web', effect: 'ask' }, 'read my files'],
        output: 'A table of offers with price, seller, condition and link',
      },
      {
        id: 'finder-b', name: 'Market finder', job: 'Find marketplace offers', group: 'A', handsTo: 'checker',
        tools: ['web search', { name: 'cli:git log', effect: 'allow' }, 'mcp:prices'],
      },
      {
        id: 'checker', name: 'Catch checker', job: 'Check every offer', group: 'B', handsTo: 'lead',
        backend: 'codex', tools: ['web search'], reviewerOf: ['finder-a', 'finder-b'],
      },
    ],
    gates: [
      { id: 'g-offers', after: 'A', kind: 'stage', title: 'Look at the offers', blocking: true },
      { id: 'g-final', after: null, kind: 'final', title: 'Approve the answer' },
    ],
  };
}

export const ENV = {
  workspace: '/work/space',
  project: PROJECT,
  home: HOME,
  mcpServers: {
    'mas-browser': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.12.0', '--isolated'] },
    prices: { command: 'node', args: ['prices.js'] },
  },
  commands: ['git'],
  backends: { 'claude-code': true, codex: true },
};
