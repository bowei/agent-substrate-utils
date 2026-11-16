# README

This repository is a simple UI for Github issue triage.

It will be implemented as an Electron application.

The triage UI will show the following:

1. Take in as input a YAML with the following rough format:

```yaml
pr:
  - link: https://github.com/agent-substrate/substrate/pull/3867
    shortDescription: [...]
    description: "..."
    currentLabels: [...]
    labels:
    - name: "..."
      action: ADD # or REMOVE
      reason: "..."
issue:
  - link: https://github.com/agent-substrate/substrate/issues/3876
    shortDescription: [...]
    description: "..."
    currentLabels: [...]
    labels:
    - name: "..."
      action: ADD # or REMOVE
      reason: "..."
```

2. Show the proposed changes in a tabular format.
3. The UI should allow the user to edit the proposed changes: add/remove label
   changes that are proposed.
4. Output a script either saved to a file or to clipboard that runs the `gh` CLI
   commands to implement the changes.

## YAML Schema Reference

The input document is a UTF-8 YAML mapping containing one or both top-level keys (`pr` and `issue`).

### Top-Level Object

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `pr` | `Array<TriageItem>` | Optional* | List of GitHub Pull Requests and their proposed label changes. |
| `issue` | `Array<TriageItem>` | Optional* | List of GitHub Issues and their proposed label changes. |

*\*At least one of `pr` or `issue` should be present.*

### `TriageItem` Object

Each entry inside the `pr` or `issue` list represents a single GitHub Pull Request or Issue:

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `link` | `string` | **Required** | Full GitHub URL for the PR or Issue (e.g., `https://github.com/<owner>/<repo>/pull/<number>` or `https://github.com/<owner>/<repo>/issues/<number>`). Used to extract `<owner>/<repo>` and `<number>` for `gh pr edit` / `gh issue edit` commands and to open the item in the browser. |
| `shortDescription` | `string[]` or `string` | Optional | Concise summary of the PR or Issue. Can be provided either as a list of bullet strings (first line is used as the title/comment in the generated `gh` script, subsequent lines as detail) or as a single string. Defaults to `[]`. |
| `description` | `string` or `string[]` | Optional | Full description / body text from the linked GitHub PR or Issue. The UI displays the first ~200 words with the remainder collapsed behind an expand/collapse toggle. If omitted from the YAML, the app automatically attempts to fetch the body from the linked GitHub item via `gh` CLI / GitHub API. |
| `currentLabels` | `string[]` | Optional | List of label names currently applied to the PR or Issue on GitHub. Displayed in the **Current Labels** column; clicking any current label in the UI stages a `REMOVE` action for it. Defaults to `[]`. |
| `labels` | `Array<LabelChange>` | Optional | List of proposed label additions or removals for this item. Defaults to `[]`. |

### `LabelChange` Object

Each entry in a `TriageItem`'s `labels` list describes a single proposed label modification:

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Required** | Exact GitHub label name to add or remove (e.g., `"kind/bug"`, `"needs-triage"`, `"good first issue"`). Empty names are ignored. |
| `action` | `"ADD"` \| `"REMOVE"` | Optional | Whether to add (`ADD` $\rightarrow$ `--add-label`) or remove (`REMOVE` $\rightarrow$ `--remove-label`) the label. Case-insensitive; defaults to `"ADD"` if omitted. |
| `reason` | `string` | Optional | Human-readable rationale explaining why this label is being added or removed. Displayed alongside the label badge in the UI. Defaults to `""`. |

### Complete Example

```yaml
pr:
  - link: https://github.com/agent-substrate/substrate/pull/3867
    shortDescription:
      - "Fix race condition in worker pool shutdown sequence"
      - "Ensures all inflight tasks complete or cancel cleanly before channel close"
    description: |
      When a worker node receives SIGTERM under heavy request load, WorkerPool.Close()
      previously closed the internal resultsCh channel immediately after cancelling the
      root context, without waiting for active worker goroutines to drain...
    currentLabels:
      - "area/runtime"
      - "needs-triage"
    labels:
      - name: "kind/bug"
        action: ADD
        reason: "Fixes a deterministic concurrency crash during graceful termination"
      - name: "priority/p1"
        action: ADD
        reason: "Blocks clean shutdown in production worker nodes"
      - name: "needs-triage"
        action: REMOVE
        reason: "PR has been reviewed and categorized"

issue:
  - link: https://github.com/agent-substrate/substrate/issues/3876
    shortDescription:
      - "Memory spike when parsing large YAML manifests (>50MB)"
    currentLabels:
      - "needs-triage"
      - "kind/Cleanup"
    labels:
      - name: "area/parser"
        action: ADD
        reason: "Issue occurs in the manifest loader pipeline"
      - name: "kind/bug"
        action: ADD
        reason: "OOM crash reported with reproduction steps"
      - name: "kind/Cleanup"
        action: REMOVE
        reason: "Misclassified as cleanup; this is an active memory regression"
      - name: "needs-triage"
        action: REMOVE
        reason: "Initial triage completed"
```

## Usage

Install dependencies:

```bash
npm install
```

Launch the Electron application (loads `sample-triage.yaml` by default, or pass a path to a YAML file):

```bash
npm start
# Or load a specific YAML file:
npm start -- /path/to/triage.yaml
```

Run verification tests:

```bash
npm test
```
