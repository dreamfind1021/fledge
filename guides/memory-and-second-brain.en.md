# The memory panel, and building your own second brain

**English** · [繁體中文](memory-and-second-brain.md)

> This guide covers the "your second brain" layer: what the memory panel reads, how to use it, and how to start your own vault from the template.

<img src="../assets/screenshot-memory.png" alt="Memory panel" width="820">

## What the memory panel reads

Two sources, both **read-only**:

| Source | Location | How Fledge recognizes it |
|---|---|---|
| Claude Code's own memory | Each account's `<config dir>/projects/<encoded project>/memory/*.md` | Scans every account and project; classifies by the frontmatter `type` (`user` / `feedback` / `project` / `reference`) |
| The second brain (KMS) | `topics/` and `library/` under the `kms_root` set in Settings | Only `.md` files under those two folders; anything starting with `_` or `.`, and `CLAUDE.md`, is skipped |

Both only need markdown with frontmatter. The parser is minimal: the first `---` block is read as YAML-lite for `type`, `tags`, and `summary`; broken files are skipped silently.

The only file Fledge writes is its own `~/.fledge/memory-links.json` — confirmed and dismissed suggestions, all in that one file.

## Using the panel

- **Search**: full-text, in memory, no RAG.
- **Filter**: by source (Claude memory / KMS) and type (`user` / `feedback` / `project` / `reference` / `library` / `topics`).
- **Grouping**: by account, project, topic.
- **Links**: select a project to see its related topics on the right.
- **Suggestions**: Fledge does plain string matching — a vault topic whose folder name or `tags` contain a project's name — and proposes a link. It only counts once you press ✓; press ✕ and it won't come back. Right now, confirming a suggestion is the only way to create a link from the panel; the backend has an API for declaring "A relates to B" by hand, but the UI isn't wired to it yet.
- **Surfacing**: when you open a project in the terminal, its related topics float up at the bottom right. No related topics, no float — you never get an empty box.

## Why it's built this way

- **No RAG.** The corpus this was designed for is a hundred-odd markdown files, a fraction of a megabyte, all curated — full-text search gets through it instantly. Standing up a vector database for that would be solving a problem that doesn't exist. If the files ever balloon, revisit.
- **No second per-project memory engine.** Claude Code's own memory already does this well, writes itself, and accumulates automatically. Fledge only adds what it can't do: the whole picture, across projects.
- **No injection into sessions.** The panel is for people. Handing related topics to the AI when it opens a project means pushing things into its context — that needs its own design. It's on the roadmap.
- **Read-only.** Claude writes its memory automatically, you write the vault by hand, and if Fledge wrote into the same files too, three writers on one set of files would eventually break something. So Fledge only writes its own JSON.

## Building your own second brain

### Start from the template

In the onboarding wizard's "Deploy a template" step, pick "Second brain" and choose a folder. You can also do it later from the "Dev environment" section in Settings. The template never overwrites existing files.

Once it's deployed, set that folder as `kms_root` (Settings › Memory) and put it under a work root — it's a project in its own right, and you'll be opening sessions inside it.

### Directory layout

```
<vault>/
├── CLAUDE.md              ← rules: research/creative modes, wrap-up rules, when each file gets updated
├── .claude/               ← hooks and appendices (see below)
├── _INDEX.md              ← topic list [auto-derived, don't edit]
├── _CONNECTIONS.md        ← cross-topic link overview [auto-derived]
├── _TAGS.md               ← tag index [auto-derived]
├── topics/                ← lines of thought: one folder per topic
│   └── <topic>/
│       ├── CONTEXT.md     ← where it stands (frontmatter at the top is the source of truth for the indexes)
│       ├── INSIGHTS.md    ← distilled takeaways, not a transcript
│       ├── spec.md        ← created only once a topic reaches the design stage
│       └── sessions/      ← one card per conversation: summary, findings, side paths, links, next
└── library/               ← knowledge synthesis: external sources, cited claim by claim
    └── <subject>/
        ├── sources/       ← evidence layer, immutable
        ├── overview.md    ← the cited synthesis page
        └── queries.md     ← Q&A backfill
```

The three `_`-prefixed index files are **derived**: the source of truth is each topic's `CONTEXT.md` — its frontmatter (`tags`, `summary`) and the `[[wikilinks]]` in its body — and the AI rebuilds the indexes before each session ends. You always edit the topic file, never the index.

### Two conventions that let Fledge see the connections

1. **Folder names are slugs**, e.g. `garden-planner-irrigation`.
2. **Frontmatter `tags` line up with project names**, e.g. `tags: [Garden-Planner, weather]`.

Fledge's suggestions come from matching project names against exactly these two things. Neither convention exists for Fledge's sake — you'd write them this way for Obsidian navigation anyway; Fledge just reads back connections that are already in the data.

### Hooks

The template's `.claude/settings.json` registers four hooks that run when Claude Code opens in the vault folder:

| When | What |
|---|---|
| `SessionStart` | Injects `_INDEX.md` into the conversation and reminds the AI to follow the context-recovery rules; reports anything left un-wrapped last time |
| `UserPromptSubmit` | When you mention a library operation (ingest a source, lint…), nudges the AI to read the appendix first |
| `PostToolUse` | When the AI edits a topic file, marks it "needs wrap-up" (a session card, an index rebuild) |
| `Stop` | Blocks with a reminder if there's unfinished wrap-up; after two reminders it lets go and leaves it for next time |

The two scripts (`vault_dirty.py`, `prompt_router.py`) only ever write the vault's own `.vault-dirty.json` and marker files under `/tmp`. Don't want the hooks? Delete the `.claude/` folder; the rest of the vault works as-is.

### Working in it

Click the vault project in Fledge's sidebar and open a session. Say what you want to research or think through in your first message — `CLAUDE.md` has the AI decide whether this is research mode (look things up, demand sources, find contradictions) or creative mode (diverge; don't converge too early). It creates the topic folder on its own, and before wrapping up it writes a session card, updates `CONTEXT.md`, and rebuilds the indexes.

Next time, the `SessionStart` hook feeds the topic list to the AI, and it opens with "last time we got to X; I'd suggest picking up from Y".

That's the "long-term memory" the README describes. It doesn't live in Fledge; it lives in the vault. What Fledge does is keep it visible while you're working in other projects.
