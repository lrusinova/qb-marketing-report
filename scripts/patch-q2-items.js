// patch-q2-items.js — append specific items to existing q2deliverables in index.html
// Usage: node scripts/patch-q2-items.js
const fs   = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'marketing-report', 'index.html');
const ROOT_PATH = path.resolve(__dirname, '..', 'index.html');

const ADD = [
  { key: 'MKT-9862', title: 'P3: Speaker Comms',                                                       ch: 'Events & Experiences', bu: 'Cross-BU', label: '', owner: 'Klein, Lilly', type: 'Task', doneDate: 'May 14 2026' },
  { key: 'MKT-9870', title: 'P3: Dry Runs Completed',                                                  ch: 'Events & Experiences', bu: 'Cross-BU', label: '', owner: 'Klein, Lilly', type: 'Task', doneDate: 'May 8 2026'  },
  { key: 'MKT-9873', title: 'P3: Collect Final Presentation Decks',                                     ch: 'Events & Experiences', bu: 'Cross-BU', label: '', owner: 'Klein, Lilly', type: 'Task', doneDate: 'May 14 2026' },
  { key: 'MKT-9977', title: 'P3: Deliver Breakout Room Assignment to Marriott for digital signage',     ch: 'Events & Experiences', bu: 'Cross-BU', label: '', owner: 'Klein, Lilly', type: 'Task', doneDate: 'May 14 2026' },
  { key: 'MKT-9980', title: 'P3: Swag Exploration',                                                    ch: 'Events & Experiences', bu: 'Cross-BU', label: '', owner: 'Klein, Lilly', type: 'Task', doneDate: 'May 5 2026'  },
];

const monthMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function parseD(s) {
  if (!s) return null;
  const p = s.trim().split(' ');
  if (p.length < 3) return null;
  const mo = monthMap[p[0]];
  if (mo === undefined) return null;
  return new Date(parseInt(p[2]), mo, parseInt(p[1]));
}

function jsLit(val, depth = 0) {
  const pad = '  '.repeat(depth);
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number')  return String(val);
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'string')  return JSON.stringify(val);
  if (Array.isArray(val)) {
    if (!val.length) return '[]';
    const inner = val.map(v => `${pad}  ${jsLit(v, depth + 1)}`);
    return `[\n${inner.join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(val)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${pad}  ${k}:${jsLit(v, depth + 1)}`);
  return `{\n${entries.join(',\n')}\n${pad}}`;
}

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Extract the existing array literal from the HTML
const m = html.match(/q2deliverables:(\[[\s\S]*?\n  \])/);
if (!m) { console.error('ERROR: q2deliverables pattern not found'); process.exit(1); }

let existing;
try {
  existing = Function('"use strict"; return ' + m[1])();
} catch (e) { console.error('Parse error:', e.message); process.exit(1); }

console.log(`Existing items: ${existing.length}`);

const seen = new Set(existing.map(i => i.key));
let added = 0;
ADD.forEach(item => {
  if (seen.has(item.key)) { console.log(`  skip (already present): ${item.key}`); return; }
  seen.add(item.key);
  existing.push(item);
  added++;
  console.log(`  + ${item.key}  ${item.title}`);
});

// Re-sort newest-first
existing.sort((a, b) => {
  const da = parseD(a.doneDate), db = parseD(b.doneDate);
  return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
});

const before = html.length;
html = html.replace(
  /q2deliverables:\[[\s\S]*?\n  \],|q2deliverables:\[\],/,
  `q2deliverables:${jsLit(existing, 1)},`
);
if (html.length === before) { console.error('ERROR: inject pattern not matched'); process.exit(1); }

fs.writeFileSync(HTML_PATH, html, 'utf8');
fs.copyFileSync(HTML_PATH, ROOT_PATH);
console.log(`\nAdded ${added} item(s). Total q2deliverables: ${existing.length}`);
console.log('✓  marketing-report/index.html + root index.html updated');
