import { scaffold } from "./_scaffold-helper";

export const SEARCH_CHAT_HISTORY = scaffold(
	"search_chat_history",
	"Search past Notor conversations by keyword. Returns matching conversation metadata with IDs that can be used with read_chat_history.",
	"read",
	`params:
  query:
    type: string
    description: "Search query to match against conversation titles and message content. Case-insensitive. Leave empty to list recent conversations."
    default: ""
  limit:
    type: number
    description: "Maximum number of results to return (1–50)."
    default: 10`,
	`const log = utils.logger("search_chat_history");

if (!utils.chatHistory) {
  throw new Error("Chat history is not available.");
}

const query = ((params.query as string) || "").trim();
const limit = Math.min(Math.max(1, (params.limit as number) || 10), 50);

if (!query) {
  log.info("Listing recent conversations", { limit });
  const recent = await utils.chatHistory.listRecent(limit);
  return {
    conversations: recent,
    total: recent.length,
    note: "No query provided — showing most recent conversations. Each conversation includes a deep_link that can be used in markdown links.",
  };
}

log.info("Searching conversations", { query, limit });
const results = await utils.chatHistory.search(query);
const trimmed = results.slice(0, limit);

return {
  query,
  conversations: trimmed,
  total_matches: results.length,
  returned: trimmed.length,
};`,
);
