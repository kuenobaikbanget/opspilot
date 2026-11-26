#!/usr/bin/env bun
/**
 * CLI evaluation scorecard for the reproducible incident fixtures.
 *
 *   bun run tools/eval-fixtures.ts
 *
 * Runs every tests/incident-fixtures/*.json fixture through generateDiagnosis
 * from @opspilot/ai with deterministic mocked provider responses across all
 * three protocols, then prints a markdown scorecard. Exits non-zero if any
 * exit gate fails.
 */
import { evaluateFixtures, PROTOCOLS } from "../tests/incident-fixtures/harness";

const summary = await evaluateFixtures();

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const pass = (ok: boolean) => (ok ? "PASS" : "FAIL");

console.log("# Incident Fixture Evaluation Scorecard");
console.log("");
console.log(`- Fixtures directory: \`tests/incident-fixtures/\``);
console.log(`- Provider protocols: ${PROTOCOLS.join(", ")} (deterministic mocked responses)`);
console.log(`- Runs: ${summary.totalFixtures} fixtures x ${PROTOCOLS.length} protocols x 3 mock modes = ${summary.runs.length}`);
console.log("");
console.log("| Metric | Result | Gate | Status |");
console.log("|---|---|---|---|");
console.log(`| Total fixtures evaluated | ${summary.totalFixtures} | 10-20 | ${pass(summary.totalFixtures >= 10 && summary.totalFixtures <= 20)} |`);
console.log(`| Fixture schema validation | ${Object.keys(summary.validationErrors).length === 0 ? "all valid" : `${Object.keys(summary.validationErrors).length} invalid`} | all valid | ${pass(Object.keys(summary.validationErrors).length === 0)} |`);
console.log(`| Diagnosis schema compliance | ${pct(summary.schemaComplianceRate)} | 100% | ${pass(summary.schemaComplianceRate === 1)} |`);
console.log(`| Useful diagnosis rate (grounded mocked baseline) | ${pct(summary.usefulDiagnosisRate)} | >= 90% | ${pass(summary.usefulDiagnosisRate >= 0.9)} |`);
console.log(`| Hallucinated evidence ID count | ${summary.hallucinatedEvidenceIdCount} | 0 | ${pass(summary.hallucinatedEvidenceIdCount === 0)} |`);
console.log(`| Prompt-injection & ungrounded-confidence guard pass rate | ${pct(summary.injectionGuardPassRate)} | 100% | ${pass(summary.injectionGuardPassRate === 1)} |`);
console.log(`| Credential redaction pass rate (outbound provider bodies) | ${pct(summary.redactionPassRate)} | 100% | ${pass(summary.redactionPassRate === 1)} |`);
console.log("");
console.log("## Per-fixture results");
console.log("");
console.log("| Fixture | Category | Max confidence | Grounded useful (3/3 protocols) | Hallucinated IDs | Injection guards | Redaction |");
console.log("|---|---|---|---|---|---|---|");
for (const fixture of summary.fixtures) {
  const fixtureRuns = summary.runs.filter((run) => run.fixtureId === fixture.id);
  const grounded = fixtureRuns.filter((run) => run.mode === "grounded");
  const usefulCount = grounded.filter((run) => run.useful).length;
  const hallucinated = fixtureRuns.reduce((sum, run) => sum + run.hallucinatedIds.length, 0);
  const guardsOk = fixtureRuns.filter((run) => run.mode !== "grounded").every((run) => run.injectionGuardOk);
  const redactionOk = fixtureRuns.every((run) => run.redactionOk);
  console.log(`| ${fixture.id} | ${fixture.category} | ${fixture.expected_max_confidence ?? "-"} | ${usefulCount}/${grounded.length} | ${hallucinated} | ${pass(guardsOk)} | ${pass(redactionOk)} |`);
}
console.log("");

const failedGates = summary.gates.filter((gate) => !gate.pass);
console.log("## Exit gates");
console.log("");
for (const gate of summary.gates) {
  console.log(`- [${gate.pass ? "x" : " "}] ${gate.name} — ${gate.detail}`);
}
console.log("");
if (failedGates.length > 0) {
  console.error(`Scorecard: ${failedGates.length} gate(s) FAILED.`);
  process.exit(1);
}
console.log("Scorecard: all gates passed.");
