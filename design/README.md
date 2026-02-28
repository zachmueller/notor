# Notor — Design Documentation

Notor is an Obsidian community plugin that brings AI-powered assistance directly into the note editing workflow. It aims to provide the kind of deep, tool-using AI integration that Cline brings to software development — but purpose-built for knowledge management, note writing, and vault organization in Obsidian.

## Design principles

1. **Notes first.** Every feature should serve the goal of helping users write, organize, and connect their notes more effectively.
2. **Transparency.** Users must always be able to see what the AI is reading, searching, and modifying. Show every tool call and its results inline.
3. **Safety by default.** Destructive operations require approval unless explicitly auto-approved. Checkpoints enable rollback. Plan mode prevents accidental edits.
4. **Local and private.** Default to local/offline operation. No telemetry. Network calls only for LLM API requests and explicitly opted-in features.
5. **Composable.** Personas, workflows, hooks, and tools should be modular building blocks that users combine to fit their workflow.
6. **Progressive disclosure.** Core features should be simple to use out of the box. Advanced features (agents, workflows, custom tools) are available but not required.

## Document index

| Document                        | Contents                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| [Roadmap](roadmap.md)           | Phased implementation plan from foundation through advanced features               |
| [UX](ux.md)                     | Chat panel, editor behavior, diff preview, transparency, and UI patterns           |
| [Tools](tools.md)               | Built-in tool definitions, shell access, and custom MCP tool extensibility         |
| [Architecture](architecture.md) | LLM providers, personas, workflows, agents, hooks, context management, checkpoints |

## Scope note

These documents describe the full medium-term vision for Notor. Not everything described here is in scope for the MVP. The [roadmap](roadmap.md) defines phased delivery, with Phase 0–1 representing the MVP. Features beyond MVP are documented to inform architectural decisions in earlier phases — ensuring we build foundations that support the intended direction without over-engineering.