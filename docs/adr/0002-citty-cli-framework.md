# CLI routing and subcommands are driven by `citty`

The CLI entry (`src/cli.ts`) and its six subcommands (`src/commands/*.ts`) are declared with `citty` (`defineCommand` and `runMain`) rather than hand-rolled `Bun.argv` routing, superseding the initial MVP zero-runtime-dependency policy for the CLI layer. As the command surface moves into modular subcommand files, `citty` provides declarative argument definitions, subcommand dispatch, and built-in `--help` / `--version` rendering while keeping startup well inside the 100 ms converged-sync budget.

## Consequences

- Each subcommand lives in its own module under `src/commands/` and sets `process.exitCode` (including exit code `2` for unconfirmed first takeovers) rather than returning an integer from a monolithic switch.
- Because `citty` delegates to `node:util` `parseArgs` with `strict: false` and slices off flags preceding the subcommand name, the root `setup` hook rejects both leading flags before the subcommand and undeclared subcommand flags derived from each command's `args` definition so typos never execute silently.
