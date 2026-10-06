# Unisono takes over each Agent's Catalog instead of merging into it

On sync, the Catalog of every Agent is replaced wholesale by what the Score (including its Overrides) compiles to; Providers or fields in the Catalog that the Score does not declare are deleted, while everything outside the Catalog (themes, MCP, default-model settings) is left untouched. We rejected field-level merge with a managed-entry manifest: it preserves hand-tuned fields silently but makes the Score stop being the single source of truth, and needs ownership bookkeeping. Agent-specific fields (compat, cost, thinking) therefore live in the Score as Overrides, and the first sync against a Catalog holding undeclared Providers must be confirmed explicitly and is always backed up.

## Consequences

- Hand-edited Catalog entries do not survive a sync; users must move them into Overrides (an `import` command seeds the Score from an existing Catalog).
- Agent files are rewritten without preserving comments; a sync whose compiled Catalog already equals the file's does not write at all.
- Default-model and role settings outside the Catalog can dangle after a takeover; Unisono warns but does not edit them.
