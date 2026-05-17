import { scaffold } from "./_scaffold-helper";

export const FETCH_WEBPAGE = scaffold(
	"fetch_webpage",
	"Fetch a webpage by URL and return its content converted to Markdown.",
	"read",
	`params:
  url:
    type: string
    description: "URL of the webpage to fetch."
settings:
  fetch_webpage_timeout:
    name: "Request Timeout"
    type: number
    description: "Timeout in seconds for HTTP requests."
    default: 15
    min: 1
    max: 120
  fetch_webpage_max_download_mb:
    name: "Max Download Size (MB)"
    type: number
    description: "Maximum response body size in megabytes."
    default: 5
    min: 1
    max: 50
  fetch_webpage_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters returned to the LLM. Longer content is truncated."
    default: 50000
    min: 1000
    max: 500000`,
	`const log = utils.logger("fetch_webpage");

const USER_AGENT = "Notor/1.0";

// --- Chromium net error hints ---
const CHROMIUM_NET_ERROR_HINTS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "DNS lookup failed — check the hostname or your network connection",
  ERR_CONNECTION_REFUSED: "Connection refused — the server may be down or blocking requests",
  ERR_CONNECTION_TIMED_OUT: "Connection timed out — the server took too long to respond",
  ERR_CONNECTION_RESET: "Connection reset by the server — it may have dropped the connection",
  ERR_INTERNET_DISCONNECTED: "No internet connection detected",
  ERR_SSL_PROTOCOL_ERROR: "SSL/TLS handshake failed — the site may have a certificate issue",
  ERR_CERT_AUTHORITY_INVALID: "SSL certificate not trusted — the certificate may be self-signed or expired",
  ERR_CERT_DATE_INVALID: "SSL certificate has expired or is not yet valid",
  ERR_BLOCKED_BY_CLIENT: "Request blocked by a browser extension or content policy",
  ERR_TOO_MANY_REDIRECTS: "Too many redirects — the URL may be in a redirect loop",
  ERR_INVALID_URL: "The URL is malformed or not supported by the network stack",
  ERR_NETWORK_CHANGED: "Network changed during the request — try again",
  ERR_ADDRESS_UNREACHABLE: "The server address is unreachable — it may be on a private or unavailable network",
  ERR_EMPTY_RESPONSE: "The server returned an empty response",
  ERR_FAILED: "Generic network failure — check your internet connection, proxy settings, or try again",
};

function getNetErrorHint(errorMessage: string): string | null {
  for (const [code, hint] of Object.entries(CHROMIUM_NET_ERROR_HINTS)) {
    if (errorMessage.includes(code)) return hint;
  }
  return null;
}

function initTurndown(): any {
  const td = new libs.Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use(libs.turndownGfm.gfm);
  td.addRule("stripNav", {
    filter: ["nav", "footer", "aside"],
    replacement: () => "",
  });
  td.addRule("stripForms", {
    filter: ["form", "input", "select", "button"],
    replacement: () => "",
  });
  return td;
}

// --- Main logic ---

const url = params.url as string;

if (!url || typeof url !== "string") {
  throw new Error("Missing required parameter: url");
}

let parsedUrl: URL;
try {
  parsedUrl = new URL(url);
} catch {
  throw new Error(\`Invalid URL: \${url}\`);
}

if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
  throw new Error(\`Unsupported protocol: \${parsedUrl.protocol}. Only http:// and https:// URLs are accepted.\`);
}

// Domain denylist check
const denyCheck = utils.isDomainBlocked(url, shared.domain_denylist ?? []);
if (denyCheck.blocked) {
  log.info("Domain blocked by denylist", { url, pattern: denyCheck.pattern });
  throw new Error(\`Domain \${parsedUrl.hostname} is blocked by your denylist.\`);
}

const timeoutMs = (settings.fetch_webpage_timeout as number) * 1000;
const maxDownloadBytes = (settings.fetch_webpage_max_download_mb as number) * 1024 * 1024;
const maxOutputChars = settings.fetch_webpage_max_output_chars as number;

log.info("Fetching webpage", {
  url,
  timeout: \`\${settings.fetch_webpage_timeout}s\`,
  maxDownloadMb: settings.fetch_webpage_max_download_mb,
});

let body: string;
let mimeType: string;
try {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(\`Request timed out after \${Math.round(timeoutMs / 1000)} seconds.\`)),
      timeoutMs,
    ),
  );

  const response = await Promise.race([
    obsidian.requestUrl({
      url,
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      throw: false,
    }),
    timeoutPromise,
  ]);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(\`HTTP request failed with status \${response.status}.\`);
  }

  const bodyBytes = new TextEncoder().encode(response.text).length;
  if (bodyBytes > maxDownloadBytes) {
    throw new Error(\`Response body too large: download aborted at \${settings.fetch_webpage_max_download_mb} MB.\`);
  }

  const contentType = response.headers["content-type"] ?? "";
  mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  body = response.text;
} catch (e: any) {
  const message = e instanceof Error ? e.message : String(e);

  // Diagnostic probe with native fetch
  let nativeFetchResult: string;
  try {
    const probe = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    nativeFetchResult = \`native fetch OK (status \${probe.status})\`;
  } catch (probeErr: any) {
    nativeFetchResult = \`native fetch also failed: \${probeErr instanceof Error ? probeErr.message : String(probeErr)}\`;
  }

  const hint = getNetErrorHint(message);
  const enhanced = hint
    ? \`Failed to fetch URL: \${message} — \${hint}\`
    : message;

  log.warn("Fetch failed", { url, error: message, nativeFetchResult });
  throw new Error(\`\${enhanced} [diagnostic: \${nativeFetchResult}]\`);
}

let content: string;
if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
  try {
    content = initTurndown().turndown(body);
  } catch {
    content = body;
  }
} else if (mimeType.startsWith("text/") || mimeType === "application/json") {
  content = body;
} else {
  throw new Error(\`Content type '\${mimeType}' is not supported. Only text/html, text/*, and application/json are supported.\`);
}

// Output character cap
const totalLength = content.length;
if (totalLength > maxOutputChars) {
  const truncated = content.substring(0, maxOutputChars);
  log.info("Output truncated", { url, totalLength, maxOutputChars });
  if (utils.tempOutputSpiller) {
    return await utils.tempOutputSpiller.spillToFile("fetch_webpage", content, truncated, maxOutputChars);
  }
  return truncated +
    \`\\n\\nNote: page was truncated at \${maxOutputChars.toLocaleString()} characters; total fetched length was \${totalLength.toLocaleString()} characters.\`;
}

log.info("Fetch complete", { url, contentType: mimeType, contentLength: content.length });
return content;`,
);
