The plan here is to articulate the full vision of what I want Notor to become (at least in the medium-term horizon). When working with Cline to translate from this broader scope of detail to just the MVP level scope, I will note which functionality I want included vs excluded in the MVP. The rationale for including the expanded scope in this write-up is to help inform Cline's thinking for how to design the earlier iteration given the context of the future direction I expect to take things in (rather than give it just the narrower MVP scope without that future context).

## Key components

- [Chat panel](#Chat-panel)
- [Editor behavior](#Editor-behavior)
- [Workflows](#Workflows)
- [Agents](#Agents)
- [Misc](#Misc)

## Chat panel

- Side panel in Obsidian UI. I think these automatically are structured to allow the user to drag them to any side they prefer.
- Chat input box at the bottom, with send button. Press enter to send, use Shift+Enter to add new line.
- Include a chat settings button (simple gear icon) for now. Can later emulate the "quick settings" readily available in the base UI, though allow users to customize what they want included via the chat settings.
- Plan vs Act modes. Can enforce this at the tool level to hardcore prevent at least particular built-in tools (e.g., can read notes but cannot write/modify notes). Maybe exclude certain CLI commands in targeted fashion (user-configurable) when in Plan vs Act mode.
- Auto-approve tool use, per tool / specific function. Manage these at both global level (i.e., set global defaults) plus at per persona level (e.g., use more specific setting for a given tool based on the persona, falling back to global default if not set explicitly for the persona). All handled within Obsidian plugin settings UI.
- Button (and inline typable syntax) for attaching specific files. This file picker should allow for grabbing files even outside the vault. For notes in-vault, should additionally allow referencing notes via Obsidian style internal links (including auto-completion of note names plus referencing specific section headers to only send a subset of the content).
- Optionally log full chat history for user to inspect. Probably somewhere within the vault, but in JSON/JSONL format (so not directly showing up within the file explorer within Obsidian).
- Build in configurable auto-compaction. Ideally have it operate at the plugin code level so it deterministically triggers a modifier in the context window such that it asks the AI to perform the summary, then passes that as a new starting point for the next chat context window. 
- Include hooks functionality
- General browser capabilities to allow the AI to browse the web. Ideally integrate this into the Obsidian Web Viewer functionality so the browser contents can load within the editor for the user to watch.

Chat settings: 
- LLM provider (swap between which endpoint/etc to use) 
- LLM model (swap between model variants within a given endpoint)
- Choose persona

## Editor behavior

- Optional behavior (default to on) for Notor to open up notes it's editing in the Obsidian UI, like how Cline opens up files in the IDE it's modifying
- 

## Workflows

- Allow users (via Obsidian plugin settings UI) to choose a Notor root directory within their vault that serves as the central place within which they can add things like workflows (under `{notor_dir}/workflows/`)
- Within these workflow notes, somehow leverage frontmatter properties to help drive various things. Need to ponder more here on what could be useful, but simple examples would be dynamically loading the workflow based on some triggers detailed in the frontmatter.
- Within the workflow notes themselves, allow users to use a `<include_notes>` XML tag that allows them to feed in the contents of any number of notes (or note sections) as the workflow gets injected into the context window. Need to contemplate whether it makes sense to load them directly into where the workflow's content gets pasted vs having the notes show up as "attached" files in the context window. Maybe that can be a parameter users can choose via some XML attributes.

## Agents

- Within the chat panel (or anywhere else the user can interact with the AI), need to be able to jump between different agents' context windows that might all be acting in parallel. Thus, should be able to see all "active" agentic workstreams happening through
- This parallel acting with wanting to view each context window means I might need the writing out of that context detail into separate JSON files rather than have it all in one (this may already be how I'd want it structured anyways, but this really forces that choice)
- Can maybe learn from Cline CLI for agent approach, how to do things in parallel, etc
- Given the volume of context happening through this, probably want to put some default limiter on how much chat history to store (e.g., only keep most recent X MB or Y days history)
- Should enable a method of running background agents that operate within Obsidian, doing whatever it is users want them to do (e.g., constantly research something or find connections between existing notes following some decision logic for which notes to start from and searching for connections, etc.)

## Misc

- User has complete control / ability to modify the system prompt. A default, built-in system prompt should come packaged in that should shape the core behaviors expected in Notor. Each persona should also allow for customization of the system prompt.