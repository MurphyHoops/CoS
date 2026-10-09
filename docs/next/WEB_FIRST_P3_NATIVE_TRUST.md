# Web-First P3a — Scoped Native Read Permissions & Durable Operation Receipts

Date: 2026-10-09. Branch: `next/v4/p3-native-trust` (independent worktree).

## Contract and current limitations

Web-First runs the **official ChatGPT webpage** for AI reasoning, and the
existing user's Core MCP routes requests to native local tools. No Codex CLI,
paid inference API, local-model substitution, or Chrome extension is needed.

**Conversation identity is still unverified.** The caller may provide a forged
conversation ID, which cannot grant authority. A user-chosen **permanent read
grant** means ANY invocation routed via this user's authorized Core MCP could
read non-sensitive files in the selected project, even from another ChatGPT
conversation. The native confirmation UI MUST disclose that. If this is
unacceptable, choose **本次运行允许** or **仅允许这一次** and avoid permanent grants.

**Project registration itself does not grant any read capability.** The first
request requires native approval. No persistent permission is created by
an install, upgrade, preview launch or smoke test on a real user profile.

## Scoped approval modes

The native file-tool prompt offers the following mutually exclusive actions:

- `拒绝`: deny without granting anything.
- `仅允许这一次`: approve this one tool call and forget immediately.
- `本次运行允许`: approve reads inside the **same project** until the Web-First
  process ends; no disk grant remains.
- `始终允许（该范围只读）`: durable project-scoped read grant, explicitly reviewable
  and revocable. A catalogue-only grant (`project_list`) **never** grants
  project file or directory reads.

Each durable project grant records its selected root path, project ID and
filesystem device/inode identity, so replacing the project directory under an
unchanged path invalidates the grant. The service still uses the existing
separate path traversal, symlink and inode check for each read. Durable grants
are stored only in Web-First's native 0600 userData file with atomic writes,
not Chrome, ChatGPT, model context or a connected plugin.

**Sensitive paths never gain automatic read approval**, even under a durable
grant: `.git`, `.env*`, `.ssh`, `.aws`, `.gnupg`, `node_modules`, known
credentials, and typical private keys (`.pem`, `.key`, `id_rsa`, `id_ed25519`).
They continue to require a one-time native confirmation. Sensitive paths do
not become writable by authorizing a single read.

Simultaneous requests use a serialized native-approval queue to avoid repeated
modal dialogs: after a scoped grant the next authorized request rechecks the
same scope. The queue never uses model-supplied identity as authority.

## User operations

Native macOS menu `本地项目`:

- `管理/撤销只读授权`: review stored and session permissions one at a time;
  revoke individually, effective for following calls.
- `撤销全部只读授权`: requires a separate confirmation. Existing already-finished
  operations cannot be rolled back.
- `查看本地操作收据`: recent tool names, stage and timestamp only.

The native sidecar displays the counts of durable and session grants, or an
explicit integrity error that disables automatic approval. It does not contain
scriptable native APIs, file access or ChatGPT cookies.

## P3 durable execution receipts

Each `project_list`, `project_ls`, `project_read` tool invocation, even denied
ones, records a `STARTED` event with a fresh UUID before execution, then a
`SUCCEEDED`/`REJECTED` event. The receipt is durable in a size-bounded 0600
append-only JSONL under the native profile. It includes **no project path,
file text, chat message, token, permission secret or OAuth data**. An unsafe
or unwriteable journal fails closed before the file tool runs.

This is P3's minimum **auditable operation journal**, NOT yet the complete
Goal/Agent durable task lifecycle, reliable conversation principal, shell
execution, file mutation or resumption engine.

## Tests and delivery

- TS typecheck + Web-First focused tests including session vs durable grants,
  native scope validation, sensitive-file bypass prevention, directory identity
  replacement, symlink/corrupted grant refusals, revoke, and live HTTP/MCP
  twice-read-with-one-approval behavior.
- True packaged Electron ARM64 temporary-profile smoke checks durable grant
  create/restore/revoke, project registry, real local MCP file read, execution
  receipt replay, registered native menu options, native input and shutdown.
- Full `npm run verify:ci` and standalone app verification must both be green
  before migration of the running authenticated Web-First.

**Future P3b gates:** trustworthy conversation/work-item attribution, durable
Goal/Agent session, resumable task transitions, independent approval for scoped
writes/shell, rollback receipts and crash-recovery tests. Do not infer these
from P3a's read-only permission improvements.

## Final P3a validation checkpoint

- Web-First 29 focused tests passed, with the optional live-network test
  skipped by default; tests include two sequential real HTTP/MCP file reads
  with only one scope approval, immediate revocation, sensitive-file exceptions,
  inode changes, and STARTED/REJECTED receipts for denied reads.
- `npm run verify:ci` completed with **5,075 conventional passes**, **131 skipped**,
  and **2 additional MCP shutdown passes** — zero failures.
- Genuine ARM64 packaged Electron offline smoke returned all required markers:
  `WEB_FIRST_OFFLINE_GRANT_LIFECYCLE_PASS`, `WEB_FIRST_OFFLINE_RECEIPT_PASS`,
  `WEB_FIRST_OFFLINE_LOCAL_MCP_PASS`, `WEB_FIRST_OFFLINE_PROJECT_MENU_PASS`,
  `WEB_FIRST_OFFLINE_INPUT_PASS` and `WEB_FIRST_OFFLINE_VIEW_READY`.
- The final local-preview app bundle was ad-hoc signed with `codesign --force
  --deep --sign -`, passed `codesign --verify --deep --strict`, and was
  retested after signing. This is **not** a notarized public release.
- The operator's previous project registrations and ChatGPT login were never
  cleared during development. The new permission ledger starts absent on a
  real existing profile; no permanent grant is inferred from registration.
- The source is deliberately isolated in `next/v4/p3-native-trust` and does not
  modify Classic, the existing Web-First worktree, or GitHub main.

## Future full P3 acceptance

This milestone is **P3a**, not the full P3 workflow: trusted ChatGPT
conversation attribution, persistent Goal and worker identities, task stop/
resume, explicit write/shell permissions, crash replay fences and real
multi-file project editing remain separate completion criteria.
