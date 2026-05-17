import { scaffold } from "./_scaffold-helper";

export const READ_NOTOR_SETTINGS = scaffold(
	"read_notor_settings",
	"Read the current Notor plugin settings.",
	"read",
	`params: {}`,
	`return JSON.stringify(utils.readPluginSettings(), null, 2);`,
);
