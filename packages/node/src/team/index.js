// Team design v2: vocabulary, defaults and checks, signature, permission compiler and
// `decideTool`. All pure (no session I/O); see docs/design/runtime.md §5.
export {
  EFFECTS, WORDS, BROWSER_SERVER, BROWSER_DENIED_TOOLS, CLAUDE_MAPPING, CLAUDE_KNOWN_TOOLS,
  parseToolEntry, parseMcpToolName, roleWritable, LEAD_WRITABLE,
} from './vocabulary.js';
export { normalizeSubject, subjectMatchesWord } from './subject.js';
export {
  normalizeTeam, stageOrder, BACKENDS, DEFAULT_BUDGET, DEFAULT_REVIEW, DEFAULT_VERIFY, ROLE_ID_PATTERN, GATE_KINDS,
} from './normalize.js';
export { signTeam, lockTeam, verifySignature, canonicalJson, behaviourOf } from './sign.js';
export { compileRole, compileLead, CLAUDE_SCOPED_DENY } from './compile.js';
export { decideTool } from './decide.js';
export { teamToMarkdown } from './markdown.js';
export {
  resolvePath, isCredentialPath, isProtectedPath, isBlockedUrl, isBlockedHostToken, hasShellMeta, hasPrefixUnsafe,
  matchesPrefix, matchGlob,
} from './paths.js';
