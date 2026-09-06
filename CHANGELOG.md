# Changelog

## 0.1.2

- mcp
  - Open local files and pull request diffs in Zed by default, with an explicit Ghostty option for range highlighting.
  - Highlight requested ranges with temporary Zed snapshot diffs by default; accept `diff: false` to open the source directly.

## 0.1.1

- mcp
  - Prevent repeated Ghostty execution prompts when highlighting local files on macOS.
  - Add a pure `setup` tool that returns a teach-skill walkthrough prompt.
- distribution
  - Grant the reusable npm publish job permission to issue provenance tokens.

## 0.1.0

- mcp
  - Add `tracer mcp` with tools for code highlighting and directory walkthrough checklists.
  - Support concurrent agents through atomic manifests and per-file completion markers.
  - Return explicit view-conflict ownership and structured raw command failures to agents.
  - Fetch the latest pull request diff with `gh` and render local or remote ranges with `bat` in Ghostty.
- distribution
  - Add tagged macOS and Linux binary releases for Homebrew.

## 0.0.1

- tracer
  - Hovering a changed snippet now keeps it in focus and dims every other code block in the diff view.
  - Intelligent mode optimized for large PRs/diffs where AI analysis time is amortized across dozens of files. Small PRs (few files) are faster to review manually.
