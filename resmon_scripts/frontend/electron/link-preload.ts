/// <reference lib="dom" />
import { ipcRenderer } from 'electron';

// A remote page gets no bridge, token, or synchronous IPC. This listener can
// ask only for history navigation in its own window.
let enabled = false;
const readSetting = () => {
  void ipcRenderer.invoke('resmon:link-history', 'enabled').then(value => { enabled = value === true; }, () => undefined);
};
readSetting();
window.addEventListener('focus', readSetting);
let last = 0;
let dx = 0;
let dy = 0;
let phase: 'judging' | 'tracking' | 'spent' = 'judging';
window.addEventListener('wheel', (event: WheelEvent) => {
  if (!enabled) return;
  if (event.timeStamp - last > 220) { dx = 0; dy = 0; phase = 'judging'; }
  last = event.timeStamp;
  if (phase === 'spent') return;
  if (event.ctrlKey || event.deltaMode !== 0) { phase = 'spent'; return; }
  dx += event.deltaX;
  dy += event.deltaY;
  if (phase === 'judging') {
    if (Math.abs(dx) + Math.abs(dy) < 12) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.6) { phase = 'spent'; return; }
    for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const editing = node.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      const scrolls = /(auto|scroll)/.test(style.overflowX) || node === document.scrollingElement;
      const room = dx < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
      if (editing || style.touchAction === 'none' || (scrolls && room)) { phase = 'spent'; return; }
    }
    phase = 'tracking';
  }
  if (Math.abs(dx) < 150) return;
  phase = 'spent';
  void ipcRenderer.invoke('resmon:link-history', dx < 0 ? 'back' : 'forward').catch(() => undefined);
}, { passive: true });
