# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tracer is a CLI tool for reviewing diffs/PRs with intelligent navigation and AI-powered analysis. It renders terminal UIs using React and OpenTUI for syntax-highlighted diff viewing with multiple navigation modes.

## Core Commands

```bash
# Development
bun src/cli.tsx                    # Run CLI (don't run the TUI app directly - it will hang)
bun --watch src/cli.tsx            # Watch mode
bun add <package>                  # Install packages (never use npm)

# Usage
tracer [ref]                       # Show diff (defaults to unstaged changes)
tracer --staged                    # Show staged changes
tracer --commit <ref>              # Show specific commit
tracer --model claude|codex        # Specify AI model for intelligent mode
tracer difftool <local> <remote>   # Git difftool integration
tracer pick <branch>               # Pick files from another branch
```

## Architecture

### File Structure
- `src/cli.tsx` - CLI entry point, commands, React TUI app, navigation logic
- `src/diff.tsx` - Diff rendering with syntax highlighting (Shiki), word-level diffs, split view
- `src/intelligent.tsx` - AI-powered diff analysis (Claude/Codex integration)

### Navigation Modes
Four modes controlled by state (cycle with `m` key):
- `FILE_NAVIGATION` - Navigate between files
- `HUNK_NAVIGATION` - Navigate hunks within files, arrow keys to switch files
- `HUNK_ONLY` - Linear hunk navigation across all files
- `INTELLIGENT` - AI-analyzed sorting by importance (breaking/feature/fix/etc)

### State Management
- Zustand store (`useDiffStateStore`) with filesystem persistence to `~/.tracer/config.json`
- AI analysis results cached in `~/.tracer/analysis/` indexed by diff hash
- Never use stale render state for API calls - use `useStore.getState().stateValue`

### AI Analysis System
- Shells out to `claude -p` or `codex exec` CLI tools
- Classifies files: breaking, feature, refactor, fix, test, docs, style
- Sorts files by priority and caches results per commit

## Framework-Specific Rules

### OpenTUI (Terminal UI Framework)
CRITICAL: Always read OpenTUI docs before starting tasks:
```bash
curl -s https://raw.githubusercontent.com/sst/opentui/refs/heads/main/packages/react/README.md
```

- `<input>` uses `onInput` not `onChange`, receives string value not event object
- JSX import source is `@opentui/react` (configured in tsconfig.json)

### React Patterns
- NEVER pass functions as useEffect dependencies (causes infinite loops)
- NEVER use useCallback (unnecessary if we don't pass functions to useEffect)
- Try to avoid useEffect - move logic directly to event handlers when possible
- Minimize props - prefer zustand state over prop drilling

### TypeScript
- Import Node.js APIs as namespaces: `import fs from 'fs'` not `import { writeFileSync } from 'fs'`
- Never use ESM imports from `.tsx` files - always use `import` at top
- DO NOT use `as any` - fix types properly
- `noImplicitAny: false` in config but still maintain type safety

### Class Components
When using classes, ALWAYS bind methods in constructor:
```typescript
constructor(options: Options) {
  this.prop = options.prop
  this.method1 = this.method1.bind(this)
  this.method2 = this.method2.bind(this)
}
```

## Development Workflow

### Research Patterns
Can use gitchamber.com to read GitHub repositories:
```bash
curl https://gitchamber.com/repos/<owner>/<repo>/main/files
curl https://gitchamber.com/repos/<owner>/<repo>/main/files?glob=path/**
```

Example - OpenTUI examples:
```bash
curl https://gitchamber.com/repos/sst/opentui/main/files?glob=packages/react/examples/**
```

### Changelog Updates
After meaningful changes:
1. Bump version in `package.json` (NEVER do major bumps)
2. Update `CHANGELOG.md` with concise bullet points
3. Group changes by command or feature area
4. NEVER update existing changelog entries unless you added them in same session

## Key Technical Details

### Syntax Highlighting
- Uses Shiki with `github-dark-default` theme
- Language detection from file extensions
- Stateful highlighting maintains grammar state across lines for accuracy

### Word-Level Diffs
- Calculates Levenshtein distance similarity between removed/added line pairs
- Only shows word-level highlighting if similarity >= 0.5
- Highlights changed words with colored backgrounds

### Caching Strategy
- Diff analysis cached at `~/.tracer/analysis/<diffsha>.json`
- Index at `~/.tracer/diffs.json` maps `{repoDir: {commitKey: diffSha}}`
- Diff hash includes model name to avoid cross-contamination

### File Filtering
Automatically ignores lock files (package-lock.json, yarn.lock, Cargo.lock, etc.) and files with >6000 total lines.
