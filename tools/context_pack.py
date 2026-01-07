#!/usr/bin/env python3
"""
Context Pack generator for paste-based Copilot workflows.

Usage:
  python tools/context_pack.py <file1> [file2 ...] [--max-files 5] [--max-bytes 800000] [--no-git] [--fence]

Outputs a single, pasteable block containing:
- repo + branch + commit SHA (if available)
- per-file sha256
- file contents
"""

from __future__ import annotations
import argparse
import hashlib
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MAX_FILES = 5
DEFAULT_MAX_BYTES = 800_000  # keep under typical chat limits; adjust as needed


def run_git(args: list[str]) -> str | None:
    try:
        out = subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL)
        return out.decode("utf-8", errors="replace").strip()
    except Exception:
        return None


def sha256_text(s: str) -> str:
    h = hashlib.sha256()
    h.update(s.encode("utf-8", errors="replace"))
    return h.hexdigest()


def read_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", help="File paths relative to repo root (or absolute).")
    ap.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--no-git", action="store_true", help="Skip git metadata (for non-git folders).")
    ap.add_argument("--fence", action="store_true", help="Wrap output in a triple-backtick code fence.")
    ns = ap.parse_args()

    if len(ns.files) > ns.max_files:
        print(f"ERROR: Too many files ({len(ns.files)}). Max is {ns.max_files}.", file=sys.stderr)
        return 2

    repo_root = None
    repo_name = None
    branch = None
    commit = None

    if not ns.no_git:
        repo_root = run_git(["rev-parse", "--show-toplevel"])
        if repo_root:
            repo_root_p = Path(repo_root)
            repo_name = repo_root_p.name
            branch = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
            commit = run_git(["rev-parse", "HEAD"])

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    entries: list[tuple[str, str, str]] = []  # (display_path, sha256, content)
    total_bytes = 0

    for raw in ns.files:
        p = Path(raw)
        if not p.is_absolute():
            if repo_root:
                p = Path(repo_root) / p
            else:
                p = Path.cwd() / p

        if not p.exists() or not p.is_file():
            print(f"ERROR: Not a file or missing: {raw}", file=sys.stderr)
            return 2

        content = read_text_file(p)
        digest = sha256_text(content)

        display_path = str(p)
        if repo_root:
            try:
                display_path = str(p.resolve().relative_to(Path(repo_root).resolve()))
            except Exception:
                display_path = str(p)

        total_bytes += len(content.encode("utf-8", errors="replace"))
        if total_bytes > ns.max_bytes:
            print(
                f"ERROR: Context pack too large (>{ns.max_bytes} bytes). "
                f"Reduce files or raise --max-bytes cautiously.",
                file=sys.stderr,
            )
            return 2

        entries.append((display_path, digest, content))

    if ns.fence:
        print("```text")

    print("BEGIN_CONTEXT_PACK")
    print(f"generated_utc: {now}")
    if repo_root:
        print(f"repo_root: {repo_root}")
    if repo_name:
        print(f"repo_name: {repo_name}")
    if branch:
        print(f"git_branch: {branch}")
    if commit:
        print(f"git_commit: {commit}")
    print(f"file_count: {len(entries)}")
    print("")

    for (display_path, digest, content) in entries:
        print("BEGIN_FILE")
        print(f"path: {display_path}")
        print(f"sha256: {digest}")
        print("CONTENT_START")
        print(content.rstrip("\n"))
        print("CONTENT_END")
        print("END_FILE")
        print("")

    print("END_CONTEXT_PACK")

    if ns.fence:
        print("```")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
