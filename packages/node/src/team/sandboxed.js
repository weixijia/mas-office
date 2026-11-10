// Read-only shell commands that Codex ran inside its read-only sandbox (subject `sandboxed: true`).
// A Codex role reads files with `cat`, `sed -n`, `rg`, `ls`, … rather than a Read tool. Such a
// command cannot write or reach the network there, so `decideTool` allows it when it is only a
// read of the project folder that a Read call would also be allowed:
// 1. simple commands joined only by `|`; quotes are fine, but no `;`, `&`, `||`, redirects,
//    backticks, `$`, braces, `~`, `#`, backslashes or newlines outside single quotes;
// 2. every command is on a fixed read-only list, with its writing or executing options refused
//    (`sed` needs `-n` and a print-only script; `find` without `-exec`/`-delete`/`-fprint`/…;
//    `sort` without `-o`; `rg` without `--pre`; `uniq` with at most one file);
// 3. every path word resolves (against `cwd`, itself inside the project) to a path inside the
//    project folder that passes the credential and raw/ rules; a recursive search (`rg`,
//    `grep -r`, `find`, `ls -R`) must not start at the project root or above;
// 4. a glob word must start with a fixed folder other than the project root, and no part of it
//    may start with a dot.

import path from 'node:path';
import { resolvePath, isCredentialPath, matchGlob, normalizeRoot } from './paths.js';
import { staticPrefix } from './subject.js';

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'rg', 'grep', 'ls', 'wc', 'nl', 'find', 'sort', 'uniq', 'cut', 'pwd', 'stat', 'file', 'tr']);

