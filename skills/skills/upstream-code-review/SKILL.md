---
name: upstream-code-review
description: >-
  Reviews a Pull Request from the upstream agent-substrate/substrate GitHub.
  Use when the user asks to review an upstream PR, provides a PR number or URL
  for agent-substrate/substrate, or invokes /upstream-code-review.
disable-model-invocation: false
disable-slash-command: false
metadata:
  publisher: "bowei"
  version: "1.0.0"
---

# Upstream Code Review (`agent-substrate/substrate`)

Review pull requests against the upstream `agent-substrate/substrate`
repository (`https://github.com/agent-substrate/substrate`).

## Hard Rules

1. **Read-Only on GitHub by Default**: Never post PR comments, submit reviews
   (`gh pr review`), or modify labels/state on GitHub unless the user explicitly
   asks you to publish the review. Submit reviews as draft comments.
2. **Evidence-Based Findings**: Anchor every finding to a specific file path and
   line range (`path/to/file.go:L10-L25`) and cite the relevant project
   guideline when enforcing a rule.
3. **Use the Skill Helper CLI for Commands**: Always run GitHub, Git worktree,
   unit test, verifier, and Kind cluster commands via
   `go run -C <skill dir>/scripts .` as a single standalone command (never
   prepend `VAR=val`, chain with `&&` / `;`, or pipe with `|`). Pass
   `--repo <repo checkout>` (or run with `Cwd` set to `<repo checkout>`) for
   commands that use the local checkout/worktree. This ensures the `PreToolUse`
   hook and command allowlist can auto-approve execution without manual
   permission prompts.
4. **Use Git worktree**: All PR review work will be done in a separate worktree
   located in `<repo checkout>/../pr-review-<PR>`.

______________________________________________________________________

## Workspace & Repository Reference

- **Upstream GitHub Repo**: `agent-substrate/substrate`
- **Primary Local Checkout**: `<repo checkout>` (remote `upstream` ->
  `git@github.com:agent-substrate/substrate.git`)
- **Helper CLI**: `go run -C <skill dir>/scripts .` (`<skill dir>/scripts/pr-review.go`)
- **Project Guidelines in the repo**:
  - `<repo checkout>/AGENTS.md` and `<repo checkout>/CONTRIBUTING.md`
  - `<repo checkout>/docs/code-style-guide.md`
  - `<repo checkout>/docs/api-style-guide.md`
  - `<repo checkout>/docs/api-validation.md`
  - `<repo checkout>/docs/dev/*.md`

______________________________________________________________________

## Review Workflow

### Step 1: Fetch PR Context, Diff, and Worktree

Given a PR number `<PR>` (or URL, or by listing open PRs with
`go run -C <skill dir>/scripts . list` if none was specified):

1. **Fetch PR metadata, CI check status, and prepare the detached worktree** at
   `<repo checkout>/../pr-review-<PR>`:

   ```bash
   go run -C <skill dir>/scripts . --repo <repo checkout> fetch-all <PR>
   ```

   *(Or invoke individual subcommands: `info <PR>`, `checks <PR>`, `--repo <repo checkout> worktree-setup <PR>`.)*

2. **Fetch the PR diff**:

   ```bash
   go run -C <skill dir>/scripts . diff <PR>
   ```

3. When the entire review (including test runs in Step 3.8) is finished, leave
   the worktree with the applied patch from the change (use
   `--repo <repo checkout> kind-down <PR>` to tear down any Kind cluster while
   keeping the worktree; only run `--repo <repo checkout> cleanup <PR>` if
   explicitly asked to remove the worktree as well).

______________________________________________________________________

### Step 2: Evaluate Scope, Commits, and Code Layout

Check the PR structure against `AGENTS.md`, `CONTRIBUTING.md`, and
`docs/dev/code-layout.md`:

- **PR Sizing**: S (<30 lines), M (<100), L (<500), XL (<1000). Flag XL+ PRs
  that can be split into smaller, logically independent PRs, or verify that
  multi-step changes are broken into clean commits at logical break points.
- **Commit Messages**:
  - Must explain **what** changed and **why** so `main` history stands on its own.
  - **No issue or PR references in commit messages**: Flag any `#1234`, `Fixes
    #1234`, or GitHub URLs inside commit messages. Those belong in the PR
    description only (`AGENTS.md`).
