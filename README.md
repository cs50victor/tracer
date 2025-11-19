# Tracer

Terminal UI for reviewing git diffs with intelligent navigation and AI-powered analysis.

## What it does

Syntax-highlighted diff viewer with multiple navigation modes and optional AI classification of changes. Navigate by file, by hunk, or let AI sort changes by importance (breaking changes first, then features, fixes, etc).

## Usage

```bash
# View unstaged changes
tracer

# View staged changes
tracer --staged

# View specific commit
tracer --commit HEAD~1

# View git ref
tracer main..feature-branch

# AI-powered analysis (press 'm' to cycle to INTELLIGENT mode)
tracer --model claude   # or --model codex

# Pick files from another branch
tracer pick feature-branch

# Git difftool integration
git config --global diff.tool tracer
git config --global difftool.tracer.cmd 'tracer difftool "$LOCAL" "$REMOTE"'
git difftool
```

## Navigation

- `m` - Cycle modes (FILE / HUNK / HUNK_ONLY / INTELLIGENT)
- `ctrl+p` - Quick file search
- Arrow keys - Navigate (behavior changes per mode)
- `q` or `esc` - Quit

---

Scaffolded from [critique](https://github.com/remorses/critique).
