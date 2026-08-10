const fs = require("fs");
const path = require("path");

const WORKFLOWS_DIR = path.join(__dirname, "..", "..", "workflows");

// This is the Dynamic Workflow Engine's data source: every *.json file in
// workflows/ becomes a bookable business type. Adding a new industry (e.g.
// "restaurant") means adding restaurant.json here — no code changes.
function loadWorkflows() {
  const workflows = {};
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
    const workflow = JSON.parse(raw);

    const hasInventory = workflow.providers?.length || workflow.hotels?.length;
    if (!workflow.id || !workflow.label || !hasInventory || !workflow.steps?.length) {
      throw new Error(`Invalid workflow definition in ${file}: requires id, label, providers[] or hotels[], steps[]`);
    }
    // Normalized here, once, so every consumer (classify.js's keyword
    // fallback, the mid-flow reclassify pre-check) can assume this is
    // always an array — found live: workflows/service.json has no
    // "keywords" field at all, and two separate call sites did
    // `workflow.keywords.some(...)` with no guard. That was a latent
    // crash that Section 0's timeout work made much more likely to hit,
    // since a timed-out Groq call now falls through to the keyword path
    // far more often than an occasional real API failure did.
    workflow.keywords = workflow.keywords || [];
    workflows[workflow.id] = workflow;
  }

  return workflows;
}

module.exports = { loadWorkflows };
