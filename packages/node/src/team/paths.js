// Pure path, command and URL checks used by the permission compiler and `decideTool`.
// Nothing here touches the filesystem: paths are normalised as strings against the project
// folder, so symlinks are not followed (the backends' own sandboxes cover that case).

import path from 'node:path';
import net from 'node:net';
import { isPrivateAddress, isLocalName } from '../verify/url-health.js';

const posix = path.posix;

/**
 * Turn a glob (`*`, `**`, `?`, `[...]`) into an anchored RegExp. Case-sensitive unless `flags`
 * is `'i'`: deny and ask rules match case-insensitively, because on a case-insensitive disk
 * (macOS, Windows) `RAW/x.pdf` opens `raw/x.pdf`; allow rules keep the exact case.
 */
export function globToRegExp(glob, flags = '') {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length;
      if (atStart && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }
      if (glob[i - 1] === '/' && atEnd) { re = `${re.slice(0, -1)}(?:/.*)?`; i += 1; continue; }
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; continue; }
      re += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
      i = end;
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, flags);
}

export const matchGlob = (glob, rel, { ignoreCase = false } = {}) => globToRegExp(glob, ignoreCase ? 'i' : '').test(rel);

const toSlashes = (p) => p.replace(/\\/g, '/');
const withDriveRoot = (p) => (/^[A-Za-z]:\//.test(p) ? `/${p}` : p);

/** The project folder as a normalised absolute POSIX-style path. */
export function normalizeRoot(dir) {
  return posix.resolve('/', withDriveRoot(toSlashes(String(dir))));
}

const relativeTo = (root, abs) => {
  if (abs === root) return '';
  const prefix = root === '/' ? '/' : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
};

/**
 * Resolve a path the way a tool would see it, relative to the project folder.
 * `~` expands to `home` when known; without it a `~` path counts as outside the project.
 * @returns {{abs: string|null, rel: string|null, relFold: string|null, raw: string}|null} `rel` is
 *   null outside the project (exact case); `relFold` is the same but with the project prefix
 *   compared ignoring case, as a case-insensitive disk would. null for paths no tool could mean
 *   (empty, non-string, NUL bytes).
 */
export function resolvePath(p, { project, home } = {}) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
  const root = normalizeRoot(project);
  let s = toSlashes(p.trim());
  if (s === '~' || s.startsWith('~/')) {
    if (!home) return { abs: null, rel: null, relFold: null, raw: p };
    s = `${normalizeRoot(home)}${s.slice(1)}`;
  } else if (s.startsWith('~')) {
    return { abs: null, rel: null, relFold: null, raw: p }; // ~otheruser/…
  }
  const abs = posix.resolve(root, withDriveRoot(s));
  const rel = relativeTo(root, abs);
  const folded = relativeTo(root.toLowerCase(), abs.toLowerCase());
  const relFold = folded === null ? null : abs.slice(abs.length - folded.length);
  return { abs, rel, relFold, raw: p };
}

const CREDENTIAL_DIRS = new Set(['.ssh', '.claude', '.codex', '.aws', '.gnupg', '.kube', '.docker', '.azure', 'keychains']);
const CREDENTIAL_FILES = new Set(['.claude.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'credentials.json']);
const CREDENTIAL_FILE_RE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain|keychain-db))$/;
const PROTECTED_DIRS = new Set(['.claude', '.codex', '.git', '.agents']);
const PROTECTED_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', 'setup.md', '.mcp.json']);

const segments = (p) => toSlashes(String(p)).toLowerCase().split('/').filter(Boolean);

/**
 * Does a path point at a credential location? Checked on every segment, case-insensitively,
 * so `~/.ssh/x`, `/Users/a/.SSH/x`, `../.claude.json` and `sub/.env.local` all count.
 */
export function isCredentialPath(p) {
  const segs = segments(p);
  if (!segs.length) return false;
  if (segs.slice(0, -1).some((s) => CREDENTIAL_DIRS.has(s))) return true;
  const last = segs[segs.length - 1];
  return CREDENTIAL_DIRS.has(last) || CREDENTIAL_FILES.has(last) || CREDENTIAL_FILE_RE.test(last);
}

/** Instruction, settings and tool-config files no role may write, anywhere, in any letter case. */
export function isProtectedPath(p) {
  const segs = segments(p);
  if (!segs.length) return false;
  if (segs.slice(0, -1).some((s) => PROTECTED_DIRS.has(s))) return true;
  const last = segs[segs.length - 1];
  return PROTECTED_DIRS.has(last) || PROTECTED_FILES.has(last);
}

/**
 * Shell syntax that chains, substitutes or redirects: `;`, `&`, `|`, backticks, `<`, `>`,
 * newlines, `$(` and `${`. A command granted only by prefix must contain none of these.
 */
