import { RGBA, TextAttributes, type MouseEvent } from "@opentui/core";
import { execSync } from "child_process";
import { diffWords } from "diff";

import {
  Component,
  useState,
  useEffect,
  isValidElement,
  cloneElement,
  Children,
  type ReactNode,
  type ErrorInfo,
} from "react";

import { type StructuredPatchHunk as Hunk } from "diff";
import {
    createHighlighter,
    type BundledLanguage,
    type GrammarState,
    type ThemedToken
} from "shiki";

const UNCHANGED_CODE_BG = RGBA.fromInts(15, 15, 15, 255);
const ADDED_BG_LIGHT = RGBA.fromInts(100, 250, 120, 12);
const REMOVED_BG_LIGHT = RGBA.fromInts(255, 0, 0, 32);
const DIMMED_CODE_BG = RGBA.fromInts(0, 0, 0, 0);

const LINE_NUMBER_BG = RGBA.fromInts(5, 5, 5, 255);
const REMOVED_LINE_NUMBER_BG = RGBA.fromInts(60, 0, 0, 255);
const ADDED_LINE_NUMBER_BG = RGBA.fromInts(0, 50, 0, 255);
const LINE_NUMBER_FG_BRIGHT = RGBA.fromInts(255, 255, 255, 255);
const LINE_NUMBER_FG_DIM = RGBA.fromInts(255, 255, 255, 128);
const DIMMED_LINE_NUMBER_BG = RGBA.fromInts(10, 10, 10, 255);
const DIMMED_CODE_FG = RGBA.fromInts(110, 110, 110, 200);

type TextAttributeProp = typeof TextAttributes | Array<typeof TextAttributes> | undefined;

function applyDimToCodeNode(
  node: ReactNode,
  shouldDim: boolean,
): ReactNode {
  if (!shouldDim || !isValidElement(node)) {
    return node;
  }

  const processedChildren = Children.map(node.props.children, (child) =>
    applyDimToCodeNode(child, shouldDim)
  );

  return cloneElement(node, {
    attributes: TextAttributes.DIM,
    fg: DIMMED_CODE_FG,
    bg: undefined,
    children: processedChildren,
  });
}

function openInEditor(filePath: string, lineNumber: number) {
  const editor = process.env?.REACT_EDITOR ?? "zed";

  execSync(`${editor} "${filePath}:${lineNumber}"`, { stdio: "ignore" });
}

const theme = "github-dark-default";
const highlighterStart = performance.now();
const highlighter = await createHighlighter({
  themes: [theme],
  langs: [
    "javascript",
    "typescript",
    "tsx",
    "jsx",
    "json",
    "markdown",
    "html",
    "css",
    "python",
    "rust",
    "go",
    "java",
    "c",
    "cpp",
    "yaml",
    "toml",
    "bash",
    "sh",
    "sql",
  ],
});
const highlighterDuration = performance.now() - highlighterStart;

function detectLanguage(filePath: string): BundledLanguage {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hxx":
      return "cpp";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "sh":
      return "sh";
    case "bash":
      return "bash";
    case "sql":
      return "sql";
    default:
      return "javascript";
  }
}

function renderHighlightedTokens(tokens: ThemedToken[]) {
  return tokens.map((token, tokenIdx) => {
    const color = token.color;
    const fg = color ? RGBA.fromHex(color) : undefined;

    return (
      <span key={tokenIdx} fg={fg}>
        {token.content}
      </span>
    );
  });
}

// Custom error boundary class
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };

    // Bind methods
    this.componentDidCatch = this.componentDidCatch.bind(this);
  }

  static getDerivedStateFromError(error: Error): {
    hasError: boolean;
    error: Error;
  } {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Error caught by boundary:", error);
    console.error("Component stack:", errorInfo.componentStack);

    // Copy stack trace to clipboard
    const stackTrace = `${error.message}\n\nStack trace:\n${error.stack}\n\nComponent stack:\n${errorInfo.componentStack}`;
    const { execSync } = require("child_process");
    try {
      execSync("pbcopy", { input: stackTrace });
    } catch (copyError) {
      console.error("Failed to copy to clipboard:", copyError);
    }
  }

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      return (
        <box style={{ flexDirection: "column", padding: 2 }}>
          <text fg="red">
            <strong>Error occurred:</strong>
          </text>
          <text>{this.state.error.message}</text>
          <text fg="brightBlack">Stack trace (copied to clipboard):</text>
          <text fg="white">{this.state.error.stack}</text>
        </box>
      );
    }

    return this.props.children;
  }
}

