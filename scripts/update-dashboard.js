#!/usr/bin/env node
// update-dashboard.js — QB Marketing Dashboard auto-updater
//
// What it does:
//   1. Queries Jira (MKT + WE projects) for each person's active tasks
//   2. Calls Claude Haiku to estimate effort hours per task (XS=2h…XL=80h)
//   3. Rebuilds CAP_DATA, adds a HISTORY snapshot, updates lastUpdated in index.html
//   4. Fetches ALL Q2 completions from Jira → rebuilds DATA.shipped with full categorization
//      Categorization tiers: labels → summary keywords → assignee → description → comments → Claude
//      Items that cannot be categorized after all tiers → written to deliverables-review.json
//   5. Fetches live task counts per strategic goal → writes strategic-data.json
//   6. Syncs root index.html from marketing-report/index.html (GitHub Pages serves from root)
//   In CI (GitHub Actions) the workflow then commits + pushes all changes
//
// Usage:
//   node update-dashboard.js            # live run — writes to index.html + strategic-data.json
//   node update-dashboard.js --dry-run  # preview only — no file changes
//
// Required env vars (set in .env locally, or GitHub Secrets in CI):
//   JIRA_EMAIL        your Quickbase Atlassian email
//   JIRA_TOKEN        Jira API token from https://id.atlassian.com/manage-profile/security/api-tokens
//   ANTHROPIC_API_KEY Anthropic API key (used for hour estimation + deliverable classification)

require('dotenv').config();
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const DRY_RUN    = process.argv.includes('--dry-run');
const HTML_PATH  = path.resolve(__dirname, '..', 'marketing-report', 'index.html');
const ROOT_PATH  = path.resolve(__dirname, '..', 'index.html');
const JSON_PATH  = path.resolve(__dirname, '..', 'marketing-report', 'strategic-data.json');
const REVIEW_PATH = path.resolve(__dirname, '..', 'marketing-report', 'deliverables-review.json');

// ── Done-equivalent statuses (excluded from active counts) ──────────────────
const DONE_STATUSES = new Set([
  'Done', 'Published', 'Live', 'Posted', 'Cancelled',
  'Closed', 'Design Done', 'Released', 'Archived',
]);

// Statuses that are genuine completions (not cleanup)
const GENUINE_DONE = new Set(['Done', 'Published', 'Live', 'Posted', 'POSTED', 'Design Done', 'Released']);
const CLEANUP_STATUSES = new Set(['Cancelled', 'Archived', 'Closed']);

