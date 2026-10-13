# Acknowledgements

CoS 3.x is an independent project maintained in **MurphyHoops/CoS**.

The project began from the open-source **Chat On Steroids** codebase created by [@totec448-spec](https://github.com/totec448-spec). We are grateful for that original work and for making it available under an open-source license.

The pre-3.0 history also contains contributions, bug reports, reviews and experiments from a broader community. Their detailed provenance remains available in:

- the preserved Git history;
- archived 2.x release notes and engineering worklogs;
- the repository license and third-party notices.

CoS 3.x documentation intentionally does not reproduce the old fork/PR governance model. Current development follows the standalone architecture and repository policy defined in [docs/architecture.md](docs/architecture.md) and [AGENTS.md](AGENTS.md).

Thank you to everyone whose work helped make the independent runtime possible.


## 2026-10-13 upstream compatibility backport

The Classic 3.1.16 recorder/recovery repair selectively adapts later upstream Chat On Steroids work from `totec448-spec/chat-on-steroids` rather than replacing the independent CoS 3.x runtime:

- [@totec448-spec](https://github.com/totec448-spec) integrated alternate-shell compatibility in upstream PR [#319](https://github.com/totec448-spec/chat-on-steroids/pull/319), based in part on [@ehkogh](https://github.com/ehkogh)'s typed `turn.items[]` and shell-structure contribution in [#318](https://github.com/totec448-spec/chat-on-steroids/pull/318). This repair adapts the public user/final-assistant projection, modern `data-turn-key` grouping, local identity handling, and stale MAIN-helper replacement into the existing 3.1.16 recorder contract.
- [@Maximapple](https://github.com/Maximapple) authored the upstream streaming-page recovery fence (`9c7c50a81d0b87672bb61f597078bdb689d2f045`) and hidden kept-page guard (`f3d6d1fdb8845cbe6970fe009e44e4bde25b1bf6`). The Classic repair adapts those protections so attribution recovery does not reload a live stream and hidden routed pages do not become transcript owners.
- [@lavalava45](https://github.com/lavalava45) authored the provider history Retry-After observation and headerless fallback in `d1170dfba58638897afda1ceb2b7726ba264f11d` and `db04ea9e34bb49053f2bc7538fadeebc38f70b0c`.
- [@Haz4rdovisk](https://github.com/Haz4rdovisk) authored the later history-limit backoff integration in `2eeb0474baea397d0cf55c89a14ac5faea2ab54f`. The Classic bridge adapts the conversation-scoped deadline fence at repair handout and final claim.

Only the compatibility/recovery mechanisms required by Classic 3.1.16 are backported. Upstream product/UI/runtime changes are not imported wholesale.
