// config.js — Team roster and channel definitions for the dashboard auto-updater.
// jiraName must match the display name exactly as it appears in Jira (check a ticket assignee field).
// Add/remove team members here as the team changes.

const TEAM = [
  // ── Content & SEO ───────────────────────────────────────────────────
  { displayName: 'Patro, Shreya',           jiraName: 'Patro, Shreya',           channel: 'Content & SEO',        project: 'mkt' },
  { displayName: 'Husain, Javeria',         jiraName: 'Husain, Javeria',         channel: 'Content & SEO',        project: 'mkt' },
  { displayName: 'Krishnamurthy, Niveditha',jiraName: 'Krishnamurthy, Niveditha',channel: 'Content & SEO',        project: 'mkt' },
  { displayName: 'Wahl, Nathan',            jiraName: 'Wahl, Nathan',            channel: 'Content & SEO',        project: 'mkt' },

  // ── Email & Lifecycle ────────────────────────────────────────────────
  { displayName: 'Schiff, Ayva',            jiraName: 'Schiff, Ayva',            channel: 'Email & Lifecycle',    project: 'mkt' },
  { displayName: 'Caufield, Karen',         jiraName: 'Caufield, Karen',         channel: 'Email & Lifecycle',    project: 'mkt' },
  { displayName: 'Lynch, Emma',             jiraName: 'Lynch, Emma',             channel: 'Email & Lifecycle',    project: 'mkt' },
  { displayName: 'Scura, Coco',             jiraName: 'Scura, Coco',             channel: 'Email & Lifecycle',    project: 'mkt' },

  // ── Creative & Design ────────────────────────────────────────────────
  { displayName: 'Mora, Jasmin',            jiraName: 'Mora, Jasmin',            channel: 'Creative & Design',    project: 'mkt' },
  { displayName: 'Liu, Jenny',              jiraName: 'Liu, Jenny',              channel: 'Creative & Design',    project: 'mkt' },

  // ── Demand Gen ──────────────────────────────────────────────────────
  { displayName: 'McPhee, Stephanie',       jiraName: 'McPhee, Stephanie',       channel: 'Demand Gen',           project: 'mkt' },
  { displayName: 'Kleiner, Charlie',        jiraName: 'Kleiner, Charlie',        channel: 'Demand Gen',           project: 'mkt' },

  // ── Social Media ─────────────────────────────────────────────────────
  { displayName: 'Rich, Sarah',             jiraName: 'Rich, Sarah',             channel: 'Social Media',         project: 'mkt' },

  // ── PMM / Product ────────────────────────────────────────────────────
  { displayName: 'Decker, Michael',         jiraName: 'Decker, Michael',         channel: 'PMM / Product',        project: 'mkt' },
  { displayName: 'Saeed, Hira',             jiraName: 'Saeed, Hira',             channel: 'PMM / Product',        project: 'mkt' },
  { displayName: 'Hendley, Michelle',       jiraName: 'Hendley, Michelle',       channel: 'PMM / Product',        project: 'mkt' },

  // ── Web & Digital (WE project) ───────────────────────────────────────
  { displayName: 'Young-Ward, Michael',     jiraName: 'Young-Ward, Michael',     channel: 'Web & Digital',        project: 'we' },
  { displayName: 'Radev, Tihomir',          jiraName: 'Radev, Tihomir',          channel: 'Web & Digital',        project: 'we' },
  { displayName: 'Bogdanov, Iliyan',        jiraName: 'Bogdanov, Iliyan',        channel: 'Web & Digital',        project: 'we' },

  // ── UX & Design (WE project) ─────────────────────────────────────────
  { displayName: 'Boyanova, Kristina',      jiraName: 'Boyanova, Kristina',      channel: 'UX & Design',          project: 'we' },

  // ── Program Management ───────────────────────────────────────────────
  { displayName: 'Maganini, Joey',          jiraName: 'Maganini, Joey',          channel: 'Program Management',   project: 'mkt' },
  { displayName: 'Rusinova, Luiza',         jiraName: 'Rusinova, Luiza',         channel: 'Program Management',   project: 'mkt' },

  // ── TODO: Add remaining channels ────────────────────────────────────
  // Marketing Analytics, Events & Experiences, Community, PR & Comms
  // { displayName: 'Waldron, Tory', jiraName: 'Tory Waldron', channel: 'PR & Comms', project: 'mkt' },
];

// Channel order matches the dashboard display order.
// Channels not represented in TEAM still appear with 0 items (keeps history consistent).
const CHANNELS = [
  { name: 'Content & SEO'        },
  { name: 'Email & Lifecycle'    },
  { name: 'Creative & Design'    },
  { name: 'Demand Gen'           },
  { name: 'Social Media'         },
  { name: 'PMM / Product'        },
  { name: 'Marketing Analytics'  },
  { name: 'Events & Experiences' },
  { name: 'Community'            },
  { name: 'PR & Comms'           },
  { name: 'Web & Digital'        },
  { name: 'UX & Design'          },
  { name: 'Program Management'   },
];

module.exports = { TEAM, CHANNELS };
