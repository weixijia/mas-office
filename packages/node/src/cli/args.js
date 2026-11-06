// A tiny argument parser: positionals, `--name value`, `--name=value`, `--flag`, `--no-flag`.

/** A mistake in how the command was called (exit code 2). */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, 'string'|'boolean'>} spec the options this command accepts
 * @returns {{positionals: string[], options: Record<string, string|boolean>}}
 */
export function parseArgs(argv, spec) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg !== '-') throw new UsageError(`Unknown option ${arg}`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    let negated = false;
    if (!Object.hasOwn(spec, name) && name.startsWith('no-') && spec[name.slice(3)] === 'boolean') {
      name = name.slice(3);
      negated = true;
    }
    const type = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!type) throw new UsageError(`Unknown option --${name}`);
    if (type === 'boolean') {
      if (value !== undefined) throw new UsageError(`--${name} does not take a value`);
      options[name] = !negated;
    } else {
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
        i += 1;
      }
      options[name] = value;
    }
  }
  return { positionals, options };
}

/** Parse a TCP port option (0 = any free port). */
export function parsePort(value, fallback) {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a number from 0 to 65535, got "${value}"`);
  return port;
}
