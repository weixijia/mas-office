/* MAS Office site: the copy buttons and the pause control for the live panels.
   The panels are the real panel (office/index.html) in same-origin iframes; nothing here changes the
   panel's own files. Pausing freezes the demo clock and tells the panel its page is hidden, which is
   how the panel itself stops drawing in a background tab. */
import ui from './ui/ui.js';

/* ---------------------------------------------------------------- copy the command */
const live = document.createElement('p');
live.className = 'sr-only';
live.setAttribute('aria-live', 'polite');
document.body.append(live);

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const t = document.createElement('textarea');
  t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.append(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  let timer = 0;
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy;
    const ok = await copy(text);
    live.textContent = ok ? `Copied: ${text}` : `Copy this command: ${text}`;
    if (!ok) return;
    btn.classList.add('is-copied');
    clearTimeout(timer);
    timer = setTimeout(() => btn.classList.remove('is-copied'), 1800);
  });
});

/* ---------------------------------------------------------------- pause a live panel */
function frameControl(getFrame) {
  let paused = false;
  const apply = (f) => {
    if (!f) return;
    let w, d;
    try { w = f.contentWindow; d = f.contentDocument; } catch { return; }
    if (!w || !d || !w.performance) return;
    if (!w.__masClock) {
      const real = w.performance.now.bind(w.performance);
      const clock = { paused: false, at: 0, offset: 0, since: 0 };
      w.performance.now = () => (clock.paused ? clock.at : real() - clock.offset);
      try { Object.defineProperty(d, 'hidden', { configurable: true, get: () => clock.paused }); } catch { /* keep the real flag */ }
      clock.set = (on) => {
        if (on === clock.paused) return;
        if (on) { clock.at = real() - clock.offset; clock.since = real(); }
        else clock.offset += real() - clock.since;
        clock.paused = on;
        d.dispatchEvent(new w.Event('visibilitychange'));
      };
      w.__masClock = clock;
    }
    w.__masClock.set(paused);
  };
  const frames = () => [].concat(getFrame()).filter(Boolean);
  frames().forEach((f) => f.addEventListener('load', () => apply(f)));
  return {
    pause() { paused = true; frames().forEach(apply); },
    resume() { paused = false; frames().forEach(apply); },
  };
}

const phone = matchMedia('(max-width: 639px)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// the hero: the demo run loops; its frame's pause button (shared with the still ground) stops it
const heroWin = document.querySelector('.hero__window');
const heroFrame = heroWin && heroWin.querySelector('iframe');
function styleFrame(frame, css) {
  const apply = () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.head || doc.querySelector('[data-site-embed]')) return;
    const style = doc.createElement('style');
    style.dataset.siteEmbed = '';
    style.textContent = css;
    doc.head.append(style);
    frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('resize'));
  };
  frame.addEventListener('load', apply);
  if (frame.contentDocument?.readyState === 'complete') apply();
}
if (heroFrame) {
  styleFrame(heroFrame, `
      body { height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
      .rule, .status, .side { display: none !important; }
      .sheet, body.sb-closed .sheet { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
      .stage { padding: 8px 16px; overflow: hidden; align-items: center; justify-content: center; }
      .drawing-host { margin-top: 0; flex: none; width: min(100%, calc(100vh * 1.35)); height: calc(100vh - 24px); }
  `);
}
/* Keep the full interactive panel in examples, but give its drawing the remaining frame height.
   The sidebar remains available through the panel's own Title block control on narrow screens. */
document.querySelectorAll('.app-live iframe').forEach((frame) => styleFrame(frame, `
  body { height: 100vh; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; }
  .rule { flex: none; min-height: 40px; padding-block: 8px; }
  .sheet { flex: 1; min-height: 0; }
  .status { display: none; }
  .stage { min-height: 0; padding: 8px 12px; align-items: center; justify-content: center; }
  .drawing-host { margin-top: 0; flex: none; width: min(100%, calc((100vh - 56px) * 1.35)); height: calc(100vh - 56px); }
  @media (max-width: 600px) {
    .sheet { flex: none; }
    .stage { height: calc(100vh - 56px); box-sizing: border-box; }
  }
`));
if (heroWin && heroFrame && !phone && !reduced) ui.pausable(heroWin, frameControl(() => heroFrame));

// the examples: finished runs, whose agents still move about the lounge now and then
const app = document.querySelector('.app-live');
if (app && !reduced) ui.pausable(app, frameControl(() => [...app.querySelectorAll('iframe')]));
