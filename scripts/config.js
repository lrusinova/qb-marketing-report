// config.js — Team roster and channel definitions for the dashboard auto-updater.
// jiraName must match the display name exactly as it appears in Jira (check a ticket assignee field).
// Add/remove team members here as the team changes.

const TEAM = [
  // ── Content & SEO ───────────────────────────────────────────────────
  { displayName: 'Patro, Shreya',           jiraName: 'Shreya Patro',           channel: 'Content & SEO',        project: 'mkt' },
  { displayName: 'Husain, Javeria',         jiraName: 'Javeria Husain',         channel: 'Content & SEO',        project: 'mkt' },
  { displayName: 'Krishnamurthy, Niveditha',jiraName: 'Niveditha Krishnamurthy',channel: 'Content & SEO',        project: 'mkt' },
  { displayName: 'Wahl, Nathan',            jiraName: 'Nathan Wahl',            channel: 'Content & SEO',        project: 'mkt' },

  // ── Email & Lifecycle ────────────────────────────────────────────────
  { displayName: 'Schiff, Ayva',            jiraName: 'Ayva Schiff',            channel: 'Email & Lifecycle',    project: 'mkt' },
  { displayName: 'Caufield, Karen',         jiraName: 'Karen Caufield',         channel: 'Email & Lifecycle',    project: 'mkt' },
  { displayName: 'Lynch, Emma',             jiraName: 'Emma Lynch',             channel: 'Email & Lifecycle',    project: 'mkt' },
  { displayName: 'Scura, Coco',             jiraName: 'Coco Scura',             channel: 'Email & Lifecycle',    project: 'mkt' },

  // ── Creative & Design ────────────────────────────────────────────────
  { displayName: 'Mora, Jasmin',            jiraName: 'Jasmin Mora',            channel: 'Creative & Design',    project: 'mkt' },
  { displayName: 'Liu, Jenny',              jiraName: 'Jenny Liu',              channel: 'Creative & Design',    project: 'mkt' },

  // ── Demand Gen ──────────────────────────────────────────────────────
  { displayName: 'McPhee, Stephanie',       jiraName: 'Stephanie McPhee',       channel: 'Demand Gen',           project: 'mkt' },
  { displayName: 'Kleiner, Charlie',        jiraName: 'Charlie Kleiner',        channel: 'Demand Gen',           project: 'mkt' },

  // ── Social Media ─────────────────────────────────────────────────────
  { displayName: 'Rich, Sarah',             jiraName: 'Sarah Rich',             channel: 'Social Media',         project: 'mkt' },

  // ── PMM / Product ────────────────────────────────────────────────────
  { displayName: 'Decker, Michael',         jiraName: 'Michael Decker',         channel: 'PMM / Product',        project: 'mkt' },
  { displayName: 'Saeed, Hira',             jiraName: 'Hira Saeed',             channel: 'PMM / Product',        project: 'mkt' },
  { displayName: 'Hendley, Michelle',       jiraName: 'Michelle Hendley',       channel: 'PMM / Product',        project: 'mkt' },

  // ── Web & Digital (WE project) ───────────────────────────────────────
  { displayName: 'Young-Ward, Michael',     jiraName: 'Michael Young-Ward',     channel: 'Web & Digital',        project: 'we' },
  { displayName: 'Radev, Tihomir',          jiraName: 'Tihomir Radev',          channel: 'Web & Digital',        project: 'we' },
  { displayName: 'Bogdanov, Iliyan',        jiraName: 'Iliyan Bogdanov',        channel: 'Web & Digital',        project: 'we' },

  // ── UX & Design (WE project) ─────────────────────────────────────────
  { displayName: 'Boyanova, Kristina',      jiraName: 'Kristina Boyanova',      channel: 'UX & Design',          project: 'we' },

  // ── Program Management ───────────────────────────────────────────────
  { displayName: 'Maganini, Joey',          jiraName: 'Joey Maganini',          channel: 'Program Management',   project: 'mkt' },
  { displayName: 'Rusinova, Luiza',         jiraName: 'Luiza Rusinova',         channel: 'Program Management',   project: 'mkt' },

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
