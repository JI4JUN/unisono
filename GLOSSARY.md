# Unisono

Compiles one declarative Score into the native model configuration of several coding Agents, with no runtime proxy.

## Language

**Score**:
The single user-maintained file that declares every Provider and Model; the only source of truth.
_Avoid_: Config, canonical config, manifest

**Agent**:
A third-party coding tool (pi, omp, opencode, hermes, openclaw) whose native config Unisono writes.
_Avoid_: Target, client, voice (the music metaphor is branding, not vocabulary)

**Provider**:
A named API endpoint with credentials and a list of Models, as declared in the Score.
_Avoid_: Vendor, gateway, channel

**Model**:
A model entry under a Provider, carrying the metadata an Agent needs (context window, output limit, reasoning).
_Avoid_: Engine, LLM entry

**Catalog**:
The part of an Agent's native config that lists Providers and Models; everything else in that config belongs to the user.
_Avoid_: Registry, model section

**Takeover**:
Unisono's ownership of an Agent's Catalog: after a sync, the Catalog contains exactly what the Score compiles to, and nothing else.
_Avoid_: Managed merge, upsert

**Override**:
Agent-specific native fields the user writes in the Score for one Agent only, for what the Score's own fields cannot express.
_Avoid_: Extra, passthrough, patch

**Sync**:
Compiling the Score and writing the result into each Agent's Catalog.
_Avoid_: Deploy, push, apply
