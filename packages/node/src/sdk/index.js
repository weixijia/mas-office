// mas-office SDK — emit MAS Office events from any JavaScript multi-agent system.

export { Office, Project, Run, Agent } from './office.js';
export { createReducer, reduce, parseLog, validateEvent, SPEC_VERSION, STATES } from './reducer.js';
export {
  writeSnapshots, writeDocument, writeFileAtomic, jsTwin, parseJsTwin, splitJsTwin, readDocument,
  describeDocument, updateProjectsIndex, GLOBALS,
} from './files.js';
export { ProjectLog, EventError, eventErrors } from './log.js';
export { isValidFolder, isValidAgentId, assertFolder, sanitizeId, FOLDER_PATTERN, AGENT_ID_PATTERN } from './names.js';
