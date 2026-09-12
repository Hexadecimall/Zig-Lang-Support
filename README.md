# Zig-Lang-Support for Visual Studio Code

Zig-Lang-Support is a focused Zig development environment for VS Code. It combines
official-compatible TextMate token scopes with ZLS intelligence, direct Zig
toolchain integration, and project commands that keep the editor close to the
language's own workflows.

> Zig-Lang-Support includes ZLS 0.16.0 for macOS on Apple Silicon. It launches
> that bundled server automatically, so users do not need a separate ZLS install.
> Other platforms retain the local fallback and can configure a server path.

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
- A graphical project manager: add dependencies by name and URL, remove listed
  dependencies, and build/run/test/fetch without editing `build.zig.zon`.
- High-value snippets for public functions, tests, imports, allocators, and
  error propagation.

## Quick start

1. Install a Zig toolchain and make `zig` available on `PATH`.
2. Open a folder containing `build.zig` or `build.zig.zon`.
3. Use the **Zig-Lang-Support** view or Command Palette for project actions.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `zigLangSupport.zig.path` | `zig` | Zig executable path. |
| `zigLangSupport.zls.path` | `zls` | ZLS executable path. |
| `zigLangSupport.zls.enabled` | `true` | Enables advanced ZLS language features. |
| `zigLangSupport.diagnostics.enabled` | `true` | Enables compiler-based fallback diagnostics. |
| `zigLangSupport.diagnostics.onSave` | `true` | Refreshes fallback diagnostics after a save. |
| `zigLangSupport.format.args` | `[]` | Extra arguments passed to `zig fmt`. |
| `zigLangSupport.tasks.extraArgs` | `[]` | Extra arguments appended to build tasks. |

## Commands

- `Zig-Lang-Support: Build Project`
- `Zig-Lang-Support: Run Project`
- `Zig-Lang-Support: Test Current File`
- `Zig-Lang-Support: Format Document`
- `Zig-Lang-Support: Add Dependency`
- `Zig-Lang-Support: Fetch Dependencies`
- `Zig-Lang-Support: Restart Language Server`
- `Zig-Lang-Support: Show Project Dashboard`

## Privacy and security

Zig-Lang-Support runs local tools selected by the workspace settings. It does not
collect telemetry or send source code to an external service. It bundles a ZLS
server for macOS on Apple Silicon but does not bundle a Zig compiler. Dependency
retrieval happens only when a user invokes a Zig dependency command, and it is
performed by the local Zig executable.

## Credits

The grammar keeps compatibility with the scope model in the official
[`ziglang/vscode-zig`](https://github.com/ziglang/vscode-zig) extension. The
associated MIT notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
