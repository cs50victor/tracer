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

export interface FileAnalysis {
  file: string;
  classification: ClassificationType;
  risk: RiskLevel;
  summary: string;
}

export interface AnalysisResult {
  files: FileAnalysis[];
  timestamp: number;
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

export async function analyzeDiff(diffContent: string, model: string = "claude"): Promise<AnalysisResult> {
  try {
    const timestamp = Date.now();
    const diffPath = join(tmpdir(), `tracer-${timestamp}.diff`);

    fs.writeFileSync(diffPath, diffContent);

    const prompt = `You are analyzing a git diff. Read the diff from ${diffPath} and classify each changed file.

Return ONLY valid JSON in this exact format (no markdown, no code blocks, no explanation):
{
  "files": [
    {
      "file": "path/to/file",
      "classification": "breaking|feature|refactor|fix|test|docs|style",
      "risk": "high|medium|low",
      "summary": "brief description"
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

Analyze the diff and return the JSON now.`;

    const command = model === "codex"
      ? `echo ${JSON.stringify(prompt)} | codex exec`
      : `echo ${JSON.stringify(prompt)} | claude -p`;

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
      files: result.files || [],
      timestamp,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    return {
      files: [],
      timestamp: Date.now(),
    };
  }
}

export function semanticSort(
  files: Array<{ oldFileName?: string; newFileName?: string; hunks: any[] }>,
  analysis: AnalysisResult
): Array<{ oldFileName?: string; newFileName?: string; hunks: any[] }> {
  const getFileName = (file: { oldFileName?: string; newFileName?: string }): string => {
    const newName = file.newFileName;
    const oldName = file.oldFileName;
    if (newName && newName !== "/dev/null") return newName;
    if (oldName && oldName !== "/dev/null") return oldName;
    return "";
  };

  const analysisMap = new Map<string, FileAnalysis>();
  for (const fileAnalysis of analysis.files) {
    analysisMap.set(fileAnalysis.file, fileAnalysis);
  }

  return files.slice().sort((a, b) => {
    const aName = getFileName(a);
    const bName = getFileName(b);

    const aAnalysis = analysisMap.get(aName);
    const bAnalysis = analysisMap.get(bName);

    const aPriority = aAnalysis
      ? CLASSIFICATION_PRIORITY[aAnalysis.classification]
      : CLASSIFICATION_PRIORITY.unknown;
    const bPriority = bAnalysis
      ? CLASSIFICATION_PRIORITY[bAnalysis.classification]
      : CLASSIFICATION_PRIORITY.unknown;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    const aSize = a.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    const bSize = b.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    return aSize - bSize;
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
  return analysis.files.filter(f => f.classification === "breaking").length;
}
