export type { BuiltinToolScaffold } from "../types";
import type { BuiltinToolScaffold } from "../types";
import type { SettingsFieldSchema } from "../types";

import { READ_NOTE } from "./read-note";
import { SEARCH_VAULT } from "./search-vault";
import { LIST_VAULT } from "./list-vault";
import { READ_FRONTMATTER } from "./read-frontmatter";
import { WORD_COUNT } from "./word-count";
import { GET_BACKLINKS } from "./get-backlinks";
import { GET_OUTLINKS } from "./get-outlinks";
import { WRITE_NOTE } from "./write-note";
import { REPLACE_IN_NOTE } from "./replace-in-note";
import { UPDATE_FRONTMATTER } from "./update-frontmatter";
import { MANAGE_TAGS } from "./manage-tags";
import { MOVE_NOTE } from "./move-note";
import { DELETE_NOTE } from "./delete-note";
import { FETCH_WEBPAGE } from "./fetch-webpage";
import { WEB_SEARCH } from "./web-search";
import { EXECUTE_COMMAND } from "./execute-command";
import { READ_FILE } from "./read-file";
import { READ_DOCX } from "./read-docx";
import { IMPORT_DOCX } from "./import-docx";
import { WRITE_DOCX } from "./write-docx";
import { WRITE_FILE } from "./write-file";
import { REPLACE_IN_FILE } from "./replace-in-file";
import { EXTRACT_DOCX_COMMENTS } from "./extract-docx-comments";
import { SLEEP } from "./sleep";
import { ASK_USER } from "./ask-user";
import { SEARCH_CHAT_HISTORY } from "./search-chat-history";
import { READ_CHAT_HISTORY } from "./read-chat-history";
import { CAPTURE_MEMORY } from "./capture-memory";
import { LIST_TEMPLATES } from "./list-templates";
import { APPLY_TEMPLATE } from "./apply-template";
import { WEBVIEW } from "./webview";
import { READ_NOTOR_SETTINGS } from "./read-notor-settings";
import { EDIT_NOTOR_SETTINGS } from "./edit-notor-settings";
import { EMIT_EVENT } from "./emit-event";

/**
 * All built-in tool scaffolds, keyed by tool name.
 *
 * Used by:
 * - `ExtensionManager.ensureBuiltinToolVaultFile()` to create vault files on demand
 * - `ExtensionManager.resetBuiltinToolToDefault()` to restore vault files
 * - Extensions settings section to enumerate built-in tools
 */
export const BUILTIN_TOOL_SCAFFOLDS: ReadonlyMap<string, BuiltinToolScaffold> =
	new Map([
		[READ_NOTE.name, READ_NOTE],
		[SEARCH_VAULT.name, SEARCH_VAULT],
		[LIST_VAULT.name, LIST_VAULT],
		[READ_FRONTMATTER.name, READ_FRONTMATTER],
		[WORD_COUNT.name, WORD_COUNT],
		[GET_BACKLINKS.name, GET_BACKLINKS],
		[GET_OUTLINKS.name, GET_OUTLINKS],
		[WRITE_NOTE.name, WRITE_NOTE],
		[REPLACE_IN_NOTE.name, REPLACE_IN_NOTE],
		[UPDATE_FRONTMATTER.name, UPDATE_FRONTMATTER],
		[MANAGE_TAGS.name, MANAGE_TAGS],
		[MOVE_NOTE.name, MOVE_NOTE],
		[DELETE_NOTE.name, DELETE_NOTE],
		[FETCH_WEBPAGE.name, FETCH_WEBPAGE],
		[WEB_SEARCH.name, WEB_SEARCH],
		[EXECUTE_COMMAND.name, EXECUTE_COMMAND],
		[READ_FILE.name, READ_FILE],
		[READ_DOCX.name, READ_DOCX],
		[IMPORT_DOCX.name, IMPORT_DOCX],
		[WRITE_DOCX.name, WRITE_DOCX],
		[WRITE_FILE.name, WRITE_FILE],
		[REPLACE_IN_FILE.name, REPLACE_IN_FILE],
		[EXTRACT_DOCX_COMMENTS.name, EXTRACT_DOCX_COMMENTS],
		[SLEEP.name, SLEEP],
		[ASK_USER.name, ASK_USER],
		[SEARCH_CHAT_HISTORY.name, SEARCH_CHAT_HISTORY],
		[READ_CHAT_HISTORY.name, READ_CHAT_HISTORY],
		[CAPTURE_MEMORY.name, CAPTURE_MEMORY],
		[LIST_TEMPLATES.name, LIST_TEMPLATES],
		[APPLY_TEMPLATE.name, APPLY_TEMPLATE],
		[WEBVIEW.name, WEBVIEW],
		[READ_NOTOR_SETTINGS.name, READ_NOTOR_SETTINGS],
		[EDIT_NOTOR_SETTINGS.name, EDIT_NOTOR_SETTINGS],
		[EMIT_EVENT.name, EMIT_EVENT],
	]);

/**
 * Default shared settings schema, used when no `notor/settings.md` exists.
 *
 * Declares the two cross-tool settings (`domain_denylist`, `read_file_allowed_paths`)
 * so they are always available in the `shared` object passed to tool functions.
 * If a user-authored `notor/settings.md` exists, it takes precedence.
 */
export const BUILTIN_SHARED_SETTINGS_SCHEMA: readonly SettingsFieldSchema[] = [
	{
		key: "domain_denylist",
		name: "Domain denylist",
		type: "string[]",
		description: "Domains blocked from fetch_webpage and web_search requests.",
		default: [],
	},
	{
		key: "read_file_allowed_paths",
		name: "Allowed file-system paths",
		type: "string[]",
		description: "Absolute paths outside the vault that read_file, write_file, replace_in_file, and DOCX tools may access.",
		default: [],
	},
];
