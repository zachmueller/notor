import type { BuiltinToolScaffold } from "../types";

export function scaffold(
	name: string,
	description: string,
	mode: "read" | "write",
	yamlFenceContent: string,
	code = '// Built-in tool override. Customize the code below.\n// The built-in implementation runs when this file doesn\'t exist.\nreturn "Not yet customized — remove this line and add your implementation.";',
	featureGroup?: string,
	awaitsUserInput = false,
): BuiltinToolScaffold {
	const trimmedYaml = yamlFenceContent.trimEnd();
	const featureGroupLine = featureGroup ? `\nnotor-feature-group: ${featureGroup}` : "";
	const awaitsLine = awaitsUserInput ? "\nnotor-awaits-user-input: true" : "";
	return {
		name,
		description,
		mode,
		featureGroup,
		awaitsUserInput,
		scaffoldContent:
`---
notor-type: tool
notor-tool-name: ${name}
notor-description: "${description}"
notor-mode: ${mode}${featureGroupLine}${awaitsLine}
---

Customizable override for the built-in \`${name}\` tool. Edit the code below and reload extensions to apply changes.

\`\`\`yaml
${trimmedYaml}
\`\`\`

\`\`\`ts
${code}
\`\`\`
`,
	};
}
