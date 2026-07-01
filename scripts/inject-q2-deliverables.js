// inject-q2-deliverables.js — one-shot script to write Q2 deliverables from workflow output into index.html
const fs   = require('fs');
const path = require('path');

const OUTPUT_FILE = process.argv[2];
const HTML_PATH   = path.resolve(__dirname, '..', 'marketing-report', 'index.html');
const ROOT_PATH   = path.resolve(__dirname, '..', 'index.html');

if (!OUTPUT_FILE) { console.error('Usage: node inject-q2-deliverables.js <workflow-output.json>'); process.exit(1); }

// ── Load items ─────────────────────────────────────────────────────────────
const obj   = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
const raw   = obj.result;

// ── Decode HTML entities in text fields ────────────────────────────────────
function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    // Fix dash variants from Jira
    .replace(/\s*–\s*/g, ' – ')
    .trim();
}

const items = raw.map(i => ({
  key:      i.key,
  title:    decode(i.title),
  ch:       decode(i.ch),
  bu:       i.bu || 'Unknown',
  label:    i.label || '',
  owner:    decode(i.owner),
  type:     decode(i.type) || 'Task',
  doneDate: i.doneDate || '',
}));

console.log(`Loaded ${items.length} items`);
// Channel breakdown
const byCh = {};
items.forEach(i => { byCh[i.ch] = (byCh[i.ch] || 0) + 1; });
Object.entries(byCh).sort((a,b)=>b[1]-a[1]).forEach(([ch,n])=>console.log(`  ${n.toString().padStart(4)}  ${ch}`));

// ── jsLit — same serialiser as update-dashboard.js ─────────────────────────
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

// ── Inject into HTML ────────────────────────────────────────────────────────
let html = fs.readFileSync(HTML_PATH, 'utf8');

// Replace q2deliverables array (handles both empty [] and existing multi-line)
const before = html.length;
html = html.replace(
  /q2deliverables:\[[\s\S]*?\n  \],|q2deliverables:\[\],/,
  `q2deliverables:${jsLit(items, 1)},`
);

if (html.length === before) {
  console.error('ERROR: q2deliverables pattern not found — check the regex');
  process.exit(1);
}

fs.writeFileSync(HTML_PATH, html, 'utf8');
fs.copyFileSync(HTML_PATH, ROOT_PATH);

console.log(`\n✓  q2deliverables updated — ${items.length} items`);
console.log(`✓  marketing-report/index.html written`);
console.log(`✓  index.html synced`);
