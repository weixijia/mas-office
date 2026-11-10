// A minimal pushable async iterable: values pushed before anyone reads are buffered,
// readers waiting on an empty buffer are woken by the next push, and end() finishes
// the stream for every reader once the buffer has drained.

/**
 * @template T
 * @typedef {object} Pushable
 * @property {(value: T) => boolean} push append a value; false (and dropped) after end()
 * @property {() => void} end finish the stream; buffered values are still delivered
 * @property {boolean} ended
 * @property {() => AsyncIterator<T>} [Symbol.asyncIterator]
 */

/**
 * @template T
 * @returns {Pushable<T>}
 */
export function createPushable() {
  /** @type {T[]} */
  const buffer = [];
  /** @type {((result: IteratorResult<T>) => void)[]} */
  const waiters = [];
  let ended = false;

  const end = () => {
    if (ended) return;
    ended = true;
    while (waiters.length) waiters.shift()({ value: undefined, done: true });
  };

  return {
    push(value) {
      if (ended) return false;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else buffer.push(value);
      return true;
    },
    end,
    get ended() {
      return ended;
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() {
          end();
          buffer.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
