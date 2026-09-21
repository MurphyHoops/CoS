# Project Runtime Profile

CoS 3.1 can bind a durable mission to an optional, project-owned runtime contract at:

```text
.cos/project.json
```

The contract is deliberately small. It describes **named local verification tasks** and **machine-verifiable completion predicates** without teaching CoS about a language, build system, repository host or application domain.

## Why it exists

A generic durable runtime needs to know two project-specific facts without embedding them in a model prompt:

1. how the project verifies itself;
2. what local evidence is sufficient to say the requested work is complete.

Those facts belong to the project. CoS supplies the scheduler, custody, permissions, recovery and completion evaluator.

A project with no profile keeps the existing CoS behavior unchanged.

## Version 1

Example:

```json
{
  "version": 1,
  "tasks": {
    "verify": {
      "argv": ["npm", "run", "verify"],
      "timeout_ms": 300000,
      "description": "Run the project's release verification"
    }
  },
  "completion": {
    "mode": "all",
    "auto_stop": true,
    "checks": [
      { "kind": "task_success", "task": "verify" },
      { "kind": "path_absent", "path": "TODO.blocker" }
    ]
  }
}
```

### Tasks

A task is a direct argv vector. CoS does not invoke a shell to reinterpret the string.

Current task fields:

- `argv` — required non-empty argument vector;
- `timeout_ms` — optional bounded timeout;
- `description` — optional human-readable purpose.

Reading the profile requires the current CoS read capability. Task execution still requires the
current command capability, and path predicates require filesystem-metadata capability. A profile
never grants permission by itself.

### Completion predicates

Current predicate kinds:

- `task_success` — the named task exits successfully without timing out;
- `path_exists` — the project-relative path exists;
- `path_absent` — the project-relative path does not exist.

`mode` is either:

- `all` — every configured predicate must be satisfied;
- `any` — one satisfied predicate is enough.

A blocked predicate is different from an unsatisfied predicate. For example, a task check is blocked when command execution is disabled.

## Automatic completion

`completion.auto_stop` defaults to `false`.

When explicitly enabled, Long-Run may fulfill an **owed** work obligation after the local completion evaluator reports `satisfied`. It does not revoke work already crossing a dispatch boundary and it does not fabricate completion from model prose.

Automatic evaluation is also one-shot for an owed obligation. Before any command-backed
completion check can start, CoS durably records that the obligation has claimed its machine
completion attempt. If the app crashes, the executor is rebound, or the verifier result becomes
ambiguous after that boundary, CoS does **not** replay the verifier automatically; ordinary durable
continuation remains the fail-open path.

This gives the runtime a machine-owned finish line:

```text
executor says "done"
        ↓
not authoritative by itself
        ↓
Project Runtime evaluates project contract
        ↓
satisfied / unsatisfied / blocked / unconfigured
        ↓
only satisfied + auto_stop may close eligible durable debt
```

## Security boundaries

The profile is data, not authority.

- The profile file itself is resolved through the approved project sandbox.
- Profile reads require the current read capability; path predicates require metadata capability.
- Symlinks may not escape the bound project.
- Predicate paths are project-relative and canonicalized through the same sandbox.
- Absolute paths, backslash spellings and `.` / `..` path traversal are rejected.
- Profile reads are descriptor-bound and size-bounded, then revalidated before use so a path swap
  during an await cannot silently change which file was evaluated.
- Task execution obeys current command permissions and existing process custody.
- `project_runtime status` does not disclose task argv or native project paths. Executable command
  text remains local to the runtime.
- Task-check results expose bounded exit/timing metadata, not verifier stdout/stderr or executable
  diagnostics that may contain local paths or secrets.
- The model-facing status reports the relative profile path, task names/descriptions and declarative completion rules.

## Model-facing procedure

Core exposes one bounded procedure:

```text
project_runtime
```

Actions:

- `status` — inspect whether the current mission has a validated profile and see its safe summary;
- `check` — evaluate the configured completion predicates now.

This is intentionally one procedure rather than a family of project-specific tools.

## Portability

CoS does not need to know whether the project is TypeScript, Lean, Rust, Python, a research repository, an application or a deployment workspace. The project chooses portable commands and predicates; CoS provides the durable control plane.

New predicate or adapter kinds should be added only when they express a generally reusable capability. Domain-specific policy belongs in the project profile or project code, not in the scheduler core.

See [architecture.md](architecture.md), [long-run-runtime.md](long-run-runtime.md) and [tool-surface.md](tool-surface.md).
