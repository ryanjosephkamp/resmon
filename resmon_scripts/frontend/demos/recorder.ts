/**
 * The recorder: one real resmon, launched over a copy of the demo collection,
 * driven at a person's pace and filmed frame by frame.
 *
 * **Isolation.** Each recording copies the collection `build_collection.py`
 * made into a fresh temporary folder and launches the app over the copy with
 * the e2e suite's own environment (`launchEnv`): its own state directory,
 * database, reports, port file and Chromium profile, the null keyring, and no
 * AI command. A startup hook in the engine refuses any connection to the
 * background service's port. Everything else on the network is allowed,
 * because a Deep Dive in a demo asks the real sources.
 *
 * **Filming.** Chromium's screencast hands over a frame each time the window
 * repaints, at the window's device pixels, with the moment it was drawn. The
 * frames are kept as they come and `media.ts` lays them on a 30 fps timeline
 * from those moments, so a still screen costs one frame and a moving one is
 * shown as fast as it really moved. Marks name moments on the same clock: where
 * the title card ends, where the demo ends, the still the Tutorials page shows,
 * and stretches to play faster.
 *
 * **The pointer and the keys.** A screencast has no pointer, so one is drawn in
 * the page, on top of everything including open dialogs, and follows the real
 * input events the steps send. A chord pressed is shown as keycaps at the
 * bottom of the window, since a recording cannot show a keyboard.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, type CDPSession, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, WINDOW_HEIGHT, WINDOW_WIDTH, launchEnv, registerStateDir } from '../e2e/fixtures/resmon-app';
import { collectionDir, outputDir } from './paths';
import type { DemoTitle } from './titles';

/** The background service's port, which nothing here may reach. */
const SERVICE_PORT = 8742;

export interface Mark { name: string; t: number; speed?: number }

/**
 * The page-side half: the pointer, the click ring, the keycaps, and the title
 * card, in one popover that is raised above anything else in the top layer
 * whenever a dialog or popover opens.
 */
