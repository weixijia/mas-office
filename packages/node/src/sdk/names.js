// Names that end up in file paths. Both patterns come from the spec (§1, §2.1).

/** A project folder: lowercase letters, digits and dashes, 1–40 characters. */
export const FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An agent id. `lead` is the lead's id; role ids must not be `lead`. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const isValidFolder = (name) => typeof name === 'string' && FOLDER_PATTERN.test(name);

export const isValidAgentId = (id) => typeof id === 'string' && AGENT_ID_PATTERN.test(id);

export function assertFolder(name) {
  if (!isValidFolder(name)) {
    throw new TypeError(`Invalid project folder ${JSON.stringify(name)}: use 1–40 lowercase letters, digits or dashes, starting with a letter or digit.`);
  }
}

/**
 * Turn any string into a valid role id (e.g. a framework's agent id).
 * Never returns `lead`, so a foreign agent cannot impersonate the lead.
 */
export function sanitizeId(value, fallback = 'agent') {
  const id = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (!id) return fallback;
  return id === 'lead' ? 'lead-agent' : id;
}
