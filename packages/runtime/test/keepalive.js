// The runtime's timers are unref'd on purpose (a daemon must be able to exit), so a test that
// waits only on such a timer would let the event loop drain. On Node 18 the test runner then
// fails the test instead of waiting. One ref'd interval per test file keeps the loop alive.
import { after } from 'node:test';

const timer = setInterval(() => {}, 1000);
after(() => clearInterval(timer));
