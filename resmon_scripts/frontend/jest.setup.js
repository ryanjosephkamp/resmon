require('@testing-library/jest-dom');

// jsdom does not implement the WHATWG encoding API, but react-router 7 reaches
// for TextEncoder at import time. Provide Node's implementation.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

// jsdom implements no streams either, and the assistant panel reads a turn with
// `fetch` + `response.body.getReader()` — `EventSource` cannot be used because it
// can only issue a GET and a turn carries the message in a body. Node's WHATWG
// implementation is the same shim as TextEncoder above, for the same reason.
const { ReadableStream } = require('stream/web');
if (typeof global.ReadableStream === 'undefined') global.ReadableStream = ReadableStream;

// jsdom implements no layout, so scrollIntoView is absent. LiveActivityLog
// calls it on every render when auto-scroll is on.
if (!window.Element.prototype.scrollIntoView) {
  window.Element.prototype.scrollIntoView = function () {};
}

// The renderer discovers the backend port through the Electron contextBridge.
// Under jsdom there is no bridge, so provide the same shape the preload exposes.
//
// This double used to answer with the number `8742` — two lies at once, and
// both in the direction that hid a defect. The preload exposes a *string*, so
// nothing under test ever met the type the renderer is declared to receive;
// and 8742 is the background daemon's port, so every suite in this directory
// was quietly rehearsing a conversation with the one instance the app must
// never address by accident. An arbitrary ephemeral-range port, as a string, is
// what a real preload hands over.
global.window.resmonAPI = global.window.resmonAPI || {
  getBackendPort: () => '51234',
};
