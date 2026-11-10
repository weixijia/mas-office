// A small newline-delimited JSON-RPC 2.0 peer over a pair of streams (a child's stdio).
//
// - Outgoing requests get integer ids, an optional timeout, and settle exactly once.
// - Incoming requests are answered by `onRequest`; a handler that throws becomes a JSON-RPC
//   error response, and a missing handler answers "method not found". Nothing is left hanging.
// - Incoming notifications go to `onNotification`.
// - Lines that are not JSON objects are skipped (reported through `onProtocolError`).
// - `close()` (or the input ending) rejects every pending request.
//
// Codex app-server omits the `"jsonrpc": "2.0"` member on the wire; `jsonrpcHeader: false`
// (the default here) matches that. Incoming messages are accepted with or without it.

import { StringDecoder } from 'node:string_decoder';

export class JsonRpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * Sentinel an `onRequest` handler may return to send no response at all, for a request the
 * other side has already cleared (Codex: `serverRequest/resolved` arrived first).
 */
export const NO_RESPONSE = Symbol('no-response');

export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

/**
 * @typedef {object} JsonRpcPeerOptions
 * @property {NodeJS.ReadableStream} input stream the peer reads (e.g. child.stdout)
 * @property {NodeJS.WritableStream} output stream the peer writes (e.g. child.stdin)
 * @property {(method: string, params: any, id: string | number) => unknown | Promise<unknown>} [onRequest]
 * @property {(method: string, params: any) => void} [onNotification]
 * @property {(reason: string) => void} [onClose] called once when the peer closes
 * @property {(problem: string, line?: string) => void} [onProtocolError]
 * @property {number} [requestTimeoutMs] default timeout for outgoing requests; 0 disables (default 60000)
 * @property {boolean} [jsonrpcHeader] write `"jsonrpc": "2.0"` on every message (default false)
 */

export class JsonRpcPeer {
  /** @param {JsonRpcPeerOptions} options */
  constructor(options) {
    this.input = options.input;
    this.output = options.output;
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
    this.onClose = options.onClose;
    this.onProtocolError = options.onProtocolError;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.jsonrpcHeader = options.jsonrpcHeader ?? false;
    this.nextId = 1;
    /** @type {Map<number, {method: string, resolve: (v: any) => void, reject: (e: Error) => void, timer?: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.closed = false;
    this.closeReason = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');

    this.onData = (chunk) => this.receive(chunk);
    this.onEnd = () => this.close('input ended');
    this.onInputError = (error) => this.close(`input error: ${error.message}`);
    this.onOutputError = (error) => this.close(`output error: ${error.message}`);
    this.input.on('data', this.onData);
    this.input.on('end', this.onEnd);
    this.input.on('close', this.onEnd);
    this.input.on('error', this.onInputError);
    this.output.on('error', this.onOutputError);
  }

  /**
   * Send a request and resolve with its result. Rejects with a JsonRpcError for an error
   * response, or a plain Error on timeout or close.
   * @param {string} method
   * @param {unknown} [params]
   * @param {{timeoutMs?: number}} [options]
   */
  request(method, params, options = {}) {
    if (this.closed) return Promise.reject(new Error(`JSON-RPC peer closed (${this.closeReason}); cannot send ${method}`));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, timer: undefined };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      const message = params === undefined ? { id, method } : { id, method, params };
      if (!this.write(message)) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error(`JSON-RPC peer closed (${this.closeReason}); cannot send ${method}`));
      }
    });
  }

  /**
   * Send a notification (no response expected). Returns false when the peer is closed.
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    return this.write(params === undefined ? { method } : { method, params });
  }

  /**
   * Close the peer: detach from the streams and reject every pending request. Idempotent.
   * @param {string} [reason]
   */
  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.input.off('close', this.onEnd);
    this.input.off('error', this.onInputError);
    // Keep a no-op error listener so a late EPIPE on a dying child cannot crash the process.
    this.output.off('error', this.onOutputError);
    this.output.on('error', () => {});
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`JSON-RPC peer closed (${reason}) before ${entry.method} answered`));
    }
    this.onClose?.(reason);
  }

  /** @param {object} message */
  write(message) {
    if (this.closed) return false;
    const body = this.jsonrpcHeader ? { jsonrpc: '2.0', ...message } : message;
    try {
      this.output.write(`${JSON.stringify(body)}\n`);
      return true;
    } catch (error) {
      this.close(`write failed: ${/** @type {Error} */ (error).message}`);
      return false;
    }
  }

  /** @param {Buffer | string} chunk */
  receive(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      if (this.closed) return;
    }
  }

  /** @param {string} line */
  dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onProtocolError?.('malformed JSON line skipped', line);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.onProtocolError?.('non-object message skipped', line);
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) this.handleRequest(message.method, message.params, message.id);
      else this.handleNotification(message.method, message.params);
      return;
    }
    if (hasId && ('result' in message || 'error' in message)) {
      this.handleResponse(message);
      return;
    }
    this.onProtocolError?.('unrecognised message skipped', line);
  }

  /** @param {{id: any, result?: any, error?: any}} message */
  handleResponse(message) {
    const entry = this.pending.get(message.id);
    if (!entry) {
      this.onProtocolError?.(`response for unknown id ${JSON.stringify(message.id)} skipped`);
      return;
    }
    this.pending.delete(message.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) {
      const { code = ErrorCodes.internalError, message: text = 'Unknown error', data } = message.error;
      entry.reject(new JsonRpcError(code, text, data));
    } else {
      entry.resolve(message.result);
    }
  }

  /**
   * @param {string} method
   * @param {any} params
   */
  handleNotification(method, params) {
    try {
      this.onNotification?.(method, params);
    } catch (error) {
      this.onProtocolError?.(`notification handler for ${method} threw: ${/** @type {Error} */ (error).message}`);
    }
  }

  /**
   * @param {string} method
   * @param {any} params
   * @param {string | number} id
   */
  async handleRequest(method, params, id) {
    if (!this.onRequest) {
      this.write({ id, error: { code: ErrorCodes.methodNotFound, message: `Method not found: ${method}` } });
      return;
    }
    let response;
    try {
      const result = await this.onRequest(method, params, id);
      if (result === NO_RESPONSE) return;
      response = { id, result: result === undefined ? null : result };
    } catch (error) {
      const err = /** @type {any} */ (error);
      const code = err instanceof JsonRpcError ? err.code : ErrorCodes.internalError;
      response = { id, error: { code, message: String(err?.message ?? err) } };
      if (err instanceof JsonRpcError && err.data !== undefined) response.error.data = err.data;
    }
    this.write(response);
  }
}
