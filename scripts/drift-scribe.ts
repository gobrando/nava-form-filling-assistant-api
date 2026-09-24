import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatScorecard, renderReport, scoreDriftLab } from '@/lib/playbooks/drift-lab';

/**
 * Scores the drift fixtures with the deterministic scribe.
 *
 * No database, no model, no browser. Prints a scorecard and writes
 * reports/scribe-drift.md. Exit status is not the product verdict: a
 * refusal is a finding, and the tests lock the ones that must stay refusals.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scores = scoreDriftLab(root);
const reportPath = join(root, 'reports/scribe-drift.md');
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, renderReport(scores));
console.log(formatScorecard(scores));
console.log(`Wrote ${reportPath}`);