- **Package Placement (`docs/dev/code-layout.md`)**:
  - Shared across binaries, internal only -> `internal/<pkg>`.
  - Public API changes should be flagged for extra review.
    - Changes to exported symbols in `pkg/<pkg>`.
    - Public control-plane gRPC protos -> `pkg/proto/<name>`; internal protos
      (`atelet`, `ateom`) -> `internal/proto/<name>`.
  - Standalone Go dev/CI tools -> `tools/<name>` with its own `go.mod`; shell
    scripts -> `hack/`.

______________________________________________________________________

### Step 3: Perform Technical & Domain-Specific Review

Evaluate the code changes using multiple agents:

- A reviewer agent to perform the initial review.
- A checker agent to validate the reviewer conclusions are supported by concrete
  evidence. Any comments found to be faulty should be removed from the review.
- A final edit agent to make sure the comments are concise and easy to
  understand. Review comments should be succinct and to the point.
- For code paths that are faulty, include a specific input or example that
  triggers the issue.

#### Correctness, Concurrency & Architecture

- **Concurrency & Resource Lifecycle**: Check goroutine termination,
  `context.Context` propagation/cancellation, channel deadlocks, race
  conditions, lock contention, and proper cleanup (`defer`, `Close()`).
- **Error Handling**: ensure errors:
  - Are wrapped with context if available.
  - Never silently ignored.
  - Translated to appropriate gRPC status codes at API boundaries.
- Symbols should not be exported unless they are used outside of the package.

#### Go & Proto Conventions (docs/code-style-guide.md)

