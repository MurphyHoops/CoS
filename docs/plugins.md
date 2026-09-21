# External MCP plugins

Plugins extend CoS with external MCP servers. They are adapters around the durable mission runtime, not an alternate scheduler or authority system.

## Principles

- Core mission/session identity remains owned by CoS.
- Plugin availability does not expand local filesystem/browser/desktop permissions.
- A plugin result is evidence; it does not independently decide mission completion.
- Plugin mutations are subject to the same no-blind-replay rule after transport ambiguity.
- Provider/account restrictions are not conditions to route around through another plugin.

## Catalog and custom servers

CoS can expose reviewed catalog entries and user-configured MCP servers according to the current UI/runtime configuration.

Catalog metadata, license provenance and notices are validated separately from mission logic.

## Code Mode

When available, plugin tools may participate in bounded Code Mode composition. Nested use does not create a second identity or bypass CoS execution fences.

## Long-running plugin work

A plugin that starts long external work should integrate through a durable wait provider or another explicit local reconciliation mechanism rather than asking the model to poll indefinitely.

The Long-Run provider registry is intentionally extensible for project-specific external conditions.

## Security

Treat plugin servers as separate trust boundaries. Review:
- endpoint/operator;
- credentials;
- actions they can take;
- data they can read;
- whether they can mutate remote state.

See [../SECURITY.md](../SECURITY.md).

## Licensing

Plugin recipe/catalog licensing is documented in:
- [plugin-licenses.md](plugin-licenses.md)
- [plugin-notice-audit.md](plugin-notice-audit.md)
- [licenses/plugins/](licenses/plugins/)
