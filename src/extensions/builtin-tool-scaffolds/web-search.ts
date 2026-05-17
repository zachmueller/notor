import { scaffold } from "./_scaffold-helper";

export const WEB_SEARCH = scaffold(
	"web_search",
	"Search the web via DuckDuckGo and return results with titles, URLs, and snippets.",
	"read",
	`params:
  query:
    type: string
    description: "Search query string."
  num_results:
    type: number
    description: "Number of results to return. Maximum 10."
    default: 5
settings:
  web_search_timeout:
    name: "Request Timeout"
    type: number
    description: "Maximum time in seconds to wait for search results before aborting."
    default: 10
    min: 1
    max: 120
  web_search_default_num_results:
    name: "Default Number of Results"
    type: number
    description: "Number of search results returned when the LLM does not specify a count (1–10)."
    default: 5
    min: 1
    max: 10
  web_search_duckduckgo_delay_ms:
    name: "Throttle Delay (ms)"
    type: number
    description: "Minimum delay between DuckDuckGo requests to avoid rate-limiting."
    default: 1500
    min: 0
    max: 10000`,
	`const log = utils.logger("web_search");

const query = params.query as string;

if (!query || typeof query !== "string") {
  throw new Error("Missing required parameter: query");
}

const rawNum = typeof params.num_results === "number"
  ? params.num_results
  : (settings.web_search_default_num_results as number);
const numResults = Math.max(1, Math.min(10, Math.round(rawNum)));
const timeoutMs = (settings.web_search_timeout as number) * 1000;

log.info("Web search initiated", { query, numResults, timeoutMs });

// Delegate to multi-provider queue infrastructure
const searchResult = await utils.webSearch.search(query, numResults, timeoutMs, utils.abortSignal);

if (searchResult.error) {
  throw new Error(searchResult.error);
}

if (searchResult.failures.length > 0) {
  log.warn("Some providers failed before success", { failures: searchResult.failures });
}

log.debug("Search fulfilled", { provider: searchResult.provider, rawCount: searchResult.results.length });

// Filter out blocked domains
const denylist = shared.domain_denylist ?? [];
const results = searchResult.results.filter((r: any) => {
  const check = utils.isDomainBlocked(r.url, denylist);
  if (check.blocked) {
    log.debug("Filtered blocked domain", { url: r.url, pattern: check.pattern });
  }
  return !check.blocked;
});

if (results.length === 0) {
  return \`No results found for query: \${query}\`;
}

// Format output as numbered markdown list
const lines: string[] = [
  \`Web search results for "\${query}" (\${results.length} result\${results.length === 1 ? "" : "s"}):\`,
  "",
];

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  lines.push(\`\${i + 1}. **[\${r.title}](\${r.url})**\`);
  if (r.snippet) lines.push(\`   \${r.snippet}\`);
  lines.push("");
}

const output = lines.join("\\n").trimEnd();
log.info("Web search completed", { query, resultCount: results.length, provider: searchResult.provider });
return output;`,
);
