// Standalone script — NOT part of the Express app lifecycle.
// Run with: node scripts/reconcileTaxonomy.js   (from server/)
//
// Thin CLI wrapper around mcqService.reconcileTaxonomy() — the same
// admin-triggered check available at GET /api/mcqs/taxonomy/reconcile,
// exposed here as a script for a one-off/CI-friendly run (same
// relationship seedTaxonomyFromMcqs.js has to the app: reads-only
// against MCQ, and here also read-only against TaxonomyNode — this
// script never writes to either collection).
//
// Exit code: 0 if no drift found, 1 if drift found OR the script itself
// errored — lets this be wired into a CI/cron job that alerts on
// anything other than a clean run.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import { reconcileTaxonomy } from '../src/services/mcq.service.js';

const run = async () => {
  let connected = false;

  try {
    await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
    connected = true;

    const report = await reconcileTaxonomy();

    console.log('── reconcileTaxonomy summary ──────────────────────────────────');
    console.log(`Orphan MCQ triples (no matching TaxonomyNode): ${report.orphan_count}`);
    for (const t of report.orphan_mcq_triples) {
      console.log(`  - subject="${t.subject}" topic="${t.topic}" subtopic="${t.subtopic}"`);
    }
    console.log(`Empty TaxonomyNodes (zero matching MCQs):      ${report.empty_count}`);
    for (const n of report.empty_taxonomy_nodes) {
      const path = [n.subject, n.topic, n.subtopic].filter((v) => v !== undefined).join(' / ');
      console.log(`  - [${n.type}] ${path}`);
    }

    if (report.is_clean) {
      console.log('✅ No drift found — TaxonomyNode and MCQ agree.');
      process.exitCode = 0;
    } else {
      console.log('⚠️  Drift found — see above. Nothing was auto-fixed.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('❌ reconcileTaxonomy script failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
    process.exit(process.exitCode ?? 1);
  }
};

run();
