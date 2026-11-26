# Contributing to Cloonex

Thanks for helping improve the project. Bug reports, documentation fixes and focused pull requests are welcome. English and Chinese are both welcome.

## Local development

Use Node.js 20.11 or newer and npm. Windows is the currently documented local validation environment; CI also exercises Linux.

```bash
npm ci
npm run verify
npm run demo
```

`npm ci` runs `prepare` and builds the TypeScript source. The demo uses a temporary database and does not modify your personal knowledge base. Check `npm pack --dry-run` if your change affects package contents.

## Before opening a pull request

- Describe the concrete problem, resulting behavior and checks you actually ran.
- Keep the change focused. Add meaningful coverage when changing behavior; documentation-only fixes do not need new tests.
- Preserve the policy guards: bugfix tasks must not learn preferences or write feature statements/decisions; unconfirmed preferences must not become constraints.
- Distinguish code facts, recorded reasons and unknowns. Never invent user intent or claim an unperformed check passed.
- If database layout changes, preserve existing data and cover migration. `src/db/schema.sql` is the editable schema; run `npm run sync:schema` to update `src/db/schema.ts`.
- Keep English and Chinese user-facing documentation consistent where applicable.

## Reporting a problem

Use the issue template and include the operating system, Node.js version, installation method, reproducible steps and expected/actual behavior. Remove secrets, personal paths and private knowledge-base content. Use a minimal sample project instead of uploading your SQLite database.

## Scope

The project is an early Codex/MCP integration prototype. Search is keyword-based; staleness checks compare linked file contents. Automatic conversation capture, semantic change analysis, cloud sync and team collaboration are not implemented. Discuss larger changes in an issue before investing in implementation.

Contributions are made under the project's [MIT license](LICENSE).
