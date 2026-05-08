// MOCK_DATA is populated asynchronously by api-client.js, so D must read
// live from window each access — Proxy handles that transparently.
export const D = new Proxy({}, { get: (_, k) => (window.MOCK_DATA || {})[k] });
