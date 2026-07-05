# Changelog

## 0.1.0

Initial public release.

### Features

- **Chat interface** — full conversation UI with streaming responses, message history, and session management
- **Diff viewer** — side-by-side file diffs with syntax highlighting, Ctrl/Cmd+F in-modal search with match navigation, and accurate +N/-N line stats
- **Changes panel** — workspace file tracking with deleted-file filtering and "open in editor" support
- **@-mentions** — attach files to messages via an @-mention picker with fuzzy search
- **Permission requests** — interactive approve/deny UI for tool execution
- **Todo tracking** — live todo list synced from the agent
- **Multi-session** — create, switch, rename, fork, and delete sessions
- **Configurable** — custom binary path, agent selection, auto-start, send-on-enter, and more

### Bug Fixes (post-release)

- Diff stats now use Myers diff algorithm for accurate line counts
- Deleted files are filtered from the Changes sidebar
- Session generation errors are surfaced to the UI instead of being silently dropped
- File mentions no longer parse arbitrary message text (only explicit @-mentions are attached)
