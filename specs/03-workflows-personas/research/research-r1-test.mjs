/**
 * R-1 Research: croner library evaluation
 * Tests: API surface, cron syntax, timezone, dynamic jobs, validation
 */
import { Cron, CronPattern } from "croner";

console.log("=== R-1: croner Library Evaluation ===\n");

// --- Q1: Basic compatibility ---
console.log("--- Q1: Basic Compatibility ---");
console.log("croner imported successfully (ESM)");
console.log("Cron constructor:", typeof Cron);
console.log("CronPattern constructor:", typeof CronPattern);

// --- Q2: Cron syntax support ---
console.log("\n--- Q2: Cron Syntax Support ---");

// Standard 5-field cron
const patterns = [
  { expr: "0 9 * * *", desc: "9 AM daily" },
  { expr: "*/15 * * * *", desc: "every 15 minutes" },
  { expr: "0 0 1 * *", desc: "first of month midnight" },
  { expr: "30 14 * * 1-5", desc: "2:30 PM weekdays" },
  { expr: "0 */6 * * *", desc: "every 6 hours" },
];

for (const { expr, desc } of patterns) {
  try {
    const p = new CronPattern(expr);
    const job = new Cron(expr, { paused: true }, () => {});
    const next = job.nextRun();
    console.log(`  ✅ "${expr}" (${desc}) — next: ${next}`);
    job.stop();
  } catch (e) {
    console.log(`  ❌ "${expr}" (${desc}) — error: ${e.message}`);
  }
}

// Shorthand aliases
console.log("\nShorthand aliases:");
const aliases = ["@yearly", "@monthly", "@weekly", "@daily", "@hourly"];
for (const alias of aliases) {
  try {
    const job = new Cron(alias, { paused: true }, () => {});
    const next = job.nextRun();
    console.log(`  ✅ "${alias}" — next: ${next}`);
    job.stop();
  } catch (e) {
    console.log(`  ❌ "${alias}" — error: ${e.message}`);
  }
}

// 6-field (with seconds) support
console.log("\n6-field (seconds) support:");
try {
  const job = new Cron("*/30 * * * * *", { paused: true }, () => {});
  const next = job.nextRun();
  console.log(`  ✅ "*/30 * * * * *" (every 30 seconds) — next: ${next}`);
  job.stop();
} catch (e) {
  console.log(`  ❌ "*/30 * * * * *" — error: ${e.message}`);
}

// --- Q3: Timezone handling ---
console.log("\n--- Q3: Timezone Handling ---");

// Per-job timezone
const tzTests = ["America/New_York", "Europe/London", "Pacific/Auckland", "UTC"];
for (const tz of tzTests) {
  try {
    const job = new Cron("0 9 * * *", { timezone: tz, paused: true }, () => {});
    const next = job.nextRun();
    console.log(`  ✅ timezone "${tz}" — next run: ${next}`);
    job.stop();
  } catch (e) {
    console.log(`  ❌ timezone "${tz}" — error: ${e.message}`);
  }
}

// Default (system/local timezone)
try {
  const jobLocal = new Cron("0 9 * * *", { paused: true }, () => {});
  const nextLocal = jobLocal.nextRun();
  console.log(`  ✅ no timezone (local default) — next run: ${nextLocal}`);
  jobLocal.stop();
} catch (e) {
  console.log(`  ❌ no timezone — error: ${e.message}`);
}

// --- Q4: Dynamic job management ---
console.log("\n--- Q4: Dynamic Job Management ---");

// Create, start, stop, destroy
let fireCount = 0;
const dynamicJob = new Cron("* * * * * *", { paused: true }, () => {
  fireCount++;
});

console.log(`  Job created (paused): isRunning=${dynamicJob.isRunning()}, isStopped=${dynamicJob.isStopped()}`);

// Resume the job
dynamicJob.resume();
console.log(`  Job resumed: isRunning=${dynamicJob.isRunning()}, isStopped=${dynamicJob.isStopped()}`);

// Wait 2.5 seconds to catch at least 1-2 fires
await new Promise((r) => setTimeout(r, 2500));
console.log(`  After 2.5s: fireCount=${fireCount}`);

// Pause the job
dynamicJob.pause();
console.log(`  Job paused: isRunning=${dynamicJob.isRunning()}, isStopped=${dynamicJob.isStopped()}`);
const countAfterPause = fireCount;

await new Promise((r) => setTimeout(r, 1500));
console.log(`  After pause + 1.5s: fireCount=${fireCount} (should be same as ${countAfterPause})`);

// Stop/destroy the job
dynamicJob.stop();
console.log(`  Job stopped: isRunning=${dynamicJob.isRunning()}, isStopped=${dynamicJob.isStopped()}`);

// Multiple independent jobs
console.log("\n  Multiple independent jobs:");
let jobACount = 0, jobBCount = 0;
const jobA = new Cron("* * * * * *", () => { jobACount++; });
const jobB = new Cron("* * * * * *", () => { jobBCount++; });

await new Promise((r) => setTimeout(r, 2500));
jobA.stop();
const jobAFinal = jobACount;
await new Promise((r) => setTimeout(r, 1500));
console.log(`  jobA stopped (count=${jobAFinal}), jobB still running (count=${jobBCount}, should be > ${jobAFinal})`);
jobB.stop();

// --- Q5: Validation API ---
console.log("\n--- Q5: Validation API ---");

const validationTests = [
  { expr: "0 9 * * *", shouldBeValid: true },
  { expr: "*/15 * * * *", shouldBeValid: true },
  { expr: "@daily", shouldBeValid: true },
  { expr: "invalid-cron", shouldBeValid: false },
  { expr: "99 99 99 99 99", shouldBeValid: false },
  { expr: "0 25 * * *", shouldBeValid: false },  // hour > 23
  { expr: "", shouldBeValid: false },
  { expr: "* * * *", shouldBeValid: false },  // only 4 fields
];

// Method 1: Try CronPattern constructor
console.log("  Using CronPattern constructor for validation:");
for (const { expr, shouldBeValid } of validationTests) {
  try {
    new CronPattern(expr);
    console.log(`  ${shouldBeValid ? "✅" : "⚠️ (expected invalid)"} "${expr}" — valid`);
  } catch (e) {
    console.log(`  ${!shouldBeValid ? "✅" : "⚠️ (expected valid)"} "${expr}" — invalid: ${e.message}`);
  }
}

// Check if there's a static validate method
console.log(`\n  Cron.validate exists: ${typeof Cron.validate}`);
if (typeof Cron.validate === "function") {
  console.log("  Testing Cron.validate():");
  console.log(`    "0 9 * * *" → ${Cron.validate("0 9 * * *")}`);
  console.log(`    "invalid" → ${Cron.validate("invalid")}`);
}

// --- Q6: Node.js-specific API check ---
console.log("\n--- Q6: Node.js API Dependencies ---");
// Read the source to check for Node-specific APIs
import { readFileSync } from "fs";
const source = readFileSync("node_modules/croner/dist/croner.js", "utf-8");
const nodeAPIs = ["require(", "process.", "fs.", "path.", "child_process", "Buffer.", "__dirname", "__filename", "global."];
console.log("  Checking for Node.js-specific APIs in croner.js:");
for (const api of nodeAPIs) {
  const found = source.includes(api);
  console.log(`  ${found ? "⚠️ Found" : "✅ Not found"}: "${api}"`);
}

console.log("\n=== R-1 Research Complete ===");
