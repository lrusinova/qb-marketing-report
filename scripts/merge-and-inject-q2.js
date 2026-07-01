// merge-and-inject-q2.js — merge multiple workflow outputs and inject into index.html
// Usage: node merge-and-inject-q2.js <output1.json> [output2.json ...]
const fs   = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'marketing-report', 'index.html');
const ROOT_PATH = path.resolve(__dirname, '..', 'index.html');

const outputFiles = process.argv.slice(2);
if (!outputFiles.length) { console.error('Usage: node merge-and-inject-q2.js <output1.json> [output2.json ...]'); process.exit(1); }

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

const monthMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function parseD(s) {
  if (!s) return null;
  const p = s.trim().split(' ');
  if (p.length < 3) return null;
  const mo = monthMap[p[0]];
  if (mo === undefined) return null;
  return new Date(parseInt(p[2]), mo, parseInt(p[1]));
}

const Q2_START = new Date(2026, 3, 1);
const Q2_END   = new Date(2026, 5, 30, 23, 59, 59);

// ── Collect items from all workflow outputs ──────────────────────────────
const seen = new Set();
const allItems = [];

outputFiles.forEach(file => {
  const obj  = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(obj) ? obj : (obj.result || []);
  let added = 0, skipped = 0, outOfRange = 0;
  items.forEach(i => {
    const d = parseD(i.doneDate);
    if (!d || d < Q2_START || d > Q2_END) { outOfRange++; return; }
    if (!i.key || seen.has(i.key)) { skipped++; return; }
    seen.add(i.key);
    allItems.push({
      key:      i.key,
      title:    decode(i.title),
      ch:       decode(i.ch),
      bu:       i.bu || 'Unknown',
      label:    i.label || '',
      owner:    decode(i.owner),
      type:     decode(i.type) || 'Task',
      doneDate: i.doneDate || '',
    });
    added++;
  });
  console.log(`  ${path.basename(file)}: +${added} items (${skipped} dups, ${outOfRange} outside Q2)`);
});

// Sort newest-first
allItems.sort((a, b) => {
  const da = parseD(a.doneDate), db = parseD(b.doneDate);
  return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
});
console.log(`\nTotal unique Q2 items: ${allItems.length}`);

// Channel breakdown
const byCh = {};
allItems.forEach(i => { byCh[i.ch] = (byCh[i.ch] || 0) + 1; });
Object.entries(byCh).sort((a,b) => b[1]-a[1]).forEach(([ch,n]) => console.log(`  ${n.toString().padStart(4)}  ${ch}`));

// ── jsLit ────────────────────────────────────────────────────────────────
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

// ── Inject ───────────────────────────────────────────────────────────────
let html = fs.readFileSync(HTML_PATH, 'utf8');
const before = html.length;
html = html.replace(
  /q2deliverables:\[[\s\S]*?\n  \],|q2deliverables:\[\],/,
  `q2deliverables:${jsLit(allItems, 1)},`
);
if (html.length === before) { console.error('\nERROR: pattern not found'); process.exit(1); }

fs.writeFileSync(HTML_PATH, html, 'utf8');
fs.copyFileSync(HTML_PATH, ROOT_PATH);
console.log(`\n✓  q2deliverables → ${allItems.length} items written`);
console.log(`✓  marketing-report/index.html + root index.html updated`);
