#!/usr/bin/env node
// Stand-in for whisper.cpp's `whisper-server` used by the voice e2e scripts.
// Accepts the same flags (-m, --host, --port, -l, --prompt, ...) and serves:
//   GET  /            → 200 (readiness probe)
//   POST /inference   → {"text": <contents of NOTOR_E2E_WHISPER_TEXT_FILE or a default>}
// Every inference request is appended to NOTOR_E2E_WHISPER_LOG_FILE for assertions.
import http from "node:http";
import fs from "node:fs";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8178;
const textFile = process.env.NOTOR_E2E_WHISPER_TEXT_FILE ?? "/tmp/notor-e2e-whisper-text.txt";
const logFile = process.env.NOTOR_E2E_WHISPER_LOG_FILE ?? "/tmp/notor-e2e-whisper.log";

function transcript() {
	try {
		const text = fs.readFileSync(textFile, "utf8").trim();
		if (text) return text;
	} catch {
		// no canned transcript configured
	}
	return "hello from the fake whisper server";
}

const server = http.createServer((req, res) => {
	if (req.method === "POST" && req.url === "/inference") {
		let size = 0;
		req.on("data", (chunk) => { size += chunk.length; });
		req.on("end", () => {
			const text = transcript();
			fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), bytes: size, contentType: req.headers["content-type"] ?? "", text }) + "\n");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ text }));
		});
		return;
	}
	res.writeHead(req.url === "/" ? 200 : 404, { "Content-Type": "text/plain" });
	res.end(req.url === "/" ? "fake whisper server\n" : "not found\n");
});

server.listen(port, "127.0.0.1", () => {
	process.stderr.write(`fake whisper-server listening on ${port} (model: ${args[args.indexOf("-m") + 1] ?? "?"})\n`);
});
process.on("SIGTERM", () => { server.close(); process.exit(0); });