/** Options whose next word is a value, not a path (short letters; long names without dashes). */
const VALUE_OPTIONS = {
  head: ['n', 'c', 'lines', 'bytes'],
  tail: ['n', 'c', 'lines', 'bytes'],
  cut: ['d', 'f', 'c', 'b', 'delimiter', 'fields', 'characters', 'bytes', 'output-delimiter'],
  sort: ['k', 't', 'S', 'key', 'field-separator', 'buffer-size'],
  uniq: ['f', 's', 'w', 'skip-fields', 'skip-chars', 'check-chars'],
  nl: ['b', 'd', 'f', 'h', 'i', 'l', 'n', 's', 'v', 'w'],
  rg: ['e', 'g', 't', 'T', 'm', 'A', 'B', 'C', 'M', 'j', 'E', 'r', 'regexp', 'glob', 'iglob', 'type', 'type-not', 'max-count', 'after-context', 'before-context', 'context', 'max-columns', 'threads', 'encoding', 'replace', 'max-depth', 'sort', 'sortr', 'color', 'colors', 'type-add'],
  grep: ['e', 'm', 'A', 'B', 'C', 'regexp', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude', 'exclude-dir', 'color', 'colour', 'label'],
  stat: ['c', 'format', 'printf'],
  ls: ['I', 'w', 'T', 'ignore', 'hide', 'width', 'tabsize', 'color', 'sort', 'time', 'format', 'quoting-style', 'indicator-style', 'block-size', 'time-style'],
  file: ['m', 'e', 'P', 'magic-file', 'exclude', 'parameter'],
  wc: [],
  cat: [],
  tr: [],
  pwd: [],
};
/** Options whose value is a file the command reads. */
const FILE_OPTIONS = new Set(['f', 'file', 'files0-from', 'ignore-file', 'exclude-from', 'include-from', 'random-source']);
/** Options that write, execute or follow forever. */
const REFUSED_OPTIONS = {
  sort: ['o', 'output', 'compress-program', 'T', 'temporary-directory'],
  rg: ['pre', 'pre-glob', 'search-zip', 'z'],
  tail: ['f', 'F', 'follow', 'retry'],
  file: ['C', 'compile'],
};
const FIND_REFUSED = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const FIND_VALUE = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-perm', '-user', '-group', '-printf', '-links', '-inum', '-samefile', '-used', '-uid', '-gid', '-regextype', '-lname', '-ilname']);
const SED_SCRIPT = /^[0-9,$p ;]+$/;

/**
 * Split a command into pipeline stages of words, or null when it uses anything but plain words,
 * quotes and `|`. Each word knows whether an unquoted glob character is in it.
 */
export function splitPipeline(command) {
  const stages = [[]];
  let word = null;
  let glob = false;
  const end = () => { if (word !== null) stages[stages.length - 1].push({ text: word, glob }); word = null; glob = false; };
  const s = String(command);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return null;
      word = (word ?? '') + s.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      const close = s.indexOf('"', i + 1);
      if (close === -1) return null;
      const inner = s.slice(i + 1, close);
      if (/[$`\\]/.test(inner)) return null; // substitution or escapes inside double quotes
      word = (word ?? '') + inner;
      i = close;
    } else if (c === ' ' || c === '\t') {
      end();
    } else if (c === '|') {
      if (s[i + 1] === '|' || s[i + 1] === '&') return null;
      end();
      if (!stages[stages.length - 1].length) return null;
      stages.push([]);
    } else if (/[;&<>`$(){}~#\\\n\r]/.test(c)) {
      return null;
    } else {
      if (/[*?[\]]/.test(c)) glob = true;
      word = (word ?? '') + c;
    }
  }
  end();
  return stages.every((st) => st.length) ? stages : null;
}

/** Split `--name=value` / `-n5` style options; `name` is without dashes. */
function optionParts(text) {
  if (text.startsWith('--')) {
    const eq = text.indexOf('=');
    return eq === -1 ? { long: true, names: [text.slice(2)], value: null } : { long: true, names: [text.slice(2, eq)], value: text.slice(eq + 1) };
  }
  return { long: false, names: [...text.slice(1)], value: null };
}

/**
 * Look at one pipeline stage. Returns the words that are paths, the folders a recursive search
 * starts from, or `{refused}` with a reason.
 */
function analyse(stage, index) {
  const [head, ...args] = stage;
  const name = head.text;
  if (head.glob || !READ_COMMANDS.has(name)) return { refused: `"${name}" is not a read-only command` };
  const paths = [];
  const roots = [];
  const operands = [];
  const refused = new Set(REFUSED_OPTIONS[name] ?? []);
  const takesValue = new Set(VALUE_OPTIONS[name] ?? []);

  if (name === 'find') {
    let i = 0;
    while (i < args.length && !/^[-(!]/.test(args[i].text)) { roots.push(args[i]); paths.push(args[i]); i += 1; }
    if (!roots.length) roots.push({ text: '.', glob: false });
    for (; i < args.length; i += 1) {
      const t = args[i].text;
      if (FIND_REFUSED.test(t)) return { refused: `find ${t} is not allowed` };
      if (FIND_VALUE.has(t)) { if (t === '-newer' || t === '-samefile') paths.push(args[i + 1] ?? { text: '' }); i += 1; }
    }
    return { paths, roots };
  }

  let sedScript = null;
  let sedQuiet = false;
  let patternGiven = false;
  let recursive = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    if (!endOfOptions && w.text === '--') { endOfOptions = true; continue; }
    if (!endOfOptions && w.text.startsWith('-') && w.text !== '-') {
      if (/^-\d+$/.test(w.text) && (name === 'head' || name === 'tail')) continue;
      const { long, names, value } = optionParts(w.text);
      for (let k = 0; k < names.length; k += 1) {
        const opt = names[k];
        if (refused.has(opt)) return { refused: `${name} ${w.text} is not allowed` };
        if (name === 'sed') {
          if (opt === 'n' || opt === 'quiet' || opt === 'silent') { sedQuiet = true; continue; }
          if (['E', 'r', 's', 'u', 'regexp-extended', 'separate', 'unbuffered', 'posix'].includes(opt)) continue;
          if (opt === 'e' || opt === 'expression') {
            if (sedScript !== null) return { refused: 'sed with more than one script' };
            sedScript = value ?? (k === names.length - 1 ? args[++i]?.text : names.slice(k + 1).join(''));
            break;
          }
          return { refused: `sed ${w.text} is not allowed` };
        }
        if ((name === 'rg' || name === 'grep') && ['e', 'regexp', 'f', 'file'].includes(opt)) patternGiven = true;
        if ((name === 'grep' && ['r', 'R', 'recursive', 'dereference-recursive'].includes(opt)) || (name === 'ls' && ['R', 'recursive'].includes(opt))) recursive = true;
        const isFile = FILE_OPTIONS.has(opt) && name !== 'ls' && name !== 'nl' && name !== 'cut' && name !== 'sort' && name !== 'uniq' && name !== 'stat';
        if (isFile || takesValue.has(opt)) {
          const rest = long ? value : names.slice(k + 1).join('');
          const val = rest !== null && rest !== '' ? { text: rest, glob: false } : args[++i];
          if (isFile) paths.push(val ?? { text: '' });
          break;
        }
      }
      continue;
    }
    operands.push(w);
  }

  switch (name) {
    case 'pwd':
      return operands.length ? { refused: 'pwd takes no arguments' } : { paths, roots };
    case 'tr':
      return { paths, roots }; // tr reads only standard input; its arguments are character sets
    case 'sed': {
      if (sedScript === null) sedScript = operands.shift()?.text ?? null;
      if (!sedQuiet || typeof sedScript !== 'string' || !SED_SCRIPT.test(sedScript)) return { refused: 'sed is allowed only as sed -n with a print script such as \'1,80p\'' };
      return { paths: [...paths, ...operands], roots };
    }
    case 'rg':
    case 'grep': {
      if (!patternGiven) operands.shift();
      const searchesTree = name === 'rg' || recursive;
      if (!operands.length && searchesTree && index === 0) roots.push({ text: '.', glob: false });
      if (searchesTree) roots.push(...operands);
      return { paths: [...paths, ...operands], roots };
    }
    case 'ls': {
      const targets = operands.length ? operands : [{ text: '.', glob: false }];
      if (recursive) roots.push(...targets);
      return { paths: [...paths, ...targets], roots };
    }
    case 'uniq':
      if (operands.length > 1) return { refused: 'uniq with an output file is not allowed' };
      return { paths: [...paths, ...operands], roots };
    default:
      return { paths: [...paths, ...operands], roots };
  }
}

/**
 * Decide a sandboxed read-only command, or return null when it is not one (the caller keeps
 * its normal decision).
 * @param {object} compiled the compiled role
 * @param {string} command
 * @param {string} [cwd] where Codex ran it; must be inside the project folder
 * @returns {{effect: 'allow'|'ask'|'deny', rule: string, reason: string}|null}
 */
export function decideSandboxedRead(compiled, command, cwd) {
  const stages = splitPipeline(command);
  if (!stages) return null;
  const where = { project: compiled.project, home: compiled.home };
  const base = resolvePath(typeof cwd === 'string' && cwd ? cwd : normalizeRoot(compiled.project), where);
  if (!base || base.rel === null) return null;
  const analysed = stages.map(analyse);
  if (analysed.some((a) => a.refused)) return null;

  const rawRule = (compiled.rules ?? []).find((r) => r.tool === 'Read' && r.pathGlob === 'raw/**' && r.effect !== 'allow');
  const rawEffect = rawRule ? rawRule.effect : 'allow';
  const deny = (rule, reason) => ({ effect: 'deny', rule, reason });
  let effect = 'allow';
  let reason = 'A read-only command inside Codex\'s read-only sandbox';

  const resolveWord = (w) => {
    const text = w.glob ? staticPrefix(w.text) : w.text;
    const absish = /^(?:\/|~|[A-Za-z]:)/.test(text);
    return resolvePath(absish ? text : path.posix.join(base.abs, text), where);
  };
  for (const a of analysed) {
    for (const w of a.paths) {
      if (w.text === '-') continue; // standard input
      if (isCredentialPath(w.text)) return deny('hard:credentials', 'Credential files are never read');
      if (w.glob) {
        if (w.text.split('/').some((seg) => seg.startsWith('.') && /[*?[\]]/.test(seg))) return deny('sandbox:glob', 'A wildcard may not match hidden files');
        if (w.text.split('/').some((seg) => /^\.[^./]/.test(seg))) return deny('sandbox:glob', 'A wildcard may not match hidden files');
      }
      const r = resolveWord(w);
      if (!r || r.rel === null) return deny('sandbox:outside-project', 'Commands read only inside the project folder');
      if (isCredentialPath(r.abs)) return deny('hard:credentials', 'Credential files are never read');
      if (w.glob && (r.relFold === '' || r.rel === '')) return deny('hard:broad-search', 'A wildcard at the project root could reach raw/ or secret files; pass a narrower path such as outputs/ or sources/');
      if (r.relFold !== null && matchGlob('raw/**', r.relFold, { ignoreCase: true }) && rawEffect !== 'allow') {
        if (rawEffect === 'deny') return deny(`rules[${compiled.rules.indexOf(rawRule)}]`, rawRule.reason);
        effect = 'ask';
        reason = rawRule.reason;
      }
    }
    for (const w of a.roots) {
      const r = resolveWord(w);
      if (!r || r.rel === null) return deny('sandbox:outside-project', 'Commands read only inside the project folder');
      if (r.relFold === '') return deny('hard:broad-search', 'Searching the whole project would also read raw/ and secret files; pass a narrower path such as outputs/ or sources/');
    }
  }
  return { effect, rule: 'sandbox:read-only-command', reason };
}
