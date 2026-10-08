# CoS Next — operator-authorized legacy configuration and Keychain migration

Local validation date: 2026-10-08. **LOCAL ONLY.** No GitHub push, release, extra paid model API, account quota bypass or production Mission permissions.

## What was migrated

The operator requested preservation and direct use of old CoS credentials and configuration in Next.

- Original directory: `~/Library/Application Support/chat-on-steroids`.
- Next directory: `~/Library/Application Support/chat-on-steroids-next`.
- Original `config.json` was copied byte-for-byte into Next's own `config.json`. Next does not treat legacy roots, agents, browser settings or write permissions as trusted grants. The imported `tunnel` section is used only after explicit local approval.
- Original encrypted `secrets.bin` was copied byte-for-byte into Next's own `secrets.bin`; file modes are 0600. No credential plaintext was logged or persisted during migration.
- macOS Keychain service **`chat-on-steroids Safe Storage`** remained unchanged. The Next-specific service **`Chat On Steroids Next Safe Storage`** was updated with the original safe-storage key by an in-memory local Security.framework migration. Its prior key was preserved as a separate macOS Keychain backup with service **`CoS Next Previous Safe Storage Key Backup 20261008`**.
- No original app configuration, encrypted blob or Keychain item was overwritten. Original v3.1.16 remains installed.

## Validation evidence

1. Direct encrypted file copy hashes matched source and destination; source files stayed unchanged.
2. Before the Keychain operation, `NEXT_IMPORTED_OS_STORAGE=AVAILABLE` but `NEXT_IMPORTED_CONTROL_PLANE_CREDENTIAL=UNAVAILABLE`. This demonstrated that ciphertext copying alone was insufficient.
3. Security.framework migration returned `NEXT_KEYCHAIN_BACKUP=PRESERVED` and `NEXT_KEYCHAIN_MIGRATION=COMPLETE`, without printing password or key bytes.
4. **Packaged real Next App**, after migration, returned `NEXT_IMPORTED_CONTROL_PLANE_CREDENTIAL=READABLE`.
5. First real Core Tunnel smoke returned `auth-failed`. Comparison proved the old app's original Core connector was still usable; Next lacked the RFC 9728 OAuth protected-resource metadata route. This was not a credential rotation problem.
6. Implemented the token-scoped `/.well-known/oauth-protected-resource/next/<opaque>/mcp` metadata route with empty authorization servers and added protocol negative tests.
7. Packaged **Next App** subsequently returned `NEXT_IMPORTED_TUNNEL_CONNECTED=YES`, `NEXT_IMPORTED_TUNNEL_FINAL_STATE=connected`, `NEXT_IMPORTED_TUNNEL_STOP_VERIFIED=YES`, `NEXT_IMPORTED_TUNNEL_TEST=PASS`.
8. Refactored the validated Core Tunnel adapter into `imported-core-tunnel.ts` for both one-time tests and the native menu. Repackaged and repeated all three real smoke tests: offline Runtime PASS, Next key READABLE, connected/closed Tunnel PASS.

## Usage

From the **Next macOS preview application**, use the native menu:

- `CoS Next → Connect imported Core Tunnel…`. This uses an explicit, one-time OS-native approval for `tunnel:core`.
- `CoS Next → Show local runtime status` to see whether the imported read-only Core Tunnel is connected.
- `CoS Next → Disconnect imported Core Tunnel` to retire its process group with a shutdown proof.

**Do not launch old CoS while Next owns the same Tunnel ID.** Next refuses to connect if an original main or tunnel process is already present, and uses `nextRejectOrphans` to refuse ambiguous predecessor ownership. On Next shutdown, the Tunnel must be proven stopped before local MCP and writer lease are released.

The current Next MCP surface is limited to `runtime_health` and `identity_diagnostics`; Mission, shell, Worker, Agent and project mutation **remain unavailable remotely** until G1b/G2b verified-principal evidence. Tunnel authentication is **not** proof of exact ChatGPT conversation identity, and the imported control-plane API key is **not** a Sign in with ChatGPT OAuth model token.

## Recovery and rollback

Original data and Keychain service remain intact. Stop Next, verify that its Core Tunnel child has exited, then launch old CoS if needed. The original connector IDs are unchanged, so ChatGPT's existing old connector settings still refer to their registered IDs. If future migration requires restoring the previously provisioned Next Safe Storage key, use the encrypted OS Keychain backup item; never transmit or paste a Keychain password into ChatGPT.

Current preview bundle is in `CoS-Next-WP03/release-next/mac-arm64/Chat On Steroids Next.app`, not installed into `/Applications`. macOS ad-hoc signing is for local testing only. Actual cross-account ChatGPT session binding and eligible Codex subscription inference remain separate release gates.
