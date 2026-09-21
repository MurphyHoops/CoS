# Repository instructions

Read [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md) before changing CoS.

CoS 3.x is a standalone durable-runtime project. The durable mission/session is the identity; provider conversations are replaceable executors.

Key rules:

- preserve one authoritative owner for each durable fact;
- never replay an ambiguous mutation without reconciliation;
- never restore authority to a superseded executor;
- never turn a quiet provider turn into invented work;
- use durable waits rather than provider-side polling for long external conditions;
- explicit user Stop/cancellation outranks automation;
- historical repositories are reference-only; do not merge them into `main`.

This is a public repository. Never commit secrets, private account identifiers, local personal paths, provider conversation content or provenance/session URLs.

Before commit/push/tag/release, run the repository privacy and verification gates. Do not bypass them with `--no-verify`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the current contribution model.