const OVERLAY = String.raw`(() => {
  if (window.__demo) return;
  const ARROW = '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 3.2v16.1l4.1-3.9 2.6 6.1 2.9-1.2-2.6-6h5.8z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const state = { layer: null, cursor: null, keys: null, card: null, x: -60, y: -60 };
  window.__demo = state;
  const css = '#demo-layer{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;color:var(--ink)}'
    + '#demo-layer::backdrop{display:none}'
    + '#demo-cursor{position:absolute;left:0;top:0;width:24px;height:24px;margin:-3px 0 0 -5px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35));will-change:transform}'
    + '.demo-ring{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid var(--accent-mark,#ff8a3d);background:color-mix(in srgb,var(--accent-mark,#ff8a3d) 18%,transparent);animation:demo-ring 520ms cubic-bezier(.16,1,.3,1) forwards}'
    + '@keyframes demo-ring{from{transform:scale(.35);opacity:1}to{transform:scale(1.15);opacity:0}}'
    + '#demo-keys{position:absolute;left:50%;bottom:34px;display:flex;gap:8px;transform:translateX(-50%) translateY(12px);opacity:0;transition:opacity 160ms ease,transform 260ms cubic-bezier(.16,1,.3,1)}'
    + '#demo-keys.on{opacity:1;transform:translateX(-50%)}'
    + '#demo-keys span{min-width:46px;height:46px;padding:0 13px;display:grid;place-items:center;border-radius:10px;font:560 21px/1 var(--sans);color:var(--ink);background:var(--raise);border:1px solid var(--rule-2);box-shadow:0 2px 0 var(--rule-2),var(--shadow)}'
    + '#demo-keys em{align-self:center;font:italic 400 17px/1 var(--serif);color:var(--ink-2);margin-left:6px}'
    + '#demo-keys em:only-child{margin:0;padding:14px 18px;border-radius:10px;background:var(--raise);border:1px solid var(--rule-2);box-shadow:var(--shadow);color:var(--ink);font-size:19px}'
    + '#demo-fast{position:absolute;left:20px;bottom:20px;padding:7px 11px;border-radius:8px;font:500 13px/1 var(--mono);color:var(--ink-2);background:var(--raise);border:1px solid var(--rule-2);opacity:0;transition:opacity 160ms ease}'
    + '#demo-fast.on{opacity:1}'
    + '#demo-card{position:absolute;inset:0;display:grid;place-items:center;background:var(--ground);opacity:0;transition:opacity 380ms ease}'
    + '#demo-card.on{opacity:1}'
    + '#demo-card.on~#demo-cursor{opacity:0}'
    + '#demo-cursor{transition:opacity 200ms ease}'
    + '#demo-card .plate{position:absolute;inset:0;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:72px 72px;background-position:center;opacity:.9;-webkit-mask-image:radial-gradient(ellipse 60% 55% at 50% 50%,#000 30%,transparent 100%)}'
    + '#demo-card .copy{position:relative;width:min(900px,80vw)}'
    + '#demo-card .eyebrow{display:flex;align-items:center;gap:12px;font:500 14px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}'
    + '#demo-card .eyebrow b{font-weight:600;color:var(--ink);letter-spacing:.02em;text-transform:none;font-family:var(--sans);font-size:16px}'
    + '#demo-card .eyebrow i{width:7px;height:7px;border-radius:50%;background:var(--accent-mark)}'
    + '#demo-card h1{margin:26px 0 0;font:620 76px/1.02 var(--sans);letter-spacing:-.03em;color:var(--ink)}'
    + '#demo-card p{margin:20px 0 0;font:italic 400 28px/1.3 var(--serif);color:var(--ink-2);max-width:780px}'
    + '#demo-card .rule{margin-top:34px;width:64px;height:3px;border-radius:2px;background:var(--accent-mark)}';
  const install = () => {
    if (state.layer || !document.body) return;
    // A constructed sheet: the page's policy refuses a <style> element, and rightly.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const layer = document.createElement('div');
    layer.id = 'demo-layer';
    layer.setAttribute('popover', 'manual');
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '<div id="demo-card"></div><div id="demo-keys"></div><div id="demo-fast"></div><div id="demo-cursor">' + ARROW + '</div>';
    document.body.appendChild(layer);
    state.layer = layer;
    state.cursor = layer.querySelector('#demo-cursor');
    state.keys = layer.querySelector('#demo-keys');
    state.card = layer.querySelector('#demo-card');
    state.cursor.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)';
    layer.showPopover();
    // Anything that enters the top layer after the pointer would cover it: raise it again.
    const raise = () => { if (layer.matches(':popover-open')) layer.hidePopover(); layer.showPopover(); };
    new MutationObserver((records) => {
      if (records.some((r) => r.target !== layer && (r.attributeName === 'open' || r.type === 'childList'))) raise();
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });
    document.addEventListener('toggle', (e) => { if (e.target !== layer && e.newState === 'open') raise(); }, true);
  };
  window.__demoRaise = () => { const l = state.layer; if (l) { if (l.matches(':popover-open')) l.hidePopover(); l.showPopover(); } };
  document.addEventListener('mousemove', (e) => {
    state.x = e.clientX; state.y = e.clientY;
    if (state.cursor) state.cursor.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (!state.layer) return;
    const ring = document.createElement('div');
    ring.className = 'demo-ring';
    ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
    state.layer.appendChild(ring);
    setTimeout(() => ring.remove(), 600);
  }, true);
  window.__demoKeys = (caps, note) => {
    if (!state.keys) return;
    state.keys.innerHTML = caps.map((c) => '<span>' + c + '</span>').join('') + (note ? '<em>' + note + '</em>' : '');
    state.keys.classList.add('on');
    clearTimeout(state.keysTimer);
    state.keysTimer = setTimeout(() => state.keys.classList.remove('on'), 1300);
  };
  window.__demoFast = (text) => {
    const chip = state.layer && state.layer.querySelector('#demo-fast');
    if (!chip) return;
    if (text) chip.textContent = text;
    chip.classList.toggle('on', !!text);
  };
  window.__demoCard = (html) => {
    if (!state.card) return;
    if (html) { state.card.innerHTML = '<div class="plate"></div><div class="copy">' + html + '</div>'; state.card.classList.add('on'); }
    else state.card.classList.remove('on');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();`;

