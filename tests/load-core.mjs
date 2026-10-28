import { readFileSync } from 'node:fs';

// core.js is a classic script (it gets inlined into index.html), so evaluate it
// the same way and hand back the TimesheetCore it defines.
const source = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');

export const loadCore = () => new Function(`${source}\nreturn TimesheetCore;`)();
