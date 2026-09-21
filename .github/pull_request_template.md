## What changed

Describe the root cause and the earliest ownership/identity boundary that changed.

## Durable-runtime impact

- [ ] Mission/session identity remains stable across executor replacement.
- [ ] No stale executor gains new mutation authority.
- [ ] Ambiguous mutations are reconciled before retry.
- [ ] Continuations/waits remain exactly-once.
- [ ] Explicit user Stop/cancellation still outranks automation.
- [ ] Not applicable to this change.

## Validation

- [ ] Added or updated deterministic regression coverage where behavior changed.
- [ ] `npm run verify` passes.
- [ ] Packaging/runtime smoke was run when bundled behavior can differ.
- [ ] Canonical docs were updated if the public/runtime contract changed.
- [ ] No unrelated formatting, generated output, private data or debugging residue is included.
