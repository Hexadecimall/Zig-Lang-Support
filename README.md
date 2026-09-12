# Zig Forge for Visual Studio Code

Zig Forge is a focused Zig development environment for VS Code. It combines
official-compatible TextMate token scopes with ZLS intelligence, direct Zig
toolchain integration, and project commands that keep the editor close to the
language's own workflows.

> ZLS is an external language-server executable. Zig Forge falls back cleanly
> when it is unavailable; it never requires a system-wide ZLS installation for
> formatting, basic completion, or compiler diagnostics.

## What it provides

- Zig and `.zon` syntax highlighting using the official extension's scope model.
- Advanced completion, hover, go-to-definition, references, rename, symbols,
  inlay hints, and semantic diagnostics through [ZLS](https://zls.gg/).
- Built-in fallback completions for Zig keywords and builtins when ZLS is not
  installed or is unavailable.
- Inline compiler diagnostics using `zig ast-check`, with a configurable debounce.
- A `zig fmt --stdin` formatter and format-on-save default for Zig files.
- Commands and Tasks for building, running, testing, formatting, and fetching
  project dependencies.
- A dependency command that delegates to Zig's own `zig fetch --save URL`, so
  `build.zig.zon` remains the single source of truth.
- A project sidebar for common project files and dependency/build actions.
- High-value snippets for public functions, tests, imports, allocators, and
  error propagation.

## Quick start

1. Install a Zig toolchain and make `zig` available on `PATH`.
2. Install ZLS and make `zls` available on `PATH` for the full language-server
   experience. When ZLS is unavailable, Zig Forge quietly uses its local
   completion, formatting, and compiler-diagnostic features instead.
3. Open a folder containing `build.zig` or `build.zig.zon`.
4. Use the **Zig Forge** view or Command Palette for project actions.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `zigForge.zig.path` | `zig` | Zig executable path. |
| `zigForge.zls.path` | `zls` | ZLS executable path. |
| `zigForge.zls.enabled` | `true` | Enables advanced ZLS language features. |
| `zigForge.diagnostics.enabled` | `true` | Enables compiler-based fallback diagnostics. |
| `zigForge.diagnostics.onSave` | `true` | Refreshes fallback diagnostics after a save. |
| `zigForge.format.args` | `[]` | Extra arguments passed to `zig fmt`. |
| `zigForge.tasks.extraArgs` | `[]` | Extra arguments appended to build tasks. |

## Commands

- `Zig Forge: Build Project`
- `Zig Forge: Run Project`
- `Zig Forge: Test Current File`
- `Zig Forge: Format Document`
- `Zig Forge: Add Dependency`
- `Zig Forge: Fetch Dependencies`
- `Zig Forge: Restart Language Server`
- `Zig Forge: Show Project Dashboard`

## Privacy and security

Zig Forge runs local tools selected by the workspace settings. It does not
collect telemetry, send source code to an external service, or bundle a Zig
toolchain. Dependency retrieval happens only when a user invokes a Zig
dependency command, and it is performed by the local Zig executable.

## Credits

The grammar keeps compatibility with the scope model in the official
[`ziglang/vscode-zig`](https://github.com/ziglang/vscode-zig) extension. The
associated MIT notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
