#!/usr/bin/env node
// Stand-in for the sherpa-onnx keyword-spotter sidecar used by the voice e2e
// scripts. Configured as `voice_kws_python_path`, so it is spawned as
// `fake-kws.mjs -u -c <wrapper script> --model-dir … --keyword … [--variant …]`;
// the wrapper script is ignored. It speaks the wrapper's JSON-line protocol:
//   - prints {"type":"ready"} at start,
//   - counts 16-bit samples read from stdin,
//   - emits {"type":"hit"} whenever NOTOR_E2E_KWS_HIT_FILE appears (then deletes it).
// The launch arguments are logged to NOTOR_E2E_KWS_LOG_FILE for assertions.
import fs from "node:fs";

const hitFile = process.env.NOTOR_E2E_KWS_HIT_FILE ?? "/tmp/notor-e2e-kws-hit.txt";
const logFile = process.env.NOTOR_E2E_KWS_LOG_FILE ?? "/tmp/notor-e2e-kws.log";

const args = process.argv.slice(2);
const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), keyword: values("--keyword")[0], variants: values("--variant"), modelDir: values("--model-dir")[0] }) + "\n");

let samples = 0;
process.stdin.on("data", (chunk) => {
	samples += Math.floor(chunk.length / 2);
});
process.stdin.on("end", () => process.exit(0));

process.stdout.write(JSON.stringify({ type: "ready", version: "fake" }) + "\n");

setInterval(() => {
	if (!fs.existsSync(hitFile)) return;
	fs.rmSync(hitFile, { force: true });
	process.stdout.write(JSON.stringify({ type: "hit", keyword: "hey_notor", endSample: samples }) + "\n");
}, 100);

process.on("SIGTERM", () => process.exit(0));