/** A startup hook for the engine: the background service's port is refused, everything else is left alone. */
function serviceGuard(dir: string): string {
  const hook = path.join(dir, 'python-hook');
  fs.mkdirSync(hook, { recursive: true });
  fs.writeFileSync(path.join(hook, 'sitecustomize.py'), [
    'import ipaddress, socket',
    '_connect = socket.socket.connect',
    'def _guarded(self, address):',
    '    if isinstance(address, tuple) and len(address) >= 2 and address[1] == ' + SERVICE_PORT + ':',
    '        host = address[0]',
    '        try:',
    '            local = ipaddress.ip_address(host).is_loopback',
    '        except ValueError:',
    '            local = host == "localhost"',
    '        if local:',
    '            raise OSError("the demo engine never reaches the background service")',
    '    return _connect(self, address)',
    'socket.socket.connect = _guarded',
    '',
  ].join('\n'));
  return hook;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A human's easing: quick to start, slow to arrive. */
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export class Demo {
  readonly marks: Mark[] = [];
  private frames: { file: string; t: number }[] = [];
  private writes: Promise<void>[] = [];
  private cdp: CDPSession | null = null;
  private x = WINDOW_WIDTH * 0.62;
  private y = WINDOW_HEIGHT * 0.55;
  private stopped = 0;
  private theme: 'light' | 'dark' = 'light';

  private constructor(
    readonly title: DemoTitle,
    readonly app: ElectronApplication,
    readonly win: Page,
    readonly root: string,
    private readonly framesDir: string,
  ) {}

  /** Copy the collection, launch resmon over the copy, and wait for Atlas to draw. */
  static async open(title: DemoTitle, options: { theme?: 'light' | 'dark' } = {}): Promise<Demo> {
    const source = collectionDir();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `resmon-demo-${title.slug}-`)));
    fs.cpSync(source, root, { recursive: true });
    const stateDir = path.join(root, 'state');
    const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
    env.PYTHONPATH = [serviceGuard(root), env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    // The copy's library is its own, wherever the collection was built, and the theme is the recording's.
    const library = path.join(root, 'library');
    const vault = fs.existsSync(library) ? fs.readdirSync(library).find((name) => name.startsWith('resmon-library-')) : undefined;
    execFileSync(env.RESMON_PYTHON, ['-c', [
      'import sqlite3, sys',
      'conn = sqlite3.connect(sys.argv[1])',
      'if sys.argv[2]: conn.execute("UPDATE library_vault SET root_path = ?", (sys.argv[2],))',
      'conn.execute("INSERT INTO app_settings (key, value) VALUES (\'ui_theme\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (sys.argv[3],))',
      'conn.commit()',
    ].join('\n'), path.join(stateDir, 'resmon.db'), vault ? path.join(library, vault) : '', options.theme ?? 'light']);
    registerStateDir(stateDir);
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
    });
    await app.context().addInitScript(OVERLAY);
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.evaluate(OVERLAY);
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    if (Number(port) === SERVICE_PORT) throw new Error('The demo reached the background service');
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    const framesDir = path.join(root, 'frames');
    fs.mkdirSync(framesDir);
    const made = new Demo(title, app, win, root, framesDir);
    made.theme = options.theme ?? 'light';
    return made;
  }

  /** Start filming. Frames before this are not kept. */
  async roll(): Promise<void> {
    this.cdp = await this.win.context().newCDPSession(this.win);
    this.cdp.on('Page.screencastFrame', (frame) => {
      const t = frame.metadata.timestamp ?? Date.now() / 1000;
      const file = path.join(this.framesDir, `f${String(this.frames.length).padStart(6, '0')}.jpg`);
      this.frames.push({ file, t });
      this.writes.push(fs.promises.writeFile(file, Buffer.from(frame.data, 'base64')));
      void this.cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 2 * WINDOW_WIDTH, maxHeight: 2 * WINDOW_HEIGHT });
    await this.hold(400);
  }

  /** The moment the Tutorials page's still is taken from; the take's last frame without one. */
  still(): void {
    this.mark('still');
  }

  /** Name this moment on the film's clock. */
  mark(name: string, speed?: number): void {
    this.marks.push({ name, t: Date.now() / 1000, ...(speed ? { speed } : {}) });
  }

  /**
   * Play what happens inside `step` `speed` times faster: a wait on the
   * network, never a person's own movement. The film says so while it lasts.
   */
  async faster<T>(speed: number, step: () => Promise<T>): Promise<T> {
    const chip = (text: string | null) => this.win.evaluate((t) => (window as unknown as { __demoFast(t: string | null): void }).__demoFast(t), text);
    await chip(`Waiting, shown ${speed}× faster`);
    await sleep(200);
    this.mark('fast', speed);
    try {
      return await step();
    } finally {
      this.mark('normal');
      await chip(null);
    }
  }

  /**
   * The title card, in Atlas's own type and colors: two seconds from the moment
   * it is fully up to the moment it has lifted. The video starts at `title`;
   * the GIF at `demo`, once the card is gone.
   */
  async titleCard(): Promise<void> {
    const t = this.title;
    const html = `<div class="eyebrow"><b>resmon</b><i></i><span>Atlas · ${t.number} of 7</span></div>`
      + `<h1>${t.title}</h1><p>${t.line}</p><div class="rule"></div>`;
    await this.win.evaluate((h) => (window as unknown as { __demoCard(h: string): void }).__demoCard(h), html);
    await sleep(600);
    this.mark('title');
    await sleep(1600);
    await this.win.evaluate(() => (window as unknown as { __demoCard(h: string | null): void }).__demoCard(null));
    await sleep(400);
    this.mark('demo');
  }

  async hold(ms: number): Promise<void> { await sleep(ms); }

  /** Glide the pointer to a point, as a hand moves a mouse. */
  async glide(x: number, y: number, ms?: number): Promise<void> {
    const distance = Math.hypot(x - this.x, y - this.y);
    const duration = ms ?? Math.min(720, 220 + distance * 0.6);
    const steps = Math.max(8, Math.round(duration / 16));
    const fromX = this.x, fromY = this.y;
    // A slight arc, as a wrist makes.
    const bow = Math.min(40, distance * 0.08) * (fromX < x ? 1 : -1);
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      const arc = Math.sin(Math.PI * k) * bow;
      await this.win.mouse.move(fromX + (x - fromX) * k, fromY + (y - fromY) * k - arc);
      await sleep(duration / steps);
    }
    this.x = x;
    this.y = y;
  }

  /**
   * Bring an element into view the way a person does, with the wheel over the
   * box that scrolls it, rather than the jump a script makes.
   */
  async reveal(target: Locator): Promise<void> {
    await target.waitFor({ state: 'visible' });
    // Where it was before the last turn of the wheel: a turn that moves nothing ends it.
    let moved: number | null = null;
    for (let i = 0; i < 24; i++) {
      const at = await target.evaluate((el) => {
        let box: HTMLElement | null = el.parentElement;
        while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) {
          box = box.parentElement;
        }
        const r = el.getBoundingClientRect();
        const v = box ? box.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
        const top = Math.max(v.top, 0), bottom = Math.min(v.bottom, innerHeight);
        return { top: r.top, bottom: r.bottom, viewTop: top, viewBottom: bottom, left: v.left, right: v.right };
      });
      // In view with a little room is enough; a person does not center things.
      const margin = 24;
      let dy = 0;
      if (at.bottom > at.viewBottom - 4) dy = Math.min(at.bottom - (at.viewBottom - margin), at.top - (at.viewTop + margin));
      else if (at.top < at.viewTop + 4) dy = at.top - (at.viewTop + margin);
      if (Math.abs(dy) < 4 || (moved !== null && Math.abs(moved - at.top) < 1)) return;
      moved = at.top;
      // The wheel goes to what is under the pointer, and a map takes it as a zoom,
      // so the pointer rests near the box's left edge, where pages keep a margin.
      const inside = this.x > at.left && this.x < at.left + 60 && this.y > at.viewTop && this.y < at.viewBottom;
      if (!inside) await this.glide(at.left + 30, (at.viewTop + at.viewBottom) / 2);
      await this.wheel(Math.max(-520, Math.min(520, dy)), 10);
      await sleep(140);
    }
  }

  /** The point of an element a person would aim for: a little left of center for wide things. */
  async aim(target: Locator, at?: { x: number; y: number }): Promise<{ x: number; y: number }> {
    await this.reveal(target);
    const box = await target.boundingBox();
    if (!box) throw new Error(`Nothing to aim at: ${target}`);
    if (at) return { x: box.x + at.x, y: box.y + at.y };
    const x = box.x + Math.min(box.width / 2, Math.max(14, box.width * 0.4));
    return { x, y: box.y + box.height / 2 };
  }

  async hover(target: Locator, at?: { x: number; y: number }): Promise<void> {
    const point = await this.aim(target, at);
    await this.glide(point.x, point.y);
  }

  /** Move to an element, settle, and click it. */
  async click(target: Locator, at?: { x: number; y: number }): Promise<void> {
    await this.hover(target, at);
    await sleep(120);
    await this.win.mouse.down();
    await sleep(70);
    await this.win.mouse.up();
    await sleep(170);
  }

  /** Click at a point in the window. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.glide(x, y);
    await sleep(120);
    await this.win.mouse.down();
    await sleep(70);
    await this.win.mouse.up();
    await sleep(170);
  }

  /** Type as a person does: a key at a time, at reading speed. */
  async type(text: string): Promise<void> {
    for (const ch of text) {
      await this.win.keyboard.type(ch);
      await sleep(ch === ' ' ? 100 : 55 + Math.round(Math.random() * 45));
    }
  }

  /** Press a chord, showing it as keycaps: `press('Meta+Shift+D', ['⇧', '⌘', 'D'])`. */
  async press(chord: string, caps: string[], note?: string): Promise<void> {
    await this.win.evaluate(([c, n]) => (window as unknown as { __demoKeys(c: string[], n?: string): void }).__demoKeys(c as string[], n as string | undefined), [caps, note] as const);
    await sleep(380);
    await this.win.keyboard.press(chord);
    await sleep(300);
  }

  /** A gesture a recording cannot show, named as keycaps are: `caption('Two-finger swipe')`. */
  async caption(note: string): Promise<void> {
    await this.win.evaluate((n) => (window as unknown as { __demoKeys(c: string[], n?: string): void }).__demoKeys([], n), note);
  }

  /** Scroll the wheel over a point, in small human steps. */
  async wheel(dy: number, steps = 12, dx = 0): Promise<void> {
    for (let i = 0; i < steps; i++) {
      await this.win.mouse.wheel(dx / steps, dy / steps);
      await sleep(28);
    }
  }

  /** Stop filming and write the frames' timeline beside them. */
  async cut(): Promise<string> {
    this.mark('end');
    await sleep(300);
    this.stopped = Date.now() / 1000;
    await this.cdp?.send('Page.stopScreencast').catch(() => undefined);
    await Promise.all(this.writes);
    const take = path.join(outputDir(), 'takes', this.title.slug);
    fs.rmSync(take, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(take), { recursive: true });
    fs.renameSync(this.framesDir, take);
    const frames = this.frames.map((f) => ({ file: path.basename(f.file), t: f.t }));
    fs.writeFileSync(path.join(take, 'take.json'), JSON.stringify({
      title: this.title, theme: this.theme, frames, marks: this.marks, stopped: this.stopped,
      window: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    }, null, 2));
    return take;
  }

  /** Close the app and remove the copy of the collection. */
  async close(): Promise<void> {
    await this.app.close().catch(() => undefined);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