// ── H2 2026 Strategic Goals ──────────────────────────────────────────────────
const STRATEGIC_GOALS = [
  { key:'MKT-12568', name:'Agentic Workflow Evolution (AWE)',  owner:'Gar Smyth',               scopeType:'bu', scopeValues:['FastField','Pave']                                                         },
  { key:'MKT-12569', name:'Core BU Marketing',                 owner:'TBH (role in hiring)',     scopeType:'bu', scopeValues:['Core (QB)']                                                               },
  { key:'MKT-12570', name:'Integrated Marketing',              owner:'Mirissa Kampf',            scopeType:'ch', scopeValues:['Creative & Design','Content & SEO','Community','Events & Experiences']     },
  { key:'MKT-12571', name:'Digital',                           owner:'Carlos Cortez de Barros',  scopeType:'ch', scopeValues:['Web & Digital','Content & SEO']                                            },
  { key:'MKT-12572', name:'Corporate Communications',          owner:'Tory Waldron',             scopeType:'ch', scopeValues:['PR & Comms','Social Media']                                                },
  { key:'MKT-12573', name:'Marketing Systems & AI',            owner:'Lynn Tan',                 scopeType:'ch', scopeValues:['Email & Lifecycle','Marketing Analytics']                                  },
  { key:'MKT-12574', name:'Program Management',                owner:'Luiza Rusinova',           scopeType:null, scopeValues:[]                                                                           },
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

async function jiraSearch(jql, fields = 'summary,status,issuetype,subtasks') {
  const issues = [];
  let start = 0;
  while (true) {
    const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${start}&maxResults=100&fields=${fields}`;
    const data = await jiraFetch(url);
    issues.push(...data.issues);
    if (issues.length >= data.total || data.issues.length === 0) break;
    start += 100;
  }
  return issues;
}

// ── Claude Haiku hour estimation ─────────────────────────────────────────────
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

// ── Deliverable categorization helpers ───────────────────────────────────────

// Flatten Atlassian Document Format (ADF) JSON to plain text
function extractTextFromADF(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node)) return node.map(extractTextFromADF).join(' ');
  if (node.content) return extractTextFromADF(node.content);
  return '';
}

// BU from Jira labels (most reliable signal)
const BU_LABEL_MAP = {
  'pave-mkt':    { bu: 'Pave',      label: 'Pave-MKT'    },
  'ff-mkt':      { bu: 'FastField', label: 'FF-MKT'      },
  'qb-core-mkt': { bu: 'QB-Core',   label: 'QB-Core-MKT' },
  'crossbu-mkt': { bu: 'Cross-BU',  label: 'CrossBU-MKT' },
  'awe-mkt':     { bu: 'Cross-BU',  label: 'AWE-MKT'     },
};

function detectBU(labels, text) {
  for (const l of labels) {
    const norm = l.toLowerCase().trim();
    if (BU_LABEL_MAP[norm]) return BU_LABEL_MAP[norm];
  }
  const t = text.toLowerCase();
  if (/\[pave\]|\bpaveathon\b/.test(t) || /(?<![a-z])pave(?![a-z])/i.test(t))
    return { bu: 'Pave', label: 'Pave-MKT' };
  if (/\[ff\]|\[fastfield\]|\bfastfield\b|\bfast[ -]field\b/i.test(t))
    return { bu: 'FastField', label: 'FF-MKT' };
  if (/\[core\]|\[qb\]|\bqb[ -]core\b/i.test(t))
    return { bu: 'QB-Core', label: 'QB-Core-MKT' };
  if (/\[cross[ -]?bu\]/i.test(t))
    return { bu: 'Cross-BU', label: 'CrossBU-MKT' };
  return null;
}

// Channel from issuetype (typed request forms are reliable)
const ISSUETYPE_CHANNEL = {
  'mops email request':         'Email & Lifecycle',
  'marketing social request':   'Social Media',
  'marketing creative request': 'Creative & Design',
  'content request':            'Content & SEO',
  'web page request':           'Web & Digital',
  'mops campaign request':      'Email & Lifecycle',
  'mops list upload':           'Email & Lifecycle',
  'mops report request':        'Marketing Analytics',
  'mops other project request': 'Email & Lifecycle',
  'ux design':                  'UX & Design',
  'development':                'Web & Digital',
  'story':                      'Web & Digital',
  'bug':                        'Web & Digital',
  'research':                   'Marketing Analytics',
};

// Keyword patterns for channel detection (applied to summary + description + comments)
const CHANNEL_PATTERNS = [
  [/\bemail\b|\bnewsletter\b|\blifecycle\b|\bmops\b|\bmarketo\b|\bhubspot\b/i, 'Email & Lifecycle'],
  [/\bsocial\b(?! media channel)|\blinkedin\b|\btwitter\b|\binstagram\b|\borganic post\b/i, 'Social Media'],
  [/\bcreative\b|\bgraphic design\b|\bvideo\b(?! embed)|\bbrand (asset|identity|guidelines|standard)/i, 'Creative & Design'],
  [/\bseo\b|\baeo\b|\bglossary\b|\bcontent request\b|\barticle\b|\bblog post\b/i, 'Content & SEO'],
  [/\bwebinar\b|\bevent\b|\bconference\b|\btradeshow\b|\bai4\b|\bgartner\b|\bqrew\b(?! migration)/i, 'Events & Experiences'],
  [/\bweb (page|build|copy|refresh)\b|\blanding page\b|\bcms\b|\bredirect\b|\bsite (page|section)\b/i, 'Web & Digital'],
  [/\bpr\b(?!\s*c)|\bpress release\b|\banalyst\b|\bmedia outreach\b|\bcomms\b/i, 'PR & Comms'],
  [/\bcommunity\b|\bqrew\b|\bgainsight\b|\bkhoros\b|\badvocacy\b/i, 'Community'],
  [/\bdemand gen\b|\bpaid search\b|\bppc\b|\bgoogle ads\b|\bsem\b/i, 'Demand Gen'],
  [/\bpmm\b|\bproduct marketing\b|\bgo[ -]to[ -]market\b|\bgtm\b|\blaunch (brief|plan|kit)\b|\bpositioning\b|\bmessaging\b/i, 'PMM / Product'],
  [/\banalytics\b|\bga4\b|\bsalesforce\b|\bsnowflake\b|\bdataslayer\b|\breporting\b/i, 'Marketing Analytics'],
];

function detectChannel(assignee, issuetype, summary, text, personChannel) {
  // Tier 1: assignee is in the known team roster
  if (assignee && personChannel[assignee]) return personChannel[assignee];
  // Tier 2: typed request form — most reliable after assignee
  const typeKey = (issuetype || '').toLowerCase();
  if (ISSUETYPE_CHANNEL[typeKey]) return ISSUETYPE_CHANNEL[typeKey];
  // Tiers 3+: keyword scan — summary first, then full text
  for (const [pat, ch] of CHANNEL_PATTERNS) {
    if (pat.test(summary)) return ch;
  }
  const combined = `${summary} ${text}`;
  for (const [pat, ch] of CHANNEL_PATTERNS) {
    if (pat.test(combined)) return ch;
  }
  return null;
}

// Deliverable type from issuetype or summary keywords
function detectType(issuetype, summary) {
  const t = (issuetype || '').toLowerCase();
  if (t.includes('email') || t.includes('mops')) return 'Email';
  if (t.includes('social')) return 'Social';
  if (t.includes('creative')) return 'Creative';
  if (t.includes('content')) return 'Content';
  if (t.includes('web page')) return 'Web Page';
  if (t.includes('bug')) return 'Bug Fix';
  if (t.includes('ux design')) return 'UX Design';
  if (t.includes('development')) return 'Development';
  if (t.includes('epic')) return 'Program';
  const s = (summary || '').toLowerCase();
  if (/glossary/i.test(s))                       return 'Glossary';
  if (/\bvideo\b|\bbumper\b/i.test(s))           return 'Video';
  if (/\bblog\b/i.test(s))                       return 'Blog';
  if (/white\s*paper|case\s*study/i.test(s))     return 'White Paper';
  if (/\bemail\b/i.test(s))                      return 'Email';
  if (/\bwebinar\b/i.test(s))                    return 'Webinar';
  if (/\bsocial\b|\bpost\b/i.test(s))            return 'Social';
  if (/\bdeck\b|\bpresentation\b/i.test(s))      return 'Deck';
  if (/\blandscape\b|\banalysis\b/i.test(s))     return 'Research';
  return issuetype || 'Task';
}

// Maps TEAM channel names → shipped item ch values (display labels in the dashboard)
const CHANNEL_TO_SHIPPED_CH = {
  'Content & SEO':        'SEO / AEO',
  'Email & Lifecycle':    'Email & Lifecycle',
  'Creative & Design':    'Creative & Design',
  'Demand Gen':           'Demand Gen',
  'Social Media':         'Social Media',
  'PMM / Product':        'Launches & GTM',
  'Marketing Analytics':  'Systems & AI',
  'Events & Experiences': 'Webinars & Events',
  'Community':            'Community',
  'PR & Comms':           'PR & Exec Comms',
  'Web & Digital':        'Web / Digital',
  'UX & Design':          'Web / Digital',
};

// Fetch up to 5 comments for a single issue (last-resort text signal)
async function fetchIssueComments(issueKey) {
  try {
    const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/comment?maxResults=5&orderBy=-created`);
    return (data.comments || []).map(c => extractTextFromADF(c.body)).join(' ');
  } catch { return ''; }
}

