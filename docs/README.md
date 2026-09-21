# CoS 3.x documentation

This directory contains both **current architecture** and **historical engineering evidence**.

## Canonical current documents

Read these first:

1. [Architecture](architecture.md) — durable mission model, identity, authority and recovery.
2. [Setup and operation](setup.md) — installation, pairing, updates and long-running operation.
3. [Model-facing tool surface](tool-surface.md) — Core/Desktop/Plugins contracts.
4. [Long-Run Runtime](long-run-runtime.md) — obligations, waits, continuation and supervisor behavior.
5. [Security](../SECURITY.md) — capability and durable-authority boundaries.
6. [Implementation map](../AGENTS.md) — code-level invariants and owners.

These documents define CoS 3.x.

## Subsystem references

The following remain useful engineering references but do not override the architecture above:

- [ChatGPT turn signals](chatgpt-turn-signals.md)
- [Codex Desktop bridge RFC](codex-desktop-bridge.md)
- [Computer-use implementation](computer-use-overhaul-implementation.md)
- [Computer-use design plan](computer-use-overhaul-plan.md)
- [Plugins](plugins.md)
- [Usage model attribution](usage-model-attribution.md)
- license/provenance documents under [licenses/](licenses/)

## Historical documents

Pre-3.0 release notes, worklogs, bug audits and migration notes are retained for provenance and debugging archaeology. They document what was true at a particular time; they are **not current architecture authority**.

Every historical document is marked with a pre-3.0 notice.

## Repository authority

The canonical repository and direct development line is **MurphyHoops/CoS**. Historical and external repositories are reference-only sources.

## Acknowledgement

CoS 3.x began from the open-source Chat On Steroids project by @totec448-spec. See [../CONTRIBUTORS.md](../CONTRIBUTORS.md).
