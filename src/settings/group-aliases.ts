/**
 * Settings-group title aliases.
 *
 * A group title is simultaneously its heading, its persisted key in
 * `settings_collapsed_sections`, and its `notor-settings://<Title>` deep-link
 * target. When a group is renamed, old deep links (in docs, built-in persona
 * copies a user customized, or past chat messages) keep resolving here.
 */
export const SETTINGS_GROUP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	Orchestration: "Circuits",
});

/** Resolve a possibly-renamed settings group title to its current title. */
export function canonicalSettingsGroup(title: string): string {
	return Object.prototype.hasOwnProperty.call(SETTINGS_GROUP_ALIASES, title) ? SETTINGS_GROUP_ALIASES[title]! : title;
}