// ── Full Q2 shipped items fetch with deep categorization ─────────────────────
async function fetchAllQ2Shipped(team, q2Start, q2End) {
  const personChannel = {};
  for (const p of team) personChannel[p.displayName] = p.channel;

  const GENUINE_LIST = '"Done","Published","Live","Posted","POSTED","Released","Design Done"';
  const jql = `project in (MKT, WE) AND status CHANGED TO (${GENUINE_LIST}) DURING ("${q2Start}","${q2End}") ORDER BY updated DESC`;
  const fields = 'summary,assignee,issuetype,labels,components,description,resolutiondate,status,updated';

  // Paginate through every result
  const issues = [];
  let start = 0;
  process.stdout.write('  Fetching Q2 completions ');
  while (true) {
    const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${start}&maxResults=100&fields=${fields}`;
    const data = await jiraFetch(url);
    issues.push(...data.issues);
    process.stdout.write('.');
    if (issues.length >= data.total || data.issues.length === 0) break;
    start += 100;
  }
  console.log(` ${issues.length} raw`);

  // Drop items that ended up cancelled/archived after completion
  const genuine = issues.filter(i => !CLEANUP_STATUSES.has(i.fields.status?.name));
  console.log(`  ${genuine.length} genuine (${issues.length - genuine.length} cancelled/archived excluded)`);

  const categorized  = [];
  const needComments = [];

  // ── Pass 1: assignee / issuetype / keywords / description ───────────────
  // Categorize immediately if channel is known; BU defaults to 'Unknown' when
  // no label or keyword match (99% of task-level issues have no BU label).
  for (const issue of genuine) {
    const summary   = issue.fields.summary || '';
    const labels    = issue.fields.labels || [];
    const assignee  = issue.fields.assignee?.displayName || null;
    const issuetype = issue.fields.issuetype?.name || 'Task';
    const descText  = extractTextFromADF(issue.fields.description);
    const allText   = `${summary} ${descText}`;
    const rawDate   = issue.fields.resolutiondate || issue.fields.updated;
    const doneDate  = rawDate
      ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    const buResult = detectBU(labels, allText);
    const channel  = detectChannel(assignee, issuetype, summary, allText, personChannel);

    if (channel) {
      categorized.push({
        key: issue.key, title: summary,
        ch:    CHANNEL_TO_SHIPPED_CH[channel] || channel,
        bu:    buResult ? buResult.bu : 'Unknown',
        label: buResult ? buResult.label : '',
        owner: assignee || 'Unassigned',
        type: detectType(issuetype, summary), doneDate,
      });
    } else {
      // Channel still unknown — try comments in Pass 2
      needComments.push({
        key: issue.key, summary, labels, assignee, issuetype, descText, doneDate,
        knownBU: buResult,
      });
    }
  }
  console.log(`  Pass 1: ${categorized.length} categorized · ${needComments.length} need comment check`);

  // ── Pass 2: parallel comment fetch — only for channel-unknown items ──────
  // Cap at 200 to avoid unbounded API calls; batch 15 at a time.
  const COMMENT_CAP = 200;
  const toCheck  = needComments.slice(0, COMMENT_CAP);
  const overflow = needComments.slice(COMMENT_CAP);
  const needsReview = [];

  if (toCheck.length > 0) {
    process.stdout.write(`  Fetching comments for ${toCheck.length} items `);
    const BATCH_SIZE = 15;
    for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
      const batch        = toCheck.slice(i, i + BATCH_SIZE);
      const commentTexts = await Promise.all(batch.map(item => fetchIssueComments(item.key)));
      for (let j = 0; j < batch.length; j++) {
        const item        = batch[j];
        const commentText = commentTexts[j];
        const allText     = `${item.summary} ${item.descText} ${commentText}`;
        const buResult    = item.knownBU || detectBU(item.labels, allText);
        const channel     = detectChannel(item.assignee, item.issuetype, item.summary, allText, personChannel);
        if (channel) {
          categorized.push({
            key: item.key, title: item.summary,
            ch:    CHANNEL_TO_SHIPPED_CH[channel] || channel,
            bu:    buResult ? buResult.bu : 'Unknown',
            label: buResult ? buResult.label : '',
            owner: item.assignee || 'Unassigned',
            type:  detectType(item.issuetype, item.summary), doneDate: item.doneDate,
          });
        } else {
          needsReview.push({
            key: item.key, title: item.summary, type: item.issuetype,
            assignee: item.assignee || '(unassigned)',
            partialBU: buResult?.bu || null, partialChannel: null,
            note: 'Could not determine channel from labels, summary, description, or comments',
          });
        }
      }
      process.stdout.write('.');
    }
    console.log('');
    console.log(`  Pass 2: +${toCheck.length - needsReview.length} categorized · ${needsReview.length} flagged`);
  }

  // Items beyond the cap → flag for manual review
  for (const item of overflow) {
    needsReview.push({
      key: item.key, title: item.summary, type: item.issuetype,
      assignee: item.assignee || '(unassigned)',
      partialBU: item.knownBU?.bu || null, partialChannel: null,
      note: 'Skipped: comment cap (200) reached — assign channel via Jira label or assignee',
    });
  }
  if (overflow.length > 0) {
    console.log(`  ${overflow.length} items exceeded comment cap → flagged for review`);
  }

  // Sort newest first
  categorized.sort((a, b) => {
    const da = a.doneDate ? new Date(a.doneDate) : 0;
    const db = b.doneDate ? new Date(b.doneDate) : 0;
    return db - da;
  });

  console.log(`\n  ✓ Total shipped: ${categorized.length} categorized · ${needsReview.length} need review`);
  return { shipped: categorized, needsReview, total: genuine.length };
}

// ── Strategic Goal Data ──────────────────────────────────────────────────────
async function fetchStrategicGoalData(today) {
  const goals = [];

  for (const goal of STRATEGIC_GOALS) {
    process.stdout.write(`  ${goal.name.padEnd(44)} `);
    try {
      const miIssues = await jiraSearch(
        `project = MKT AND issuetype = "Marketing Initiative" AND parent = ${goal.key}`
      );
      const miKeys = miIssues.map(i => i.key);

      let epicIssues = [];
      if (miKeys.length) {
        epicIssues = await jiraSearch(
          `project in (MKT, WE) AND issuetype = Epic AND parent in (${miKeys.join(',')})`
        );
      }
      const epicKeys = epicIssues.map(i => i.key);

      let taskIssues = [];
      for (let i = 0; i < epicKeys.length; i += 50) {
        const batch = epicKeys.slice(i, i + 50);
        const batchIssues = await jiraSearch(
          `project in (MKT, WE) AND parent in (${batch.join(',')}) AND issuetype not in (Epic, "Marketing Initiative", "Strategic Project")`
        );
        taskIssues.push(...batchIssues);
      }

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
        key: goal.key, name: goal.name, owner: goal.owner,
        totalInitiatives: miIssues.length,
        totalEpics:       epicIssues.length,
        totalTasks:       taskIssues.length,
        activeTasks:      activeCount,
        doneTasks:        doneCount,
        completionPct:    taskIssues.length ? Math.round((doneCount / taskIssues.length) * 100) : 0,
        byStatus,
        epics: epicIssues.map(e => ({
          key: e.key, summary: e.fields.summary, status: e.fields.status?.name || 'Unknown',
        })),
      });

      console.log(`${miIssues.length} initiatives  ${epicIssues.length} epics  ${taskIssues.length} tasks  (${activeCount} active)`);
    } catch (err) {
      console.warn(`ERROR — ${err.message}`);
      goals.push({ key: goal.key, name: goal.name, owner: goal.owner, error: err.message });
    }
  }

  return {
    pulledAt: fmtDate(today),
    note: 'Live from Jira MKT + WE — counts exclude Done/Published/Released/etc.',
    strategicGoals: goals,
  };
}

// ── Recent Done tasks per initiative (last 30 days) ──────────────────────────
async function fetchRecentTasksPerInitiative(goals, today, personChannel) {
  const cutoff    = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const result    = {};

  const normBU = bu => bu === 'QB-Core' ? 'Core (QB)' : bu;

  // Maps scope BU name → Jira label used to tag that BU's tasks
  const BU_LABEL_FILTER = { 'FastField': 'FF-MKT', 'Pave': 'Pave-MKT', 'Core (QB)': 'QB-Core-MKT' };

  for (const goal of goals) {
    if (!goal.scopeType) {
      result[goal.key] = { pulledAt: fmtDate(today), total: 0, groups: {} };
      continue;
    }
    process.stdout.write(`  ${goal.name.padEnd(44)} `);
    try {
      let jql;

      if (goal.scopeType === 'bu') {
        // BU-scoped: query by BU labels (FF-MKT, Pave-MKT, QB-Core-MKT)
        const labelFilter = goal.scopeValues
          .map(bu => BU_LABEL_FILTER[bu]).filter(Boolean)
          .map(l => `"${l}"`).join(',');
        if (!labelFilter) {
          result[goal.key] = { pulledAt: fmtDate(today), total: 0, groups: {} };
          console.log('no BU labels configured');
          continue;
        }
        jql = `project in (MKT, WE) AND statusCategory = Done AND updated >= "${cutoffStr}" AND labels in (${labelFilter}) ORDER BY updated DESC`;
      } else {
        // Channel-scoped: query by assignees who work in the scope channels
        const assignees = Object.entries(personChannel)
          .filter(([, ch]) => goal.scopeValues.includes(ch))
          .map(([name]) => `"${name}"`);
        if (!assignees.length) {
          result[goal.key] = { pulledAt: fmtDate(today), total: 0, groups: {} };
          console.log('no assignees in scope channels');
          continue;
        }
        jql = `project in (MKT, WE) AND statusCategory = Done AND updated >= "${cutoffStr}" AND assignee in (${assignees.join(',')}) ORDER BY updated DESC`;
      }

      const recentDone = await jiraSearch(jql, 'summary,assignee,issuetype,labels,status');

      // Group by BU or channel
      const groups = {};
      for (const issue of recentDone) {
        const summary  = issue.fields.summary || '';
        const assignee = issue.fields.assignee?.displayName || '';
        const labels   = issue.fields.labels || [];

        let groupKey = 'Other';
        if (goal.scopeType === 'bu') {
          const buResult = detectBU(labels, summary);
          groupKey = buResult ? normBU(buResult.bu) : (() => {
            const m = summary.match(/^\[([^\]]+)\]/);
            if (!m) return 'Other';
            const b = m[1].toUpperCase();
            return b === 'FF' ? 'FastField' : b === 'PAVE' ? 'Pave' :
                   b === 'CORE' ? 'Core (QB)' : b === 'CROSS-BU' ? 'Cross-BU' : m[1];
          })();
          // Clamp to declared scope
          if (!goal.scopeValues.includes(groupKey)) groupKey = 'Other';
        } else {
          groupKey = personChannel[assignee] || 'Other';
          if (!goal.scopeValues.includes(groupKey)) groupKey = 'Other';
        }

        if (!groups[groupKey]) groups[groupKey] = { count: 0, titles: [] };
        groups[groupKey].count++;
        if (groups[groupKey].titles.length < 3) {
          const clean = summary.replace(/^\[[^\]]+\]\s*/, '').replace(/^[Pp]\d+:\s*/, '').substring(0, 70);
          groups[groupKey].titles.push(clean);
        }
      }

      result[goal.key] = { pulledAt: fmtDate(today), total: recentDone.length, groups };
      const nonOther = Object.keys(groups).filter(k => k !== 'Other').length;
      console.log(`${recentDone.length} tasks done · ${nonOther} group(s)`);
    } catch (err) {
      console.warn(`ERROR — ${err.message}`);
      result[goal.key] = { pulledAt: fmtDate(today), total: 0, groups: {}, error: err.message };
    }
  }
  return result;
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
  const yr       = today.getFullYear();
  // Auto-detect current quarter — no manual date changes needed when Q changes
  const qNum        = Math.floor(today.getMonth() / 3) + 1; // 1-4
  const qStartMo    = Math.floor(today.getMonth() / 3) * 3;
  const qStart      = `${yr}-${String(qStartMo + 1).padStart(2, '0')}-01`;
  const qEndMo      = qStartMo + 3;
  const qEnd        = qEndMo > 11 ? `${yr + 1}-01-01` : `${yr}-${String(qEndMo + 1).padStart(2, '0')}-01`;
  const qLabel      = `Q${qNum}`;
  const qClosedKey  = `q${qNum}closed`;

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

  // ── 3. Build HISTORY entry (counts PEOPLE, not channels) ─────────────
  let ov = 0, hi = 0, ok = 0, lt = 0;
  for (const [, data] of Object.entries(personResults)) {
    if (!data) continue;
    if      (data.load === 'OVER')  ov++;
    else if (data.load === 'HIGH')  hi++;
    else if (data.load === 'OK')    ok++;
    else                            lt++;
  }
  const histEntry = {
    d: todayStr, w: fmtShort(today),
    ov, hi, ok, lt,
    ch: newCapData.channels.map(c => [c.ch, c.hours, c.load]),
  };

  // ── 4. Channel summary ────────────────────────────────────────────────
  console.log('\n── Channel Summary ──────────────────────────────────────────────');
  for (const ch of newCapData.channels) {
    const bar = '█'.repeat(Math.min(20, Math.round(ch.hours / 15)));
    console.log(`  ${ch.ch.padEnd(24)} ${String(ch.hours).padStart(4)}h  ${ch.load.padEnd(6)}  ${bar}`);
  }
  console.log(`\n  Load totals (people): OVER ${ov}  HIGH ${hi}  OK ${ok}  LIGHT ${lt}`);

  // ── 4b. Fetch ALL Q2 shipped items with deep categorization ──────────
  let shippedItems = [];
  let needsReview  = [];
  let q2Total      = 0;
  try {
    console.log(`\n── ${qLabel} Deliverables ─────────────────────────────────────────`);
    const result = await fetchAllQ2Shipped(TEAM, qStart, qEnd);
    shippedItems = result.shipped;
    needsReview  = result.needsReview;
    q2Total      = result.total;
  } catch (err) {
    console.warn(`  ⚠  Deliverables fetch failed (${err.message}) — shipped list unchanged`);
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
      console.log('\n[DRY RUN] strategic-data.json would be written');
    }
  } catch (err) {
    console.warn(`  ⚠  Strategic data fetch failed (${err.message})`);
  }

  // ── 5b. Fetch recent tasks per initiative (last 30 days) ──────────────
  console.log('\n── Recent Tasks per Initiative (last 30 days) ───────────────────');
  let recentTasksData = {};
  try {
    const personChannel = {};
    for (const p of TEAM) personChannel[p.displayName] = p.channel;
    recentTasksData = await fetchRecentTasksPerInitiative(STRATEGIC_GOALS, today, personChannel);
  } catch (err) {
    console.warn(`  ⚠  Recent tasks fetch failed (${err.message})`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] HISTORY entry that would be added:');
    console.log(JSON.stringify(histEntry, null, 2));
    console.log(`\n[DRY RUN] ${shippedItems.length} shipped items · ${needsReview.length} flagged for review`);
    console.log('\n[DRY RUN] No changes written.\n');
    return;
  }

  // ── 6. Write deliverables-review.json ────────────────────────────────
  if (needsReview.length > 0) {
    const reviewDoc = {
      generatedAt: fmtDate(today),
      total: needsReview.length,
      note: 'These items exhausted all categorization signals (labels, summary, description, comments, Claude). Please assign a BU label or channel in Jira.',
      items: needsReview,
    };
    fs.writeFileSync(REVIEW_PATH, JSON.stringify(reviewDoc, null, 2), 'utf8');
    console.log(`\n⚠  ${needsReview.length} items need review → deliverables-review.json`);
  } else {
    // Clear stale review file if everything was categorized
    if (fs.existsSync(REVIEW_PATH)) fs.writeFileSync(REVIEW_PATH, JSON.stringify({ generatedAt: fmtDate(today), total: 0, items: [] }, null, 2), 'utf8');
  }

  // ── 7. Write to index.html ────────────────────────────────────────────
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
      /shipped:\[[\s\S]*?\n  \],|shipped:\[\],/,
      `shipped:${jsLit(shippedItems, 1)},`
    );
    // Auto-update q{N}closed with live Jira count
    html = html.replace(
      new RegExp(`${qClosedKey}:\\s*\\d+,`),
      `${qClosedKey}: ${q2Total},`
    );
    console.log(`   DATA.shipped → ${shippedItems.length} items · ${qClosedKey} → ${q2Total}`);
  }

  // Inject RECENT_TASKS
  if (Object.keys(recentTasksData).length) {
    html = html.replace(
      /\/\* BEGIN:RECENT_TASKS \*\/[\s\S]*?\/\* END:RECENT_TASKS \*\//,
      `/* BEGIN:RECENT_TASKS */\nconst RECENT_TASKS = ${jsLit(recentTasksData)};\n/* END:RECENT_TASKS */`
    );
    console.log(`   RECENT_TASKS → ${Object.keys(recentTasksData).length} initiatives`);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    html = html.replace('YOUR_ANTHROPIC_API_KEY_HERE', process.env.ANTHROPIC_API_KEY);
  }

  fs.writeFileSync(HTML_PATH, html, 'utf8');

  // Sync root index.html so GitHub Pages serves the latest version
  fs.copyFileSync(HTML_PATH, ROOT_PATH);

  console.log(`\n✓  marketing-report/index.html updated`);
  console.log(`✓  index.html synced (GitHub Pages)`);
  console.log(`   CAP_DATA refreshed · HISTORY entry added · pulledAt → ${fmtDate(today)}\n`);
}

main().catch(err => {
  console.error('\n✗  Update failed:', err.message);
  process.exit(1);
});
