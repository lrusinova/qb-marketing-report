#!/usr/bin/env node
// update-dashboard.js — QB Marketing Dashboard auto-updater
//
// What it does:
//   1. Queries Jira (MKT + WE projects) for each person's active tasks
//   2. Calls Claude Haiku to estimate effort hours per task (XS=2h…XL=80h)
//   3. Rebuilds CAP_DATA, adds a HISTORY snapshot, updates lastUpdated in index.html
//   4. Fetches live task counts per strategic goal → writes strategic-data.json
//   5. In CI (GitHub Actions) the workflow then commits + pushes the changes
//
// Usage:
//   node update-dashboard.js            # live run — writes to index.html + strategic-data.json
//   node update-dashboard.js --dry-run  # preview only — no file changes
//
// Required env vars (set in .env locally, or GitHub Secrets in CI):
//   JIRA_EMAIL        your Quickbase Atlassian email
//   JIRA_TOKEN        Jira API token from https://id.atlassian.com/manage-profile/security/api-tokens
//   ANTHROPIC_API_KEY Anthropic API key (used for hour estimation via Claude Haiku)

require('dotenv').config();
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const DRY_RUN   = process.argv.includes('--dry-run');
const HTML_PATH = path.resolve(__dirname, '..', 'marketing-report', 'index.html');
const JSON_PATH = path.resolve(__dirname, '..', 'marketing-report', 'strategic-data.json');

// ── Done-equivalent statuses (excluded from active counts) ──────────────────
const DONE_STATUSES = new Set([
  'Done', 'Published', 'Live', 'Posted', 'Cancelled',
  'Closed', 'Design Done', 'Released', 'Archived',
]);

// ── H2 2026 Strategic Goals ──────────────────────────────────────────────────
const STRATEGIC_GOALS = [
  { key: 'MKT-12568', name: 'Growth — AWE (FastField + Pave)', owner: 'Gar Smyth'               },
  { key: 'MKT-12569', name: 'Core BU Marketing',               owner: 'TBH (role in hiring)'    },
  { key: 'MKT-12570', name: 'Integrated Marketing',             owner: 'Mirissa Kampf'           },
  { key: 'MKT-12571', name: 'Digital',                          owner: 'Carlos Cortez de Barros' },
  { key: 'MKT-12572', name: 'Corporate Communications',         owner: 'Tory Waldron'            },
  { key: 'MKT-12573', name: 'Marketing Systems & AI',           owner: 'Lynn Tan'                },
  { key: 'MKT-12574', name: 'Program Management',               owner: 'Luiza Rusinova'          },
];

// ── Jira REST API ────────────────────────────────────────────────────────────
const JIRA_AUTH = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`
).toString('base64');

function jiraFetch(apiPath) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'quickbase.atlassian.net',
      path: apiPath,
      method: 'GET',
      headers: { Authorization: `Basic ${JIRA_AUTH}`, Accept: 'application/json' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Jira ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject).end();
  });
}

async function jiraSearch(jql) {
  const issues = [];
  let start = 0;
  while (true) {
    const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${start}&maxResults=100&fields=summary,status,issuetype,subtasks`;
    const data = await jiraFetch(url);
    issues.push(...data.issues);
    if (issues.length >= data.total || data.issues.length === 0) break;
    start += 100;
  }
  return issues;
}