export const FileEditPreviewTitle = ({
  filePath,
  hunks,
}: {
  filePath: string;
  hunks: Hunk[];
}) => {
  const numAdditions = hunks.reduce(
    (count, hunk) => count + hunk.lines.filter((_) => _.startsWith("+")).length,
    0,
  );
  const numRemovals = hunks.reduce(
    (count, hunk) => count + hunk.lines.filter((_) => _.startsWith("-")).length,
    0,
  );

  const isNewFile = numAdditions > 0 && numRemovals === 0;
  const isDeleted = numRemovals > 0 && numAdditions === 0;

  return (
    <text>
      {isNewFile ? "Created" : isDeleted ? "Deleted" : "Updated"} <strong>{filePath}</strong>
      {numAdditions > 0 || numRemovals > 0 ? " with " : ""}
      {numAdditions > 0 ? (
        <>
          <strong>{numAdditions}</strong>{" "}
          {numAdditions > 1 ? "additions" : "addition"}
        </>
      ) : null}
      {numAdditions > 0 && numRemovals > 0 ? " and " : null}
      {numRemovals > 0 ? (
        <>
          <strong>{numRemovals}</strong>{" "}
          {numRemovals > 1 ? "removals" : "removal"}
        </>
      ) : null}
    </text>
  );
};

export const FileEditPreview = ({
  hunks,
  paddingLeft = 0,
  splitView = true,
  filePath = "",
}: {
  hunks: Hunk[];
  paddingLeft?: number;
  splitView?: boolean;
  filePath?: string;
}) => {
  useEffect(() => {
    console.log(
      `Highlighter initialized in ${highlighterDuration.toFixed(2)}ms`,
    );
  }, []);

  const allLines = hunks.flatMap((h) => h.lines);
  let oldLineNum = hunks[0]?.oldStart || 1;
  let newLineNum = hunks[0]?.newStart || 1;

  const maxOldLine = allLines.reduce((max, line) => {
    if (line.startsWith("-")) {
      return Math.max(max, oldLineNum++);
    } else if (line.startsWith("+")) {
      newLineNum++;
      return max;
    } else {
      oldLineNum++;
      newLineNum++;
      return Math.max(max, oldLineNum - 1);
    }
  }, 0);

  oldLineNum = hunks[0]?.oldStart || 1;
  newLineNum = hunks[0]?.newStart || 1;
  const maxNewLine = allLines.reduce((max, line) => {
    if (line.startsWith("-")) {
      oldLineNum++;
      return max;
    } else if (line.startsWith("+")) {
      return Math.max(max, newLineNum++);
    } else {
      oldLineNum++;
      newLineNum++;
      return Math.max(max, newLineNum - 1);
    }
  }, 0);

  const leftMaxWidth = maxOldLine.toString().length;
  const rightMaxWidth = maxNewLine.toString().length;

  return (
    <box style={{ flexDirection: "column" }}>
      {hunks.flatMap((patch, i) => {
        const elements = [
          <box
            style={{ flexDirection: "column", paddingLeft }}
            key={patch.newStart}
          >
            <StructuredDiff
              patch={patch}
              splitView={splitView}
              leftMaxWidth={leftMaxWidth}
              rightMaxWidth={rightMaxWidth}
              filePath={filePath}
            />
          </box>,
        ];
        if (i < hunks.length - 1) {
          elements.push(
            <box style={{ paddingLeft }} key={`ellipsis-${i}`}>
              <text fg="brightBlack">{" ".repeat(leftMaxWidth + 2)}…</text>
            </box>,
          );
        }
        return elements;
      })}
    </box>
  );
};

function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }

  return matrix[len1]![len2]!;
}

