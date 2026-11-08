'use strict';
for (const k of ['dash', 'energy', 'dev', 'auto', 'hist', 'heat', 'car', 'geo', 'where', 'set']) { const p = PAGES[k]; if (p) { delete PAGES[k]; PAGES[k] = p; } }

boot();
