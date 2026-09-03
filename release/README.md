# CodeGraph — install

> Local-first codebase graph for Claude + VS Code. Formerly DuckGraph
> (`duckgraph_*` aliases still work everywhere).

Maintained by **Ashvin K S**.

## Install (one command)

Windows (PowerShell):

```powershell
.\install.ps1 -Workspace C:\path\to\your-project
```

macOS / Linux:

```bash
./install.sh --workspace /path/to/your-project
```

This installs both:

1. **MCP server** — `npm install -g ./mcp`, then writes the Claude Desktop
   entry for you (`codegraph-mcp --workspace <your-project>`). Restart
   Claude Desktop, then try `codegraph_health` → `codegraph_index_workspace`
   → `codegraph_explain_symbol`.
2. **VS Code extension** — installs `codegraph-*.vsix` via `code --install-extension`.

Skip either half with `-SkipMcp` / `-SkipExtension` (PowerShell) or
`--skip-mcp` / `--skip-extension` (bash). Point at another project later with:

```powershell
codegraph-setup --workspace C:\path\to\other-project
```

## What's in this folder

| Path | What it is |
|---|---|
| `install.ps1` / `install.sh` | One-command installer (this page) |
| `mcp/` | Standalone MCP server source. Needs only `npm install` (`better-sqlite3` + MCP SDK). No VS Code, no daemon, no monorepo. |
| `codegraph-*.vsix` | Prebuilt VS Code extension (`kilocode-x.codegraph`). No build needed. |
| `LICENSE.txt`, `CHANGELOG.md` | License (MIT) and history |

## Uninstall

```powershell
codegraph-setup --workspace . --uninstall   # removes the Claude entry
npm uninstall -g @kilocode-x/codegraph-mcp
code --uninstall-extension kilocode-x.codegraph
```
