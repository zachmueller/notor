The plan here is to articulate the full vision of what I want Notor to become (at least in the medium-term horizon). When working with Cline to translate from this broader scope of detail to just the MVP level scope, I will note which functionality I want included vs excluded in the MVP. The rationale for including the expanded scope in this write-up is to help inform Cline's thinking for how to design the earlier iteration given the context of the future direction I expect to take things in (rather than give it just the narrower MVP scope without that future context).

## Key components

- [[#Chat panel]]
- [[#Agents]]

## Chat panel

- Side panel in Obsidian UI. I think these automatically are structured to allow the user to drag them to any side they prefer.
- Chat input box at the bottom, with send button. Press enter to send, use Shift+Enter to add new line.
- Include a chat settings button (simple gear icon) for now. Can later emulate the "quick settings" readily available in the base UI, though allow users to customize what they want included via the chat settings.

Chat settings: 
- LLM provider (swap between which endpoint/etc to use) 
- LLM model (swap between model variants within a given endpoint)
- Choose persona

## Agents

- Within the chat panel (or anywhere else the user can interact with the AI), need to be able to jump between different agents' context windows that might all be acting in parallel. Thus, should be able to see all "active" agentic workstreams happening through
- This parallel acting with wanting to view each context window means I might need the writing out of that context detail into separate JSON files rather than have it all in one (this may already be how I'd want it structured anyways, but this really forces that choice)
- Can maybe learn from Cline CLI for agent approach, how to do things in parallel, etc 
- Given the volume of context happening through this, probably want to put some default limiter on how much chat history to store (e.g., only keep most recent X MB or Y days history) 
