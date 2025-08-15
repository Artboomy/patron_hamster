Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.

Use chrome-devtools-mcp if you need to interact with clean Chrome browser

After making changes, run `yarn self-check` to self-check (runs eslint, tsc, then tests).
Before each node/fnm command invoke `eval "$(fnm env)"`
This workspace may not have `node` on PATH by default. Run Node/Yarn commands through `fnm`, for example:
- `fnm exec --using <version> -- yarn self-check`
- `fnm exec --using <version> -- node --version`

After successful self-check always run build:extension