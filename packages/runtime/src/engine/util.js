// Small helpers for the engine: JSON out of model text, a semaphore, timeouts, path shortening.

import os from 'node:os';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The last JSON object in a model's message: the last fenced ```json block that parses to an
 * object, else the last balanced top-level `{…}` that parses. Returns null when there is none.
 * Linear in the text length for the scan; never throws.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(fences[i][1]);
      if (isObject(value)) return value;
    } catch { /* try the next one */ }
  }
  // Scan backwards for a closing brace and find its opening partner, respecting strings.
  let end = text.lastIndexOf('}');
  let attempts = 0;
  while (end !== -1 && attempts < 8) {
    attempts += 1;
    const start = matchingOpen(text, end);
    if (start !== -1) {
      try {
        const value = JSON.parse(text.slice(start, end + 1));
        if (isObject(value)) return value;
      } catch { /* not JSON */ }
    }
    end = text.lastIndexOf('}', end - 1);
  }
  return null;
}

// Index of the `{` that opens the object closed at `end`, or -1: one forward walk over the last
// 200 000 characters, tracking brace depth and skipping braces inside JSON strings. A window that
// starts inside a string can misjudge; the caller then tries the previous closing brace.
function matchingOpen(text, end) {
  const stack = [];
  let inString = false;
  let escaped = false;
  const from = Math.max(0, end - 200_000); // a result object is never larger than this
  for (let i = from; i <= end; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      stack.push(i);
    } else if (ch === '}') {
      const open = stack.pop();
      if (i === end) return open ?? -1;
    }
  }
  return -1;
}

/** At most `limit` tasks at once; `run(fn)` resolves with fn's result. */
export function semaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return {
    run: (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    }),
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}

/** Resolve with `promise`, or with `onTimeout()` after `ms`. The timer never keeps the process alive. */
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Replace the user's home folder with `~` so transcripts and events do not carry it. */
export function shortenHome(text, home = os.homedir()) {
  if (typeof text !== 'string' || !home || home === '/') return text;
  return text.split(home).join('~');
}

/** `shortenHome` applied to every string inside a JSON value. */
export function shortenHomeDeep(value, home = os.homedir()) {
  if (typeof value === 'string') return shortenHome(value, home);
  if (Array.isArray(value)) return value.map((v) => shortenHomeDeep(v, home));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenHomeDeep(v, home)]));
  return value;
}

/** One line, at most `max` characters, for `say` and titles. */
export function oneLine(text, max = 120) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

let counter = 0;
/** A short id, unique within this process and unlikely to collide across restarts. */
export function shortId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