const StructuredDiff = ({
  patch,
  splitView = true,
  leftMaxWidth = 0,
  rightMaxWidth = 0,
  filePath = "",
}: {
  patch: Hunk;
  splitView?: boolean;
  leftMaxWidth?: number;
  rightMaxWidth?: number;
  filePath?: string;
}) => {
  const [hoveredSnippetId, setHoveredSnippetId] = useState<string | null>(null);
  const getLineNumberBackground = (lineType: string, dimmed: boolean) => {
    if (dimmed) return DIMMED_LINE_NUMBER_BG;
    if (lineType === "add") return ADDED_LINE_NUMBER_BG;
    if (lineType === "remove") return REMOVED_LINE_NUMBER_BG;
    return LINE_NUMBER_BG;
  };
  const getCodeBackground = (lineType: string, dimmed: boolean) => {
    if (dimmed) return DIMMED_CODE_BG;
    if (lineType === "add") return ADDED_BG_LIGHT;
    if (lineType === "remove") return REMOVED_BG_LIGHT;
    return UNCHANGED_CODE_BG;
  };
  const getLineNumberForeground = (lineType: string, dimmed: boolean) => {
    if (dimmed) return LINE_NUMBER_FG_DIM;
    if (lineType === "add" || lineType === "remove") {
      return LINE_NUMBER_FG_BRIGHT;
    }
    return LINE_NUMBER_FG_DIM;
  };
  const formatDiff = (
    lines: string[],
    startingLineNumber: number,
    isSplitView: boolean,
  ) => {
    const processedLines = lines.map((code) => {
      if (code.startsWith("+")) {
        return { code: code.slice(1), type: "add", originalCode: code };
      }
      if (code.startsWith("-")) {
        return {
          code: code.slice(1),
          type: "remove",
          originalCode: code,
        };
      }
      return { code: code.slice(1), type: "nochange", originalCode: code };
    });

    const lang = detectLanguage(filePath);

    let beforeState: GrammarState | undefined;
    const beforeTokens: (ThemedToken[] | null)[] = [];

    for (let idx = 0; idx < processedLines.length; idx++) {
      const line = processedLines[idx];
      if (!line) continue;

      if (line.type === "remove" || line.type === "nochange") {
        const result = highlighter.codeToTokens(line.code, {
          lang,
          theme,
          grammarState: beforeState,
        });
        const tokens = result.tokens[0] || null;

        beforeTokens.push(tokens);
        beforeState = highlighter.getLastGrammarState(result.tokens);
      } else {
        beforeTokens.push(null);
      }
    }

    let afterState: GrammarState | undefined;
    const afterTokens: (ThemedToken[] | null)[] = [];

    for (const line of processedLines) {
      if (line.type === "add" || line.type === "nochange") {
        const result = highlighter.codeToTokens(line.code, {
          lang,
          theme,
          grammarState: afterState,
        });
        const tokens = result.tokens[0] || null;
        afterTokens.push(tokens);
        afterState = highlighter.getLastGrammarState(result.tokens);
      } else {
        afterTokens.push(null);
      }
    }

    // Check if hunk is fully additions or fully deletions
    const hasRemovals = processedLines.some((line) => line.type === "remove");
    const hasAdditions = processedLines.some((line) => line.type === "add");
    const shouldShowWordDiff = hasRemovals && hasAdditions;

    // Find pairs of removed/added lines for word-level diff (only if hunk has both)
    const linePairs: Array<{ remove?: number; add?: number }> = [];
    if (shouldShowWordDiff) {
      let i = 0;
      while (i < processedLines.length) {
        if (processedLines[i]?.type === "remove") {
          // Collect all consecutive removes
          const removes: number[] = [];
          let j = i;
          while (
            j < processedLines.length &&
            processedLines[j]?.type === "remove"
          ) {
            removes.push(j);
            j++;
          }

          // Collect all consecutive adds that follow
          const adds: number[] = [];
          while (
            j < processedLines.length &&
            processedLines[j]?.type === "add"
          ) {
            adds.push(j);
            j++;
          }

          // Pair them up
          const minLength = Math.min(removes.length, adds.length);
          for (let k = 0; k < minLength; k++) {
            linePairs.push({ remove: removes[k], add: adds[k] });
          }

          i = j;
        } else {
          i++;
        }
      }
    }

    let oldLineNumber = startingLineNumber;
    let newLineNumber = startingLineNumber;
    const result: Array<{
      code: ReactNode;
      type: string;
      oldLineNumber: number;
      newLineNumber: number;
      pairedWith?: number;
      snippetId: string | null;
    }> = [];
    let snippetCounter = 0;
    let activeSnippetId: string | null = null;
    const getSnippetId = (lineType: string): string | null => {
      if (lineType === "add" || lineType === "remove") {
        if (!activeSnippetId) {
          snippetCounter++;
          activeSnippetId = `snippet-${snippetCounter}`;
        }
        return activeSnippetId;
      }
      activeSnippetId = null;
      return null;
    };

    for (let i = 0; i < processedLines.length; i++) {
      const processedLine = processedLines[i];
      if (!processedLine) continue;

      const { code, type, originalCode } = processedLine;
      const snippetId = getSnippetId(type);

      // Check if this line is part of a word-diff pair
      const pair = linePairs.find((p) => p.remove === i || p.add === i);

      if (pair && pair.remove === i && pair.add !== undefined) {
        // This is a removed line with a corresponding added line
        const removedText = processedLines[i]?.code;
        const addedLine = processedLines[pair.add];
        if (!removedText || !addedLine) continue;

        const addedText = addedLine.code;

        const similarity = calculateSimilarity(removedText, addedText);
        const shouldSkipWordDiff = similarity < 0.5;

        if (shouldSkipWordDiff) {
          const tokens = beforeTokens[i];
          const removedContent = tokens ? (
            <text>{renderHighlightedTokens(tokens)}</text>
          ) : (
            <text>{removedText}</text>
          );
          result.push({
            code: removedContent,
            type,
            oldLineNumber,
            newLineNumber,
            pairedWith: pair.add,
            snippetId,
          });
          oldLineNumber++;
          continue;
        }

        const wordDiff = diffWords(removedText, addedText);

        const removedContent = (
          <text>
            {wordDiff.map((part, idx) => {
              if (part.removed) {
                return (
                  <span key={idx} bg={RGBA.fromInts(255, 50, 50, 100)}>
                    {part.value}
                  </span>
                );
              }
              if (!part.added) {
                return <span key={idx}>{part.value}</span>;
              }
              return null;
            })}
          </text>
        );

        result.push({
          code: removedContent,
          type,
          oldLineNumber,
          newLineNumber,
          pairedWith: pair.add,
          snippetId,
        });
        oldLineNumber++;
      } else if (pair && pair.add === i && pair.remove !== undefined) {
        // This is an added line with a corresponding removed line
        const removedLine = processedLines[pair.remove];
        const addedLine = processedLines[i];
        if (!removedLine || !addedLine) continue;

        const removedText = removedLine.code;
        const addedText = addedLine.code;

        const similarity = calculateSimilarity(removedText, addedText);
        const shouldSkipWordDiff = similarity < 0.5;

        if (shouldSkipWordDiff) {
          const tokens = afterTokens[i];
          const addedContent = tokens ? (
            <text>{renderHighlightedTokens(tokens)}</text>
          ) : (
            <text>{addedText}</text>
          );
          result.push({
            code: addedContent,
            type,
            oldLineNumber,
            newLineNumber,
            pairedWith: pair.remove,
            snippetId,
          });
          newLineNumber++;
          continue;
        }

        const wordDiff = diffWords(removedText, addedText);

        const addedContent = (
          <text>
            {wordDiff.map((part, idx) => {
              if (part.added) {
                return (
                  <span key={idx} bg={RGBA.fromInts(0, 200, 0, 100)}>
                    {part.value}
                  </span>
                );
              }
              if (!part.removed) {
                return <span key={idx}>{part.value}</span>;
              }
              return null;
            })}
          </text>
        );

        result.push({
          code: addedContent,
          type,
          oldLineNumber,
          newLineNumber,
          pairedWith: pair.remove,
          snippetId,
        });
        newLineNumber++;
      } else {
        const tokens =
          type === "remove"
            ? beforeTokens[i]
            : type === "add"
              ? afterTokens[i]
              : beforeTokens[i] || afterTokens[i];

        const content =
          tokens && tokens.length > 0 ? (
            <text>{renderHighlightedTokens(tokens)}</text>
          ) : (
            <text>{code}</text>
          );

        result.push({
          code: content,
          type,
          oldLineNumber,
          newLineNumber,
          snippetId,
        });
      }

      if (type === "remove") {
        oldLineNumber++;
      } else if (type === "add") {
        newLineNumber++;
      } else {
        oldLineNumber++;
        newLineNumber++;
      }
    }

    return result.map(
      (
        { type, code, oldLineNumber, newLineNumber, pairedWith, snippetId },
        index,
      ) => {
        return {
          oldLineNumber: oldLineNumber.toString(),
          newLineNumber: newLineNumber.toString(),
          code,
          type,
          pairedWith,
          snippetId,
          key: `line-${index}`,
        };
      },
    );
  };

  const diff = formatDiff(patch.lines, patch.oldStart, splitView);

  const maxWidth = Math.max(leftMaxWidth, rightMaxWidth);

  if (!splitView) {
    const paddedDiff = diff.map((item) => ({
      ...item,
      lineNumber:
        item.newLineNumber && item.newLineNumber !== "0"
          ? item.newLineNumber.padStart(maxWidth)
          : " ".repeat(maxWidth),
    }));
    return (
      <>
        {paddedDiff.map(
          ({ lineNumber, code, type, key, newLineNumber, snippetId }) => {
            const isDiffLine = type === "add" || type === "remove";
            const shouldDim =
              hoveredSnippetId !== null &&
              (snippetId == null || hoveredSnippetId !== snippetId);
            const lineNumberBackground = getLineNumberBackground(
              type,
              shouldDim,
            );
            const codeBackground = getCodeBackground(type, shouldDim);
            const lineNumberForeground = getLineNumberForeground(
              type,
              shouldDim,
            );

            const renderedCode = applyDimToCodeNode(code, shouldDim);

            return (
              <box
                key={key}
                style={{ flexDirection: "row" }}
                onMouse={(event: MouseEvent) => {
                  if (event.type === "over" && snippetId) {
                    setHoveredSnippetId(snippetId);
                  } else if (event.type === "out") {
                    setHoveredSnippetId(null);
                  }
                }}
              >
                <box
                  style={{
                    flexShrink: 0,
                    alignSelf: "stretch",
                    backgroundColor: lineNumberBackground,
                  }}
                  onMouse={(event: MouseEvent) => {
                    if (event.type === "down") {
                      openInEditor(filePath, parseInt(newLineNumber));
                    }
                  }}
                  >
                    <text
                      selectable={false}
                      fg={lineNumberForeground}
                      style={{ width: maxWidth + 2 }}
                    >
                      {" "}
                      {lineNumber}{" "}
                    </text>
                </box>
                <box
                  style={{
                    flexGrow: 1,
                    paddingLeft: 1,
                    backgroundColor: codeBackground,
                  }}
                >
                  {renderedCode}
                </box>
              </box>
            );
          },
        )}
      </>
    );
  }

  // Split view: separate left (removals) and right (additions)
  // Build rows by pairing deletions with additions
  interface SplitLineSide {
    lineNumber: string;
    code: ReactNode;
    type: string;
    key?: string;
    snippetId: string | null;
    oldLineNumber?: number;
    newLineNumber?: number;
  }

  const splitLines: Array<{
    left: SplitLineSide;
    right: SplitLineSide;
  }> = [];
  const processedIndices = new Set<number>();

  for (let i = 0; i < diff.length; i++) {
    if (processedIndices.has(i)) continue;

    const line = diff[i];
    if (!line) continue;

    if (line.type === "remove" && line.pairedWith !== undefined) {
      // This removal is paired with an addition
      const pairedLine = diff[line.pairedWith];
      if (pairedLine) {
        splitLines.push({
          left: {
            ...line,
            lineNumber: line.oldLineNumber.padStart(leftMaxWidth),
          },
          right: {
            ...pairedLine,
            lineNumber: pairedLine.newLineNumber.padStart(rightMaxWidth),
          },
        });
        processedIndices.add(i);
        processedIndices.add(line.pairedWith);
      }
    } else if (line.type === "add" && line.pairedWith !== undefined) {
      // This addition is paired with a removal (already processed above)
      continue;
    } else if (line.type === "remove") {
      // Unpaired removal
      splitLines.push({
        left: {
          ...line,
          lineNumber: line.oldLineNumber.padStart(leftMaxWidth),
        },
        right: {
          lineNumber: " ".repeat(rightMaxWidth),
          code: <text></text>,
          type: "empty",
          key: `${line.key}-empty-right`,
          snippetId: null,
        },
      });
      processedIndices.add(i);
    } else if (line.type === "add") {
      // Unpaired addition
      splitLines.push({
        left: {
          lineNumber: " ".repeat(leftMaxWidth),
          code: <text></text>,
          type: "empty",
          key: `${line.key}-empty-left`,
          snippetId: null,
        },
        right: {
          ...line,
          lineNumber: line.newLineNumber.padStart(rightMaxWidth),
        },
      });
      processedIndices.add(i);
    } else {
      // Unchanged line
      splitLines.push({
        left: {
          ...line,
          lineNumber: line.oldLineNumber.padStart(leftMaxWidth),
        },
        right: {
          ...line,
          lineNumber: line.newLineNumber.padStart(rightMaxWidth),
        },
      });
      processedIndices.add(i);
    }
  }

  return (
    <>
      {splitLines.map(({ left: leftLine, right: rightLine }) => {
        const rowSnippetId = leftLine.snippetId || rightLine.snippetId || null;
        const leftShouldDim =
          hoveredSnippetId !== null &&
          (leftLine.snippetId == null ||
            hoveredSnippetId !== leftLine.snippetId);
        const rightShouldDim =
          hoveredSnippetId !== null &&
          (rightLine.snippetId == null ||
            hoveredSnippetId !== rightLine.snippetId);
        const leftLineNumberBackground = getLineNumberBackground(
          leftLine.type,
          leftShouldDim,
        );
        const rightLineNumberBackground = getLineNumberBackground(
          rightLine.type,
          rightShouldDim,
        );
        const leftCodeBackground =
          leftLine.type === "empty"
            ? undefined
            : getCodeBackground(leftLine.type, leftShouldDim);
        const rightCodeBackground =
          rightLine.type === "empty"
            ? undefined
            : getCodeBackground(rightLine.type, rightShouldDim);
        const leftLineNumberForeground = getLineNumberForeground(
          leftLine.type,
          leftShouldDim,
        );
        const rightLineNumberForeground = getLineNumberForeground(
          rightLine.type,
          rightShouldDim,
        );

        return (
          <box
            key={leftLine.key}
            style={{ flexDirection: "row" }}
            onMouse={(event: MouseEvent) => {
              if (event.type === "over" && rowSnippetId) {
                setHoveredSnippetId(rowSnippetId);
              } else if (event.type === "out") {
                setHoveredSnippetId(null);
              }
            }}
          >
            {/* Left side (removals) */}
            <box style={{ flexDirection: "row", width: "50%" }}>
            <box
              style={{
                flexShrink: 0,
                minWidth: leftMaxWidth + 2,
                alignSelf: "stretch",
                backgroundColor: leftLineNumberBackground,
              }}
              onMouse={(event: MouseEvent) => {
                if (
                  event.type === "down" &&
                  leftLine.oldLineNumber &&
                  leftLine.oldLineNumber !== "0"
                ) {
                  openInEditor(filePath, parseInt(leftLine.oldLineNumber));
                }
              }}
            >
              <text
                selectable={false}
                fg={leftLineNumberForeground}
              >
                {" "}
                {leftLine.lineNumber}{" "}
              </text>
            </box>
            <box
              style={{
                flexGrow: 1,
                paddingLeft: 1,
                minWidth: 0,
                backgroundColor: leftCodeBackground,
              }}
            >
              {applyDimToCodeNode(leftLine.code, leftShouldDim)}
            </box>
          </box>
          {/* Right side (additions) */}
          <box style={{ flexDirection: "row", width: "50%" }}>
            <box
              style={{
                flexShrink: 0,
                minWidth: leftMaxWidth + 2,
                alignSelf: "stretch",
                backgroundColor: rightLineNumberBackground,
              }}
              onMouse={(event: MouseEvent) => {
                if (event.type === "down") {
                  openInEditor(filePath, parseInt(rightLine.newLineNumber));
                }
              }}
            >
              <text
                selectable={false}
                fg={rightLineNumberForeground}
              >
                {" "}
                {rightLine.lineNumber}{" "}
              </text>
            </box>
            <box
              style={{
                flexGrow: 1,
                minWidth: 0,
                paddingLeft: 1,
                backgroundColor: rightCodeBackground,
              }}
            >
              {applyDimToCodeNode(rightLine.code, rightShouldDim)}
            </box>
          </box>
        </box>
        );
      })}
    </>
  );
};

export { ErrorBoundary };