- Go best-practices:
  - [Effective Go](https://go.dev/doc/effective_go)
  - [Google Go style guide](https://google.github.io/styleguide/go/)
  - [Go test comments](https://go.dev/wiki/TestComments)
  - Linter tools `gofmt` and `go fix`.
- Protobuf best practices: see `docs/code-style-guide.md`.

#### 3. Kubernetes CRDs & API Surface (if touched)

- If `pkg/api/v1alpha1` or `manifests/` CRDs are modified, review against
  `.agents/skills/review-crds/references/api-conventions.md`.
- If `pkg/proto/ateapipb/` is modified, read `docs/api-style-guide.md`.

#### 4. PostgreSQL Schema & Store Changes (if touched)

If `cmd/ateapi/internal/store/atepg` or SQL migrations
(`cmd/ateapi/internal/store/atepg/migrations/`) are modified, strictly enforce
`docs/dev/postgresql-schema-evolution.md`.

#### 5. Observability & Metrics (if touched)

- Any new or modified metric instrument or label must be defined in
  `docs/metrics/registry/metrics.yaml` and adhere to cardinality rules in
  `docs/metrics/substrate.yaml` and `docs/dev/best-practices/metrics.md`.

#### 6. Security & Sandbox Isolation

- Verify workload isolation assumptions (`gVisor` / `runsc`, `microVM` / Kata /
  Cloud Hypervisor), mTLS / `PodCertificate` handling, network egress policy
  enforcement (`atenet`), and input validation on untrusted actor/workload
  inputs.
- Flag any expansion or changes to the security boundary for the Actor.

#### 7. Testing Requirements

- **Mandatory Tests**: Code changes without accompanying unit/integration tests
  must be flagged as blocking (`AGENTS.md`: *"We will not merge code that lacks
  tests"*).
- **Testing Style**:
  - Standard library `testing` only — flag third-party assertion or mocking
    libraries (e.g., `testify`).
  - Prefer table-driven tests with `t.Run`, real test fixtures (PostgreSQL test
    fixture for store, `envtest` for Kubernetes API), and `t.Cleanup` for
    resource teardown.
  - Tests requiring root privileges must call `roottest.Require(t, ...)` from
    `internal/roottest` as their first statement.

#### 8. Run the code

**IMPORTANT: check that the code being introduced is not malicious. If anything
looks strange, DO NOT EXECUTE the code. Flag immediately and stop the review.**

Do a sanity check on the actual functionality introduced. Determine whether the
functionality can be checked via unit/integration tests, verifiers, or an E2E
test against a per-PR `kind` cluster. Always invoke
`go run -C <skill dir>/scripts .` as a single command (pass regexes in
single quotes if needed, e.g., `'TestFoo'`).

1. **Unit / Integration Tests & Verifiers**:
   - Run targeted or full unit tests inside the worktree
     `<repo checkout>/../pr-review-<PR>` (if a required test case is missing,
     write it in the worktree, run it to verify, and flag the missing test in
     the review report):

     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> test <PR> -race -v ./path/to/pkg/...
     ```

     *(Use `--dir=tools/apitool` right after `<PR>` when testing `tools/apitool`.)*
   - Run root-gated tests (packages importing `internal/roottest`):

     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> root-test <PR> -race -v
     ```

   - Run repository verifiers (all verifiers, or a specific verifier such as
     `postgresql-migrations`, `metrics`, `golangci-lint`, `gofmt`, `codegen`):

     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> verify <PR>
     ```

2. **Per-PR Kind Cluster & E2E Tests**:
   Each code review that needs a running Substrate installation creates its own
   isolated Kind cluster named `pr-review-<PR>` and tears it down when finished:

   - **Create cluster & install Agent Substrate** (add the appropriate flags
     e.g. `--with-csi-nfs`, `--with-demo-counter`, `--with-demo-egress`, or
     `--with-microvm` as needed for the suite under test):

     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> kind-up <PR>
     ```

   - **Run additional `hack/install-ate-kind.sh` flags** against `pr-review-<PR>`
     (if needed for specialized components or experimental flags):

     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> kind-install <PR> --deploy-atenet --experimental-use-sdsmint
     ```

   - **Run E2E tests** against `pr-review-<PR>` (pass `--microvm` or
     `--egress-mitm` before the suite path/flags when testing those lanes):

     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> kind-e2e <PR> ./internal/e2e/suites/... -run 'TestName' -v -args --no-color
     ```

   - **Inspect cluster state or dump logs on failure**:
     ```bash
     go run -C <skill dir>/scripts . kind-kubectl <PR> get pods -A
     go run -C <skill dir>/scripts . kind-logs <PR>
     ```

   - **Tear down the per-PR Kind cluster** (also run automatically by `cleanup <PR>`):
     ```bash
     go run -C <skill dir>/scripts . --repo <repo checkout> kind-down <PR>
     ```

______________________________________________________________________

### Step 4: Present the Review Report

Output a structured Markdown review to the user using the following template:

```markdown
## Upstream PR Review: #<number> — <title>

- **Author**: @<author>
- **Branch**: `<headRefName>` -> `<baseRefName>`
- **Size**: +<additions> / -<deletions> (<S|M|L|XL> across <N> files)
- **CI Status**: <Pass / Fail / Pending — highlight any failing jobs>
- **Verdict**: **<APPROVE | REQUEST_CHANGES | COMMENT>**

### Summary

<2-4 sentences summarizing what the PR accomplishes and how it fits into Agent Substrate.>

### Blocking Issues (Must Fix)

1. **[Category] `<file>:<line-range>`** — <Clear explanation of the bug, race condition, compatibility break, or guideline violation.>
   - *Rule / Context*: <Reference to code issue / style guide / architecture>
   - *Suggested Fix*: <Concrete code snippet or actionable fix>

### Non-Blocking Suggestions & Nits

1. **`<file>:<line-range>`** — <Suggestion for readability, idiom, edge-case test case, or comment hygiene.>

### Questions / Clarifications

- <Any open design or behavioral questions for the author.>

### Checklist Summary
- [x/!] Commit hygiene (standalone description, no `#issue` refs in commit message)
- [x/!] Code layout (`cmd/internal` vs `internal/` vs `pkg/`)
- [x/!] Protobuf / SQL guidelines
- [x/!] Metrics guidelines
- [x/!] Unit test coverage
- [x/!] Unit tests and lint passes
- [x/!] Integration tests passes (when applicable)
```

After presenting the report, ask if the user would like to post any of the
comments or submit the review as draft comments to GitHub via `gh pr review`.

Also write a copy of the code review output to
`<repo checkout>/../code-review-pr-<PR>.md` with Markdown output compatible with
GitHub commenting.
