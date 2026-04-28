// app.js — module entry point. Re-exports the public API consumed by /web/routes/*
// and kicks off boot. Implementation lives in /web/core/.

export { $, $$ } from '/web/core/dom.js';
export { fmt } from '/web/core/format.js';
export { api, state } from '/web/core/api.js';

import { boot } from '/web/core/shell.js';

boot();
