# Contributing to CoS 3.x

CoS 3.x is a standalone durable-runtime project. Contributions are welcome when they preserve the runtime's identity, authority and recovery invariants.

Start with:

1. [docs/architecture.md](docs/architecture.md)
2. [AGENTS.md](AGENTS.md)
3. the subsystem document for the code you are changing.

## Repository model

The canonical repository is **MurphyHoops/CoS**.

Historical repositories are reference sources only. Do not merge an external upstream branch into CoS `main`. If an external project contains a useful fix, audit the behavior and port only the required change into CoS with CoS-native tests.

## What a good change looks like

Prefer the earliest correct ownership boundary over a new fallback.

A change should answer:

- Which durable fact was wrong or missing?
- Which component owns that fact?
- What evidence proves the new behavior?
- What stale authority or duplicate path is removed?
- How does the behavior survive restart/executor replacement?

Avoid creating a second authority for mission state, progress, recovery, worker ownership or completion.

## Development

Requirements: Node 22+.

```sh
npm ci
npm run verify
npm run dev
```

Run the nearest focused tests while iterating, then run the full verification gate before committing.

For packaging-sensitive changes, build/smoke the platform package that can exercise the change.

## Long-run changes

Changes touching Goal/Loop, Compact & Resume, Self-Healing, workers, `session_wait`, process custody or continuation delivery must preserve:

- durable mission identity;
- one current execution authority;
- stale-executor fencing;
- no blind replay of ambiguous mutations;
- exactly-once continuation delivery;
- explicit user cancellation precedence;
- restart/rebind reconciliation.

## Documentation

Update canonical docs when the architecture or user contract changes.

Do not turn a temporary incident note into the architecture authority. Historical worklogs/audits should remain factual records and must be marked historical when they predate CoS 3.x.

## Pull requests

Explain:

- root cause;
- ownership/invariant being repaired;
- behavior change;
- tests run;
- packaged/live validation when relevant.

Do not include secrets, private account data, local personal paths or provider conversation content.

## Security

Report vulnerabilities privately through GitHub Security for `MurphyHoops/CoS`. See [SECURITY.md](SECURITY.md).

## Credit

CoS 3.x originated from the open-source Chat On Steroids project by @totec448-spec; see [CONTRIBUTORS.md](CONTRIBUTORS.md).

New contributions remain visible in Git history and the normal GitHub contribution record. Contributions are accepted under the repository's MIT license.