// ── Claude Haiku hour estimation ─────────────────────────────────────────────
// Model: XS=2h  S=6h  M=16h  L=32h  XL=80h
// Batches tasks in groups of 40 to stay within token limits.
async function estimateHours(tasks) {
  if (!tasks.length) return {};

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  ANTHROPIC_API_KEY not set — defaulting to S=6h for all tasks');
    return Object.fromEntries(tasks.map(t => [t.key, 6]));
  }

  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { console.warn('  ⚠  @anthropic-ai/sdk not installed — run npm install'); return Object.fromEntries(tasks.map(t => [t.key, 6])); }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results = {};
  const CHUNK = 40;

  for (let i = 0; i < tasks.length; i += CHUNK) {
    const chunk = tasks.slice(i, i + CHUNK);
    const list  = chunk.map(t => `${t.key}: [${t.type}] ${t.summary}`).join('\n');
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Estimate effort in hours for these Quickbase marketing Jira tasks.

Sizing guide:
- XS = 2h  (quick social post, minor copy tweak, brief review)
- S  = 6h  (short email, small graphic, coordination task)
- M  = 16h (blog post, landing page, email campaign, design asset)
- L  = 32h (major launch kit, multi-asset campaign, large event piece)
- XL = 80h (multi-week program, full event production, large content series)

Tasks:
${list}

Return ONLY valid JSON — no markdown, no explanation: [{"key":"MKT-123","h":16},...]`
        }]
      });
      const text   = msg.content[0].text.trim().replace(/^```json?\n?|```$/g, '');
      const parsed = JSON.parse(text);
      for (const e of parsed) results[e.key] = e.h;
    } catch (e) {
      console.warn(`  ⚠  Estimation batch ${i}–${i+CHUNK} failed (${e.message}) — using S=6h`);
      for (const t of chunk) results[t.key] = 6;
    }
  }
  return results;
}

// ── Recently shipped items ───────────────────────────────────────────────────
const CHANNEL_TO_SHIPPED_CH = {
  'Content & SEO':        'SEO / AEO',
  'Email & Lifecycle':    'Email & Lifecycle',
  'Creative & Design':    'Creative & Design',
  'Demand Gen':           'Webinars & Events',
  'Social Media':         'Social Media',
  'PMM / Product':        'Launches & GTM',
  'Marketing Analytics':  'Systems & AI',
  'Events & Experiences': 'Webinars & Events',
  'Community':            'Community',
  'PR & Comms':           'PR & Exec Comms',
  'Web & Digital':        'Web / Digital',
  'UX & Design':          'Web / Digital',
};

function parseBuFromLabels(labels = []) {
  if (labels.some(l => /^Pave-MKT$/i.test(l))) return { bu: 'Pave', label: 'Pave-MKT' };
  if (labels.some(l => /^FF-MKT$/i.test(l)))   return { bu: 'FastField', label: 'FF-MKT' };
  if (labels.some(l => /QB-Core-MKT/i.test(l))) return { bu: 'Core (QB)', label: 'QB-Core-MKT' };
  if (labels.some(l => /CrossBU-MKT/i.test(l))) return { bu: 'Cross-BU', label: 'CrossBU-MKT' };
  if (labels.some(l => /^WE-/i.test(l)))        return { bu: 'Web', label: 'WE' };
  return { bu: 'Cross-BU', label: 'CrossBU-MKT' };
}

async function fetchRecentlyShipped(team) {
  const personChannel = {};
  for (const p of team) personChannel[p.displayName] = p.channel;

  const jql = `project in (MKT, WE) AND status CHANGED TO ("Done","Published","Released","Live","Posted") AFTER -30d AND issuetype not in (Epic,"Marketing Initiative","Sub-task") ORDER BY updated DESC`;
  const url  = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=0&maxResults=100&fields=summary,assignee,issuetype,labels,resolutiondate,status`;
  const data = await jiraFetch(url);

  return data.issues.map(i => {
    const assigneeDisplay = i.fields.assignee?.displayName || '(unassigned)';
    const ch   = CHANNEL_TO_SHIPPED_CH[personChannel[assigneeDisplay]] || 'Content';
    const { bu, label } = parseBuFromLabels(i.fields.labels || []);
    const rawDate = i.fields.resolutiondate || i.fields.updated;
    const doneDate = rawDate
      ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : fmtDate(new Date());
    return {
      key:      i.key,
      title:    i.fields.summary,
      ch,
      bu,
      label,
      owner:    assigneeDisplay,
      type:     i.fields.issuetype?.name || 'Task',
      doneDate,
    };
  });
}

