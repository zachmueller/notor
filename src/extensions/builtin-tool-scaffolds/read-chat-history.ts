import { scaffold } from "./_scaffold-helper";

export const READ_CHAT_HISTORY = scaffold(
	"read_chat_history",
	"Read the full message history of a past Notor conversation by its ID. Use search_chat_history first to find the conversation ID.",
	"read",
	`params:
  conversation_id:
    type: string
    description: "The UUID of the conversation to read. Obtain this from search_chat_history results."
  max_messages:
    type: number
    description: "Maximum number of messages to return (most recent first). Set to 0 for all messages."
    default: 50`,
	`const log = utils.logger("read_chat_history");

if (!utils.chatHistory) {
  throw new Error("Chat history is not available.");
}

const conversationId = ((params.conversation_id as string) || "").trim();
if (!conversationId) {
  throw new Error("Missing required parameter: conversation_id");
}

const maxMessages = Math.max(0, (params.max_messages as number) ?? 50);

log.info("Loading conversation", { conversationId, maxMessages });
const result = await utils.chatHistory.loadConversation(conversationId);

if (!result) {
  return {
    error: "not_found",
    message: "Conversation not found. It may have been deleted by the retention policy. Use search_chat_history to find valid conversation IDs.",
  };
}

let messages = result.messages;
if (maxMessages > 0 && messages.length > maxMessages) {
  const skipped = messages.length - maxMessages;
  messages = messages.slice(-maxMessages);
  return {
    conversation_id: result.id,
    title: result.title,
    created_at: result.created_at,
    updated_at: result.updated_at,
    messages,
    total_messages: result.messages.length,
    returned_messages: messages.length,
    note: skipped + " earlier messages omitted. Set max_messages to 0 for all.",
    deep_link: result.deep_link,
  };
}

return {
  conversation_id: result.id,
  title: result.title,
  created_at: result.created_at,
  updated_at: result.updated_at,
  messages,
  total_messages: messages.length,
  deep_link: result.deep_link,
};`,
);
