import { exec } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import fs from "fs";

const execAsync = promisify(exec);

export type ClassificationType =
  | "breaking"
  | "feature"
  | "refactor"
  | "fix"
  | "test"
  | "docs"
  | "style"
  | "unknown";

export type RiskLevel = "high" | "medium" | "low";

export interface HunkAnalysis {
  file: string;
  lineStart: number;
  lineEnd: number;
  description: string;
  classification: ClassificationType;
  risk: RiskLevel;
}

export interface AnalysisResult {
  hunks: HunkAnalysis[];
  timestamp: number;
  version?: string;
}

const CLASSIFICATION_PRIORITY: Record<ClassificationType, number> = {
  breaking: 0,
  feature: 1,
  fix: 2,
  refactor: 3,
  test: 4,
  docs: 5,
  style: 6,
  unknown: 7,
};

const ANALYSIS_VERSION = "v2";

export async function analyzeDiff(diffContent: string, model: string = "claude"): Promise<AnalysisResult> {
  try {
    const timestamp = Date.now();
    const tempDir = tmpdir();
    const diffPath = join(tempDir, `tracer-${timestamp}.diff`);

    fs.writeFileSync(diffPath, diffContent);

    const prompt = `You are analyzing a git diff for intelligent code review. Read the diff from ${diffPath}.

Your job is to break changes into SMALL, LOGICAL segments and order them so an engineer can understand the entire changeset in ONE FORWARD PASS - like reading a story from beginning to end.

CRITICAL RULES:
1. Split large changes into bite-sized segments (never >150 lines)
2. Use natural code boundaries: individual functions, class methods, import blocks, related constants
3. Each segment should be understandable in <10 seconds

NARRATIVE ORDERING (MOST IMPORTANT):
The order you output hunks matters critically. The engineer will read top-to-bottom without jumping around.

Order hunks to tell a coherent story:
- If change B depends on change A, show A first
- Group related changes together (don't split a feature across distant indexes)
- Show foundational changes before things that build on them
- Within a logical unit, prioritize: breaking > feature > fix > refactor > test > docs > style
- Think: "What order minimizes confusion and backtracking?"

Example good flow:
1. Add new helper function (enables next changes)
2. Update main logic to use helper (builds on #1)
3. Add tests for new behavior (validates #2)
4. Update docs (describes #1-3)

Example bad flow:
1. Add tests (user: "tests for what?")
2. Update docs (user: "docs for what?")
3. Add feature (user: "oh, that's what the tests were for - should've shown this first")

Return ONLY valid JSON in this exact format (no markdown, no code blocks, no explanation):
{
  "hunks": [
    {
      "file": "path/to/file",
      "lineStart": 1,
      "lineEnd": 22,
      "description": "Import statements for React and Shiki",
      "classification": "feature",
      "risk": "low"
    },
    {
      "file": "path/to/file",
      "lineStart": 38,
      "lineEnd": 95,
      "description": "Add applyDimToCodeNode helper function",
      "classification": "feature",
      "risk": "medium"
    }
  ]
}

Classification guide:
- breaking: API changes, removing features, incompatible changes
- feature: New functionality, new files with substantial logic
- refactor: Code reorganization without behavior change
- fix: Bug fixes, corrections
- test: Test file changes only
- docs: Documentation, comments, README
- style: Formatting, whitespace, linting

Risk levels:
- high: Breaking changes, core logic modifications
- medium: New features, significant refactors
- low: Tests, docs, style, minor fixes

For each hunk:
- file: the file path from the diff header
- lineStart: starting line number in the NEW file (after changes)
- lineEnd: ending line number in the NEW file (after changes)
- description: what this specific segment does (be specific: "Add X function", "Fix Y bug", not "changes to file")
- classification: type of change
- risk: risk level

Remember: The array order IS the reading order. Make it tell a clear, logical story.

Analyze the diff and return the JSON now.`;

    const command = model === "codex"
      ? `echo ${JSON.stringify(prompt)} | codex exec -C "${tempDir}" --skip-git-repo-check`
      : `echo ${JSON.stringify(prompt)} | claude -p --add-dir "${tempDir}"`;

    const { stdout } = await execAsync(command, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });

    let jsonContent = stdout.trim();

    if (jsonContent.startsWith("```")) {
      const match = jsonContent.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
      if (match) {
        jsonContent = match[1] || "";
      }
    }

    const result = JSON.parse(jsonContent);

    fs.unlinkSync(diffPath);

    return {
      hunks: result.hunks || [],
      timestamp,
      version: ANALYSIS_VERSION,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    return {
      hunks: [],
      timestamp: Date.now(),
      version: ANALYSIS_VERSION,
    };
  }
}

export function semanticSort(
  hunks: HunkAnalysis[]
): HunkAnalysis[] {
  return hunks.slice().sort((a, b) => {
    const aPriority = CLASSIFICATION_PRIORITY[a.classification];
    const bPriority = CLASSIFICATION_PRIORITY[b.classification];

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    const aSize = a.lineEnd - a.lineStart;
    const bSize = b.lineEnd - b.lineStart;
    return bSize - aSize;
  });
}

export function getClassificationTag(classification: ClassificationType): { label: string; color: string } {
  const tags: Record<ClassificationType, { label: string; color: string }> = {
    breaking: { label: "BREAKING", color: "#ff0000" },
    feature: { label: "FEATURE", color: "#00ff00" },
    refactor: { label: "REFACTOR", color: "#0099ff" },
    fix: { label: "FIX", color: "#ffaa00" },
    test: { label: "TEST", color: "#9999ff" },
    docs: { label: "DOCS", color: "#666666" },
    style: { label: "STYLE", color: "#999999" },
    unknown: { label: "UNKNOWN", color: "#666666" },
  };
  return tags[classification];
}

export function countBreaking(analysis: AnalysisResult): number {
  return analysis.hunks.filter(h => h.classification === "breaking").length;
}