// ── Strategic Goal Data ──────────────────────────────────────────────────────
// Fetches task counts per strategic goal by traversing the Jira hierarchy:
// Strategic Project → Marketing Initiative → Epic → Task
async function fetchStrategicGoalData(today) {
  const goals = [];

  for (const goal of STRATEGIC_GOALS) {
    process.stdout.write(`  ${goal.name.padEnd(44)} `);
    try {
      // Level 1: Marketing Initiatives under this strategic goal
      const miIssues = await jiraSearch(
        `project = MKT AND issuetype = "Marketing Initiative" AND parent = ${goal.key}`
      );
      const miKeys = miIssues.map(i => i.key);

      // Level 2: Epics under those initiatives
      let epicIssues = [];
      if (miKeys.length) {
        epicIssues = await jiraSearch(
          `project in (MKT, WE) AND issuetype = Epic AND parent in (${miKeys.join(',')})`
        );
      }
      const epicKeys = epicIssues.map(i => i.key);

      // Level 3: Tasks under those epics (batch 50 keys at a time to avoid JQL limits)
      let taskIssues = [];
      for (let i = 0; i < epicKeys.length; i += 50) {
        const batch = epicKeys.slice(i, i + 50);
        const batchIssues = await jiraSearch(
          `project in (MKT, WE) AND parent in (${batch.join(',')}) AND issuetype not in (Epic, "Marketing Initiative", "Strategic Project")`
        );
        taskIssues.push(...batchIssues);
      }

      // Aggregate task statuses
      const byStatus = {};
      for (const t of taskIssues) {
        const s = t.fields.status?.name || 'Unknown';
        byStatus[s] = (byStatus[s] || 0) + 1;
      }

      const doneCount   = Object.entries(byStatus)
        .filter(([s]) => DONE_STATUSES.has(s))
        .reduce((sum, [, n]) => sum + n, 0);
      const activeCount = taskIssues.length - doneCount;

      goals.push({
        key:              goal.key,
        name:             goal.name,
        owner:            goal.owner,
        totalInitiatives: miIssues.length,
        totalEpics:       epicIssues.length,
        totalTasks:       taskIssues.length,
        activeTasks:      activeCount,
        doneTasks:        doneCount,
        completionPct:    taskIssues.length
          ? Math.round((doneCount / taskIssues.length) * 100)
          : 0,
        byStatus,
        epics: epicIssues.map(e => ({
          key:     e.key,
          summary: e.fields.summary,
          status:  e.fields.status?.name || 'Unknown',
        })),
      });

      console.log(`${miIssues.length} initiatives  ${epicIssues.length} epics  ${taskIssues.length} tasks  (${activeCount} active)`);
    } catch (err) {
      console.warn(`ERROR — ${err.message}`);
      goals.push({ key: goal.key, name: goal.name, owner: goal.owner, error: err.message });
    }
  }

  return {
    pulledAt:       fmtDate(today),
    note:           'Live from Jira MKT + WE — counts exclude Done/Published/Released/etc.',
    strategicGoals: goals,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const LOAD_RANK = { OVER: 3, HIGH: 2, OK: 1, LIGHT: 0 };

function loadStatus(hours) {
  if (hours > 40) return 'OVER';
  if (hours > 32) return 'HIGH';
  if (hours >= 16) return 'OK';
  return 'LIGHT';
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtShort(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { TEAM, CHANNELS } = require('./config');
  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0];

  console.log(`\nQB Marketing Dashboard Update — ${fmtDate(today)}${DRY_RUN ? '  [DRY RUN]' : ''}\n`);

  if (!process.env.JIRA_EMAIL || !process.env.JIRA_TOKEN) {
    console.error('ERROR: JIRA_EMAIL and JIRA_TOKEN must be set (check your .env file)');
    process.exit(1);
  }

  // ── 1. Pull active tasks per person ──────────────────────────────────
  const personResults = {};

  for (const person of TEAM) {
    process.stdout.write(`  ${person.displayName.padEnd(28)} `);
    try {
      const jql = `project in (MKT, WE) AND assignee = "${person.jiraName}" AND status not in ("Done","Published","Live","Posted","Cancelled","Closed","Design Done","Released","Archived") ORDER BY priority ASC`;
      const issues = await jiraSearch(jql);

      const childKeys    = new Set(issues.flatMap(i => (i.fields.subtasks || []).map(s => s.key)));
      const coordParents = issues.filter(i => childKeys.has(i.key));
      const toEstimate   = issues.filter(i => !childKeys.has(i.key)).map(i => ({
        key:     i.key,
        summary: i.fields.summary,
        type:    i.fields.issuetype?.name || 'Task',
      }));

      const estimates = await estimateHours(toEstimate);
      let totalHours  = coordParents.length * 6;
      for (const t of toEstimate) totalHours += estimates[t.key] ?? 6;
      totalHours = Math.round(totalHours);

      personResults[person.displayName] = {
        channel: person.channel,
        project: person.project,
        tasks:   issues.length,
        hours:   totalHours,
        load:    loadStatus(totalHours),
      };

      console.log(`${String(issues.length).padStart(2)} tasks  ${String(totalHours).padStart(4)}h  ${loadStatus(totalHours)}`);
    } catch (err) {
      console.log(`ERROR — ${err.message}`);
      personResults[person.displayName] = null;
    }
  }

  // ── 2. Aggregate by channel ───────────────────────────────────────────
  const chanMap = {};
  for (const ch of CHANNELS) {
    chanMap[ch.name] = { ch: ch.name, items: 0, unassigned: 0, hours: 0, load: 'LIGHT', people: [] };
  }
  const mktArr = [], weArr = [];

  for (const [name, data] of Object.entries(personResults)) {
    if (!data) continue;
    const ch = chanMap[data.channel];
    if (ch) { ch.items += data.tasks; ch.hours += data.hours; ch.people.push(name); }
    const entry = { name, tasks: data.tasks, hours: data.hours, load: data.load };
    (data.project === 'we' ? weArr : mktArr).push(entry);
  }

  for (const ch of Object.values(chanMap)) {
    const peopleMeta = ch.people.map(n => personResults[n]).filter(Boolean);
    if (peopleMeta.length) {
      ch.load = peopleMeta.reduce(
        (w, p) => LOAD_RANK[p.load] > LOAD_RANK[w] ? p.load : w, 'LIGHT'
      );
    }
  }

  mktArr.sort((a, b) => b.hours - a.hours);
  weArr.sort((a, b) => b.hours - a.hours);

  const newCapData = {
    pulledAt: fmtDate(today),
    note: 'Effort AI-estimated · Active tasks only (excludes Published/Released/Done) · 40h/wk = 100%',
    channels: Object.values(chanMap),
    mkt: mktArr,
    we:  weArr,
  };

  // ── 3. Build HISTORY entry ────────────────────────────────────────────
  let ov = 0, hi = 0, ok = 0, lt = 0;
  for (const ch of newCapData.channels) {
    if      (ch.load === 'OVER')  ov++;
    else if (ch.load === 'HIGH')  hi++;
    else if (ch.load === 'OK')    ok++;
    else                          lt++;
  }
  const histEntry = {
    d: todayStr, w: fmtShort(today),
    ov, hi, ok, lt,
    ch: newCapData.channels.map(c => [c.ch, c.hours, c.load]),
  };

  // ── 4. Summary ────────────────────────────────────────────────────────
  console.log('\n── Channel Summary ──────────────────────────────────────────────');
  for (const ch of newCapData.channels) {
    const bar = '█'.repeat(Math.min(20, Math.round(ch.hours / 15)));
    console.log(`  ${ch.ch.padEnd(24)} ${String(ch.hours).padStart(4)}h  ${ch.load.padEnd(6)}  ${bar}`);
  }
  console.log(`\n  Load totals: OVER ${ov}  HIGH ${hi}  OK ${ok}  LIGHT ${lt}`);

  // ── 4b. Fetch recently shipped items ─────────────────────────────────
  let shippedItems = [];
  try {
    process.stdout.write('\n  Fetching recently shipped items (last 30d)… ');
    shippedItems = await fetchRecentlyShipped(TEAM);
    console.log(`${shippedItems.length} items found`);
  } catch (err) {
    console.warn(`  ⚠  shipped fetch failed (${err.message}) — shipped list unchanged`);
  }

  // ── 5. Fetch and write strategic goal data ────────────────────────────
  console.log('\n── Strategic Goal Data ──────────────────────────────────────────');
  let strategicData = null;
  try {
    strategicData = await fetchStrategicGoalData(today);
    if (!DRY_RUN) {
      fs.writeFileSync(JSON_PATH, JSON.stringify(strategicData, null, 2), 'utf8');
      console.log(`\n✓  strategic-data.json updated (${strategicData.strategicGoals.length} goals)`);
    } else {
      console.log('\n[DRY RUN] strategic-data.json would be written — sample:');
      console.log(JSON.stringify(strategicData.strategicGoals[0], null, 2));
    }
  } catch (err) {
    console.warn(`  ⚠  Strategic data fetch failed (${err.message})`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] HISTORY entry that would be added:');
    console.log(JSON.stringify(histEntry, null, 2));
    if (shippedItems.length) {
      console.log(`\n[DRY RUN] ${shippedItems.length} shipped items would replace DATA.shipped`);
    }
    console.log('\n[DRY RUN] No changes written.\n');
    return;
  }

  // ── 6. Write to index.html ────────────────────────────────────────────
  let html = fs.readFileSync(HTML_PATH, 'utf8');

  html = html.replace(
    /const CAP_DATA = \{[\s\S]*?\n\};/,
    `const CAP_DATA = ${jsLit(newCapData)};`
  );

  html = html.replace(
    /(const HISTORY\s*=\s*\[)([\s\S]*?)(\n\];)/,
    (_, open, content, close) => {
      const trimmed = content.trimEnd();
      const sep = trimmed.endsWith(',') ? '' : ',';
      return `${open}${trimmed}${sep}\n  ${jsLit(histEntry)}${close}`;
    }
  );

  if (shippedItems.length) {
    html = html.replace(
      /shipped:\[[\s\S]*?\n  \],/,
      `shipped:${jsLit(shippedItems, 1)},`
    );
    console.log(`   DATA.shipped updated → ${shippedItems.length} items`);
  }

  // Inject API key into chat widget (CI only — key stays in GitHub Secrets, not source)
  if (process.env.ANTHROPIC_API_KEY) {
    html = html.replace('YOUR_ANTHROPIC_API_KEY_HERE', process.env.ANTHROPIC_API_KEY);
  }

  fs.writeFileSync(HTML_PATH, html, 'utf8');

  console.log(`\n✓  index.html updated`);
  console.log(`   CAP_DATA refreshed · HISTORY entry added · pulledAt → ${fmtDate(today)}\n`);
}

main().catch(err => {
  console.error('\n✗  Update failed:', err.message);
  process.exit(1);
});
