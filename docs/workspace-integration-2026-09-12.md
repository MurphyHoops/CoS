# Workspace integration, 12 September 2026


> **Historical — pre-CoS 3.0.** This document is preserved as engineering/provenance evidence. It does **not** define current runtime behavior. Current architecture is defined by docs/architecture.md and AGENTS.md. Historical version numbers, repository links, PRs, incidents and implementation assumptions are intentionally retained as facts from that period.

Integrated current workspace changes onto the current public main branch, retaining
the published version metadata and the existing request-origin, send-receipt and
README improvements. Release workflows and updater behavior are unchanged.

The changes cover native Thinking failed and silence recovery, opt-in Pro Loop
pickup, direct corrections, image injection and recording, long composer inputs,
unattributed tool permissions, model discovery and account-aware usage estimates.
Existing fixes already on main remain in place. Private worklogs, recordings and
development history are excluded from the public integration.

The Pro final-proof regression now covers both explicit after-turn settings and
uses distinct conversation identities so one case cannot inherit another case's
durable turn history. The complete bridge suite passes all 322 tests.

Validation: full verification passed 4,019 tests plus two isolated shutdown
tests, with 40 opt-in skips; typecheck, privacy and license checks passed.
The Windows x64 package and installed runtime smoke passed. All 286 packaged
files match the installation byte for byte. Packaging regenerated the notices
for installed Windows dependencies; that generated payload passed its license
check, and the repository retains its existing cross-platform notice inventory.
These checks do not establish live ChatGPT feature acceptance. This integration
does not publish a release or announce an update.
