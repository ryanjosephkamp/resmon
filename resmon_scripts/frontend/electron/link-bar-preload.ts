/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';

// The link window's own bar (`linkBarHtml`): its buttons and address field ask
// the main process to act on the page beside it, and hear what that page is
// doing. Nothing else: no engine, token, or file access. The main process acts
// only for a sender that is a link window's bar.
contextBridge.exposeInMainWorld('linkBar', {
  act: (action: string, text?: string): void => ipcRenderer.send('resmon:link-bar', action, text),
  onState: (listener: (state: unknown) => void): void => {
    ipcRenderer.on('resmon:link-bar-state', (_event, state: unknown) => listener(state));
  },
  onFocusAddress: (listener: () => void): void => {
    ipcRenderer.on('resmon:link-bar-focus', () => listener());
  },
});
