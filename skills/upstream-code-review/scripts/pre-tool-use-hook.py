#!/usr/bin/env python3
"""PreToolUse hook for upstream-code-review helper scripts.

Automatically allows safe single-command `go run` invocations of
`_agents/skills/upstream-code-review/scripts` while falling back to the default
`"allow"` decision for all other commands.
"""

import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
ALLOWED_TARGETS = {
    SCRIPT_DIR,
    os.path.join(SCRIPT_DIR, "pr-review.go"),
}

ALLOWED_SUBCOMMANDS = {
    "list",
    "info",
    "context",
    "checks",
    "diff",
    "worktree-setup",
    "setup",
    "fetch-all",
    "test",
    "root-test",
    "verify",
    "kind-up",
    "kind-install",
    "kind-e2e",
    "kind-kubectl",
    "kind-logs",
    "kind-down",
    "worktree-cleanup",
    "cleanup",
    "-h",
    "--help",
    "help",
}

# Match whitespace-separated tokens where each token is either:
# - a strict bareword with no shell metacharacters, or
# - a single-quoted literal string (which has zero expansion in sh/bash/zsh).
TOKEN_RE = re.compile(r"""[ \t]*(?:([A-Za-z0-9_./:=,@+-]+)|'([^']*)')[ \t]*""")


def tokenize_safe_command(cmd: str) -> list[str] | None:
  if not cmd or "\n" in cmd or "\r" in cmd:
    return None
  tokens: list[str] = []
  pos = 0
  n = len(cmd)
  while pos < n:
    m = TOKEN_RE.match(cmd, pos)
    if not m:
      return None
    bare, sq = m.group(1), m.group(2)
    tokens.append(bare if bare is not None else sq)
    pos = m.end()
  return tokens if tokens else None


def _resolve_dir(base_dir: str, path: str) -> str:
  return os.path.realpath(
      path if os.path.isabs(path) else os.path.join(base_dir, path)
  )


def _consume_c_flag(
    tokens: list[str], idx: int, base_dir: str
) -> tuple[int, str] | None:
  if idx >= len(tokens):
    return idx, base_dir
  tok = tokens[idx]
  if tok == "-C":
    if idx + 1 >= len(tokens) or not tokens[idx + 1]:
      return None
    return idx + 2, _resolve_dir(base_dir, tokens[idx + 1])
  if tok.startswith("-C="):
    val = tok.split("=", 1)[1]
    if not val:
      return None
    return idx + 1, _resolve_dir(base_dir, val)
  return idx, base_dir


def is_allowed_pr_review_command(cmd: str, cwd: str) -> bool:
  tokens = tokenize_safe_command(cmd)
  if not tokens:
    return False

  idx = 0
  if tokens[idx] in ("/usr/bin/env", "env"):
    idx += 1
  if idx >= len(tokens):
    return False

  go_bin = tokens[idx]
  if go_bin != "go" and not go_bin.endswith("/go"):
    return False
  idx += 1

  effective_dir = cwd or os.getcwd()

  # Optional `-C <dir>` before `run`
  c_res = _consume_c_flag(tokens, idx, effective_dir)
  if c_res is None:
    return False
  idx, effective_dir = c_res

  if idx >= len(tokens) or tokens[idx] != "run":
    return False
  idx += 1

  # Optional `-C <dir>` after `run`
  c_res = _consume_c_flag(tokens, idx, effective_dir)
  if c_res is None:
    return False
  idx, effective_dir = c_res

  if idx >= len(tokens):
    return False

  pkg_target = tokens[idx]
  resolved_target = _resolve_dir(effective_dir, pkg_target)
  if resolved_target not in ALLOWED_TARGETS:
    return False
  idx += 1

  while idx < len(tokens):
    tok = tokens[idx]
    if tok in ("--repo", "-C"):
      if idx + 1 >= len(tokens) or not tokens[idx + 1]:
        return False
      idx += 2
    elif tok.startswith("--repo=") or tok.startswith("-C="):
      if not tok.split("=", 1)[1]:
        return False
      idx += 1
    else:
      break

  subcmd = tokens[idx] if idx < len(tokens) else "help"
  if subcmd not in ALLOWED_SUBCOMMANDS:
    return False

  return True


def main() -> None:
  try:
    payload = json.load(sys.stdin)
  except Exception:
    print(json.dumps({"decision": "allow"}))
    return

  tool_call = payload.get("toolCall") or {}
  if tool_call.get("name") != "run_command":
    print(json.dumps({"decision": "allow"}))
    return

  args = tool_call.get("args") or {}
  cmd = args.get("CommandLine") or ""
  cwd = args.get("Cwd") or ""

  if is_allowed_pr_review_command(cmd, cwd):
    print(
        json.dumps({
            "decision": "auto_approve",
            "reason": "Auto-approved upstream-code-review helper CLI.",
            "overwrite": {
                "BypassSandbox": True,
            },
        })
    )
  else:
    print(json.dumps({"decision": "allow"}))


if __name__ == "__main__":
  main()