export const hasShellMeta = (command) => /[;&|`<>\n\r]|\$\(|\$\{/.test(command);

/**
 * What a command granted only by `cli:<prefix>` may not contain, on top of `hasShellMeta`:
 * glob and expansion characters (`* ? [ ] { } ~ $`) and backslashes, so a wildcard such as
 * `cat .en?` cannot reach a file the words of the command do not name.
 */
export const hasPrefixUnsafe = (command) => hasShellMeta(command) || /[*?[\]{}~$\\]/.test(command);

const tokens = (s) => String(s).trim().split(/\s+/).filter(Boolean);

/** Does `command` start with the words of `prefix` (whole words: `git log` does not match `git logs`)? */
export function matchesPrefix(command, prefix) {
  const c = tokens(command);
  const p = tokens(prefix);
  return p.length > 0 && p.length <= c.length && p.every((t, i) => c[i] === t);
}

/** The words of a shell command that could be paths (split on spaces, quotes, `=`, `:` and shell syntax). */
export const commandPathTokens = (command) => String(command)
  .replace(/\$\{?HOME\}?/g, '~')
  .split(/[\s'"=:;|&<>()`,]+/)
  .filter(Boolean);
const pathishTokens = commandPathTokens;

/** Does a shell command mention a credential location anywhere in its words? */
export const commandTouchesCredentials = (command) => pathishTokens(command).some(isCredentialPath);

/** Does a shell command mention an instruction or settings file anywhere in its words? */
export const commandTouchesProtected = (command) => pathishTokens(command).some(isProtectedPath);

/**
 * Does one word of a command name this machine or its network: a blocked URL
 * (`http://127.0.0.1:4747/…`), a bracketed IPv6 literal, `::1`, or a bare `host[:port][/path]`
 * whose host is loopback, private or local (`localhost:4747`, `0.0.0.0`, `10.0.0.5`, `nas.local`)?
 * Plain numbers are not hosts (`git log -n 3`).
 */
export function isBlockedHostToken(token) {
  const t = String(token).replace(/^@/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return isBlockedUrl(t);
  if (/^\[[0-9a-f:.]*\]/i.test(t) || /^::(?:1|ffff:[0-9.]+)?$/i.test(t)) return true;
  const m = /^([a-z0-9.-]+)(?::\d+)?(?:\/.*)?$/i.exec(t);
  if (!m || /^\d+$/.test(m[1]) || !/[.:a-z]/i.test(m[1])) return false;
  if (m[1].split('.').some((label) => !label)) return false; // `.`, `..`, `./x`, `.env`: paths, not hosts
  if (!/[.]/.test(m[1]) && !/^localhost$/i.test(m[1]) && !/:\d+/.test(t)) return false;
  let host;
  try { host = new URL(`http://${t}`).hostname; } catch { return false; }
  return isBlockedUrl(`http://${host.includes(':') ? `[${host}]` : host}/`);
}

/** Does a shell command name this machine or its network anywhere in its words? */
export const commandTouchesLocalHost = (command) => String(command)
  .split(/[\s'"=;|&<>()`,]+/)
  .filter(Boolean)
  .some(isBlockedHostToken);

const isOctet = (l) => /^\d{1,3}$/.test(l) && Number(l) <= 255;

/**
 * Does a host name spell out a non-public IPv4 address, as wildcard-DNS services do:
 * `127.0.0.1.nip.io`, `app.10.0.0.1.sslip.io`, `192-168-1-1.sslip.io`, `www-10-0-0-1.nip.io`?
 */
function embedsPrivateV4(host) {
  const labels = host.split('.');
  for (let i = 0; i + 4 <= labels.length; i += 1) {
    const quad = labels.slice(i, i + 4);
    if (quad.every(isOctet) && isPrivateAddress(quad.join('.'))) return true;
  }
  for (const label of labels) {
    for (const m of label.matchAll(/(?<![0-9])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?![0-9])/g)) {
      const quad = m.slice(1, 5);
      if (quad.every(isOctet) && isPrivateAddress(quad.join('.'))) return true;
    }
  }
  return false;
}

/**
 * URLs a role's web tools must never open: anything that is not http(s); IPv6 literals; IPv4
 * literals in any non-public range; local names (localhost, single labels, `.local`, `.internal`,
 * `.lan`, `.home.arpa`); and names that spell out a non-public IPv4 address (`127.0.0.1.nip.io`).
 * The ranges and local names come from verify/url-health.js (`isPrivateAddress`, `isLocalName`),
 * so there is one list. A string check cannot catch a name that only RESOLVES to a private
 * address (DNS rebinding, a user's own DNS records): the role browser's PAC file and host-resolver
 * rules (kit/.mcp.json) and the URL checker's DNS pinning cover those.
 */
export function isBlockedUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[')) return true; // IPv6 literals: no public site needs one
  if (net.isIPv4(host)) return isPrivateAddress(host);
  return isLocalName(host) || embedsPrivateV4(host);
}
