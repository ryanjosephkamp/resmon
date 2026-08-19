require('@testing-library/jest-dom');

// jsdom does not implement the WHATWG encoding API, but react-router 7 reaches
// for TextEncoder at import time. Provide Node's implementation.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

// jsdom implements no layout, so scrollIntoView is absent. LiveActivityLog
// calls it on every render when auto-scroll is on.
if (!window.Element.prototype.scrollIntoView) {
  window.Element.prototype.scrollIntoView = function () {};
}

// The renderer discovers the backend port through the Electron contextBridge.
// Under jsdom there is no bridge, so provide the same shape the preload exposes.
global.window.resmonAPI = global.window.resmonAPI || {
  getBackendPort: () => 8742,
};
