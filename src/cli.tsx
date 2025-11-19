#!/usr/bin/env bun
import { cac } from "cac";
import { FileEditPreviewTitle, FileEditPreview } from "./diff.tsx";
import {
  createRoot,
  useKeyboard,
  useOnResize,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  createElement,
  type ReactNode,
} from "react";
import crypto from "crypto";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { createCliRenderer, MacOSScrollAccel } from "@opentui/core";
import fs from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { TextAttributes } from "@opentui/core";
import {
  analyzeDiff,
  semanticSort,
  getClassificationTag,
  countBreaking,
  type AnalysisResult,
} from "./intelligent.tsx";
import "opentui-spinner/react";
import spinners from "cli-spinners";
import type { StructuredPatchHunk } from "diff";
import type { ExecSyncOptions } from "child_process";

const execAsync = promisify(exec);

const IGNORED_FILES = [
  // JavaScript/Node.js
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "deno.lock",
  // Python
  "Pipfile.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  // Other languages
  "Cargo.lock",          // Rust
  "Gemfile.lock",        // Ruby
  "composer.lock",       // PHP
  "go.sum",              // Go
  "Package.resolved",    // Swift
  "Podfile.lock",        // iOS CocoaPods
  "Cartfile.resolved",   // iOS Carthage
  "pubspec.lock",        // Dart/Flutter
  "packages.lock.json",  // .NET
  "mix.lock",            // Elixir
  ".terraform.lock.hcl", // Terraform
  "gradle.lockfile",     // Java/Gradle
  "Manifest.toml",       // Julia
  "renv.lock",           // R
  "shard.lock",          // Crystal
  "flake.lock",          // Nix
  "conan.lock",          // C++ Conan
  "vcpkg-lock.json",     // C++ vcpkg
];

enum Mode {
  FILE_NAVIGATION = 0,
  HUNK_NAVIGATION = 1,
  HUNK_ONLY = 2,
  INTELLIGENT = 3,
}

const MODE_CONFIG = {
  [Mode.FILE_NAVIGATION]: {
    enableHover: false,
    showSingleHunk: false,
  },
  [Mode.HUNK_NAVIGATION]: {
    enableHover: true,
    showSingleHunk: true,
  },
  [Mode.HUNK_ONLY]: {
    enableHover: true,
    showSingleHunk: true,
  },
  [Mode.INTELLIGENT]: {
    enableHover: true,
    showSingleHunk: true,
  },
} as const;

const BACKGROUND_COLOR = "#0f0f0f";
const DROPDOWN_BASE_TEXT_COLOR = "#FFFFFF";
const DROPDOWN_TEXT_MUTED_COLOR = "#999999";
const DROPDOWN_PRIMARY_TEXT_COLOR = "#FFA500"; // orange
const DROPDOWN_BACKGROUND_PANEL_COLOR = "#1E1E1E"; // dark gray panel background
const DROPDOWN_BACKGROUND_THEME_COLOR = "#000000";

function getFileName(file: { oldFileName?: string; newFileName?: string }): string | undefined {
  const newName = file.newFileName;
  const oldName = file.oldFileName;
  
  // Filter out /dev/null which appears for new/deleted files
  if (newName && newName !== "/dev/null") return newName;
  if (oldName && oldName !== "/dev/null") return oldName;
}

function execSyncWithError(
  command: string,
  options?: ExecSyncOptions,
): { data?: string | Buffer; error?: string } {
  try {
    const data = execSync(command, options);
    return { data };
  } catch (error: unknown) {
    const stderr = (error as { stderr?: Buffer; message?: string }).stderr?.toString() || (error as Error).message || String(error);
    return { error: stderr };
  }
}

const TRACER_CACHE_DIR = join(homedir(), ".tracer");
const TRACER_ANALYSIS_DIR = join(TRACER_CACHE_DIR, "analysis");
const TRACER_DIFFS_PATH = join(TRACER_CACHE_DIR, "diffs.json");
const TRACER_CONFIG_PATH = join(TRACER_CACHE_DIR, "config.json");

type DiffIndex = Record<string, Record<string, string>>;

function ensureDir(path: string) {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path, { recursive: true });
  }
}

const fileSystemStorage: StateStorage = {
  getItem: (name: string): string | null => {
    try {
      if (fs.existsSync(TRACER_CONFIG_PATH)) {
        return fs.readFileSync(TRACER_CONFIG_PATH, "utf-8");
      }
      return null;
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      ensureDir(TRACER_CACHE_DIR);
      fs.writeFileSync(TRACER_CONFIG_PATH, value, "utf-8");
    } catch (error) {
      console.error("Error writing config:", error);
    }
  },
  removeItem: (name: string): void => {
    try {
      if (fs.existsSync(TRACER_CONFIG_PATH)) {
        fs.unlinkSync(TRACER_CONFIG_PATH);
      }
    } catch (error) {
      console.error("Error removing config:", error);
    }
  },
};

function readDiffIndex(): DiffIndex {
  try {
    const raw = fs.readFileSync(TRACER_DIFFS_PATH, "utf-8");
    return JSON.parse(raw) as DiffIndex;
  } catch {
    return {};
  }
}

function writeDiffIndex(index: DiffIndex) {
  ensureDir(TRACER_CACHE_DIR);
  fs.writeFileSync(TRACER_DIFFS_PATH, JSON.stringify(index, null, 2), "utf-8");
}

function readAnalysisFile(diffSha: string): AnalysisResult | null {
  const filePath = join(TRACER_ANALYSIS_DIR, `${diffSha}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as AnalysisResult;
  } catch {
    return null;
  }
}

function getRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function resolveShortCommit(target: string): string | null {
  try {
    return execSync(`git rev-parse --short ${target}`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function getCommitKey(
  options: { commit?: string },
  ref?: string,
): string | null {
  if (options.commit) {
    const fromOption = resolveShortCommit(options.commit);
    if (fromOption) {
      return fromOption;
    }
  }

  if (ref) {
    const fromRef = resolveShortCommit(ref);
    if (fromRef) {
      return fromRef;
    }
  }

  return resolveShortCommit("HEAD");
}

function loadCachedAnalysis(
  repoDir: string,
  commitKey: string,
  diffSha: string,
): AnalysisResult | null {
  const index = readDiffIndex();
  if (index[repoDir]?.[commitKey] !== diffSha) {
    return null;
  }
  const cached = readAnalysisFile(diffSha);
  if (!cached || cached.version !== "v2") {
    return null;
  }
  return cached;
}

function saveAnalysisCache(
  repoDir: string,
  commitKey: string,
  diffSha: string,
  analysis: AnalysisResult,
) {
  const index = readDiffIndex();
  if (!index[repoDir]) {
    index[repoDir] = {};
  }
  index[repoDir]![commitKey] = diffSha;
  ensureDir(TRACER_ANALYSIS_DIR);
  const filePath = join(TRACER_ANALYSIS_DIR, `${diffSha}.json`);
  fs.writeFileSync(filePath, JSON.stringify(analysis), "utf-8");
  writeDiffIndex(index);
}

const cli = cac("tracer");

class ScrollAcceleration {
  public multiplier: number = 1;
  private macosAccel: MacOSScrollAccel;
  constructor() {
    this.macosAccel = new MacOSScrollAccel();
  }
  tick(delta: number) {
    return this.macosAccel.tick(delta) * this.multiplier;
  }
  reset() {
    this.macosAccel.reset();
    // this.multiplier = 1;
  }
}

interface DiffState {
  currentFileIndex: number;
  currentHunkIndex: number;
  mode: Mode;
  preferredModel: "claude" | "codex";
  intelligentAnalysis: AnalysisResult | null;
  isAnalyzing: boolean;
}

const useDiffStateStore = create<DiffState>()(
  persist(
    (set) => ({
      currentFileIndex: 0,
      currentHunkIndex: 0,
      mode: Mode.HUNK_ONLY,
      preferredModel: "claude",
      intelligentAnalysis: null,
      isAnalyzing: false,
    }),
    {
      name: "tracer-config",
      storage: createJSONStorage(() => fileSystemStorage),
      partialize: (state) => ({ mode: state.mode, preferredModel: state.preferredModel }),
    }
  )
);

interface ParsedFile {
  oldFileName?: string;
  newFileName?: string;
  hunks: StructuredPatchHunk[];
}

interface AppProps {
  parsedFiles: ParsedFile[];
}

export interface DropdownOption {
  title: string;
  value: string;
  icon?: ReactNode;
  keywords?: string[];
  label?: string;
}

export interface DropdownProps {
  id?: string;
  tooltip?: string;
  placeholder?: string;
  selectedValues?: string[];
  itemsPerPage?: number;
  options: DropdownOption[];
  onChange?: (newValue: string) => void;
  enableHover?: boolean;
}

const Dropdown = (props: DropdownProps) => {
  const {
    tooltip,
    onChange,
    selectedValues = [],
    options,
    placeholder = "Search…",
    itemsPerPage = 10,
    enableHover = true,
  } = props;

  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const inputRef = useRef(null);

  const inFocus = true;

  // Filter options based on search
  const filteredOptions = options.filter((option) => {
    if (!searchText.trim()) return true;
    const needles = searchText.toLowerCase().trim().split(/\s+/);
    const searchableText = [option.title, ...(option.keywords || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return needles.every((needle) => searchableText.includes(needle));
  });

  // Get visible options for current page
  const visibleOptions = filteredOptions.slice(offset, offset + itemsPerPage);

  // Reset selected index and offset when search changes
  useEffect(() => {
    setSelected(0);
    setOffset(0);
  }, [searchText]);

  const move = (direction: -1 | 1) => {
    const itemCount = filteredOptions.length;
    if (itemCount === 0) return;

    if (direction === 1) {
      setSelected((prev) => {
        const nextIndex = (prev + 1) % itemCount;

        const visibleEnd = offset + itemsPerPage - 1;
        if (prev === visibleEnd && nextIndex < itemCount && nextIndex > prev) {
          setOffset(offset + 1);
        } else if (nextIndex < prev) {
          setOffset(0);
        }

        return nextIndex;
      });
    } else {
      setSelected((prev) => {
        const nextIndex = (prev - 1 + itemCount) % itemCount;

        if (nextIndex < offset) {
          setOffset(Math.max(0, nextIndex));
        } else if (nextIndex >= offset + itemsPerPage) {
          setOffset(Math.max(0, itemCount - itemsPerPage));
        }

        return nextIndex;
      });
    }
  };

  const selectItem = (itemValue: string) => {
    if (onChange) {
      onChange(itemValue);
    }
  };

  // Handle keyboard navigation
  useKeyboard((evt) => {
    if (evt.name === "up") {
      move(-1);
    }
    if (evt.name === "down") {
      move(1);
    }
    if (evt.name === "return") {
      const currentOption = filteredOptions[selected];
      if (currentOption) {
        selectItem(currentOption.value);
      }
    }
  });

  return (
    <box>
      <box style={{ paddingLeft: 2, paddingRight: 2 }}>
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <box
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <text attributes={TextAttributes.BOLD}>{tooltip}</text>
            <text fg={DROPDOWN_TEXT_MUTED_COLOR}>esc</text>
          </box>
          <box style={{ paddingTop: 1, paddingBottom: 2 }}>
            <input
              ref={inputRef}
              onInput={(value) => setSearchText(value)}
              placeholder={placeholder}
              focused={inFocus}
              value={searchText}
              focusedBackgroundColor={DROPDOWN_BACKGROUND_PANEL_COLOR}
              cursorColor={DROPDOWN_PRIMARY_TEXT_COLOR}
              focusedTextColor={DROPDOWN_TEXT_MUTED_COLOR}
            />
          </box>
        </box>
        <box style={{ paddingBottom: 1 }}>
          {visibleOptions.map((option, idx) => {
            const globalIndex = offset + idx;
            const isActive = globalIndex === selected;
            const isCurrent = selectedValues.includes(option.value);

            return (
              <box key={option.value}>
                <ItemOption
                  title={option.title}
                  icon={option.icon}
                  active={isActive}
                  current={isCurrent}
                  label={option.label}
                  enableHover={enableHover}
                  onMouseMove={() => setSelected(globalIndex)}
                  onMouseDown={() => selectItem(option.value)}
                />
              </box>
            );
          })}
        </box>
      </box>
      <box
        border={false}
        style={{
          paddingRight: 2,
          paddingLeft: 3,
          paddingBottom: 1,
          paddingTop: 1,
          flexDirection: "row",
        }}
      >
        <text fg={DROPDOWN_BASE_TEXT_COLOR} attributes={TextAttributes.BOLD}>
          ↵
        </text>
        <text fg={DROPDOWN_TEXT_MUTED_COLOR}> select</text>
        <text fg={DROPDOWN_BASE_TEXT_COLOR} attributes={TextAttributes.BOLD}>
          {"   "}↑↓
        </text>
        <text fg={DROPDOWN_TEXT_MUTED_COLOR}> navigate</text>
      </box>
    </box>
  );
};

function ItemOption(props: {
  title: string;
  icon?: ReactNode;
  active?: boolean;
  current?: boolean;
  label?: string;
  onMouseDown?: () => void;
  onMouseMove?: () => void;
  enableHover?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <box
      style={{
        flexDirection: "row",
        backgroundColor: props.active
          ? DROPDOWN_PRIMARY_TEXT_COLOR
          : (props.enableHover && isHovered)
            ? DROPDOWN_BACKGROUND_PANEL_COLOR
            : undefined,
        paddingLeft: props.active ? 0 : 1,
        paddingRight: 1,
        justifyContent: "space-between",
      }}
      border={false}
      onMouseMove={() => {
        if (props.enableHover) {
          setIsHovered(true);
          if (props.onMouseMove) props.onMouseMove();
        }
      }}
      onMouseOut={() => {
        if (props.enableHover) {
          setIsHovered(false);
        }
      }}
      onMouseDown={props.onMouseDown}
    >
      <box style={{ flexDirection: "row" }}>
        {props.active && (
          <text fg={DROPDOWN_BACKGROUND_THEME_COLOR} selectable={false}>
            ›{""}
          </text>
        )}
        {props.icon && (
          <text
            fg={props.active ? DROPDOWN_BACKGROUND_THEME_COLOR : DROPDOWN_BASE_TEXT_COLOR}
            selectable={false}
          >
            {String(props.icon)}{" "}
          </text>
        )}
        <text
          fg={
            props.active
              ? DROPDOWN_BACKGROUND_THEME_COLOR
              : props.current
                ? DROPDOWN_PRIMARY_TEXT_COLOR
                : DROPDOWN_BASE_TEXT_COLOR
          }
          attributes={props.active ? TextAttributes.BOLD : undefined}
          selectable={false}
        >
          {props.title}
        </text>
      </box>
      {props.label && (
        <text
          fg={props.active ? DROPDOWN_BACKGROUND_THEME_COLOR : DROPDOWN_TEXT_MUTED_COLOR}
          attributes={props.active ? TextAttributes.BOLD : undefined}
          selectable={false}
        >
          {props.label}
        </text>
      )}
    </box>
  );
}

function getTotalHunks(files: ParsedFile[]): number {
  return files.reduce((sum, file) => sum + file.hunks.length, 0);
}

function linearToFileHunk(files: ParsedFile[], linearIndex: number): { fileIndex: number; hunkIndex: number } {
  let remaining = linearIndex;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const hunkCount = files[fileIndex]?.hunks.length || 0;
    if (remaining < hunkCount) {
      return { fileIndex, hunkIndex: remaining };
    }
    remaining -= hunkCount;
  }
  const lastFile = files[files.length - 1];
  return { fileIndex: files.length - 1, hunkIndex: lastFile ? lastFile.hunks.length - 1 : 0 };
}

function fileHunkToLinear(files: ParsedFile[], fileIndex: number, hunkIndex: number): number {
  let linear = 0;
  for (let i = 0; i < fileIndex; i++) {
    linear += files[i]?.hunks.length || 0;
  }
  return linear + hunkIndex;
}

function transformFilesWithIntelligentHunks(
  parsedFiles: ParsedFile[],
  analysis: AnalysisResult
): ParsedFile[] {
  const transformedFiles: ParsedFile[] = [];

  for (const file of parsedFiles) {
    const fileName = getFileName(file);
    if (!fileName) continue;

    const fileSegments = analysis.hunks
      .filter(h => h.file === fileName)
      .sort((a, b) => a.lineStart - b.lineStart);

    if (fileSegments.length === 0) {
      transformedFiles.push(file);
      continue;
    }

    const syntheticHunks = [];

    for (const segment of fileSegments) {
      for (const originalHunk of file.hunks) {
        const hunkStart = originalHunk.newStart;
        const hunkEnd = originalHunk.newStart + originalHunk.newLines - 1;

        if (segment.lineStart <= hunkEnd && segment.lineEnd >= hunkStart) {
          let currentNewLine = originalHunk.newStart;
          let currentOldLine = originalHunk.oldStart;
          const segmentLines = [];
          let segmentOldStart = -1;
          let capturing = false;

          for (const line of originalHunk.lines) {
            const lineType = line[0];
            let shouldCapture = false;

            if (lineType === '-') {
              shouldCapture = capturing;
              currentOldLine++;
            } else if (lineType === '+' || lineType === ' ') {
              if (currentNewLine >= segment.lineStart && currentNewLine <= segment.lineEnd) {
                shouldCapture = true;
                if (!capturing) {
                  capturing = true;
                  segmentOldStart = currentOldLine;
                }
              } else if (capturing && currentNewLine > segment.lineEnd) {
                break;
              }
              currentNewLine++;
              if (lineType === ' ') {
                currentOldLine++;
              }
            }

            if (shouldCapture) {
              segmentLines.push(line);
            }
          }

          if (segmentLines.length > 0) {
            let newLines = 0;
            let oldLines = 0;

            for (const line of segmentLines) {
              if (line[0] === '+') {
                newLines++;
              } else if (line[0] === '-') {
                oldLines++;
              } else {
                newLines++;
                oldLines++;
              }
            }

            syntheticHunks.push({
              ...originalHunk,
              oldStart: segmentOldStart,
              newStart: segment.lineStart,
              oldLines,
              newLines,
              lines: segmentLines,
            });
          }
          break;
        }
      }
    }

    transformedFiles.push({
      ...file,
      hunks: syntheticHunks.length > 0 ? syntheticHunks : file.hunks,
    });
  }

  return transformedFiles;
}

function App({ parsedFiles }: AppProps) {
  const { width: initialWidth } = useTerminalDimensions();
  const [width, setWidth] = useState(initialWidth);
  const [scrollAcceleration] = useState(() => new ScrollAcceleration());
  const currentFileIndex = useDiffStateStore((s) => s.currentFileIndex);
  const mode = useDiffStateStore((s) => s.mode);
  const intelligentAnalysis = useDiffStateStore((s) => s.intelligentAnalysis);
  const isAnalyzing = useDiffStateStore((s) => s.isAnalyzing);
  const [showDropdown, setShowDropdown] = useState(false);

  const displayFiles = mode === Mode.INTELLIGENT && intelligentAnalysis && !isAnalyzing
    ? transformFilesWithIntelligentHunks(parsedFiles, intelligentAnalysis)
    : parsedFiles;

  useOnResize(
    useCallback((newWidth: number) => {
      setWidth(newWidth);
    }, []),
  );
  const useSplitView = width >= 100;

  const renderer = useRenderer();

  useKeyboard((key) => {
    if (showDropdown) {
      if (key.name === "escape") {
        setShowDropdown(false);
      }
      return;
    }

    if (key.name === "p" && key.ctrl) {
      setShowDropdown(true);
      return;
    }

    if (key.name === "m") {
      useDiffStateStore.setState((state) => ({
        mode: (state.mode + 1) % 4,
      }));
      return;
    }

    if (key.name === "z" && key.ctrl) {
      renderer.console.toggle();
    }
    if (key.name === "escape" || key.name === "q") {
      process.exit(0);
    }
    if (key.option) {
      console.log(key);
      if (key.eventType === "release") {
        scrollAcceleration.multiplier = 1;
      } else {
        scrollAcceleration.multiplier = 10;
      }
    }

    if (mode === Mode.FILE_NAVIGATION) {
      if (key.name === "up") {
        useDiffStateStore.setState((state) => ({
          currentFileIndex: Math.max(0, state.currentFileIndex - 1),
          currentHunkIndex: 0,
        }));
      }
      if (key.name === "down") {
        useDiffStateStore.setState((state) => ({
          currentFileIndex: Math.min(displayFiles.length - 1, state.currentFileIndex + 1),
          currentHunkIndex: 0,
        }));
      }
    } else if (mode === Mode.HUNK_NAVIGATION) {
      if (key.name === "up") {
        const currentFile = displayFiles[currentFileIndex];
        if (currentFile) {
          useDiffStateStore.setState((state) => ({
            currentHunkIndex: Math.max(0, state.currentHunkIndex - 1),
          }));
        }
      }
      if (key.name === "down") {
        const currentFile = displayFiles[currentFileIndex];
        if (currentFile) {
          useDiffStateStore.setState((state) => ({
            currentHunkIndex: Math.min(currentFile.hunks.length - 1, state.currentHunkIndex + 1),
          }));
        }
      }
      if (key.name === "left") {
        useDiffStateStore.setState((state) => ({
          currentFileIndex: Math.max(0, state.currentFileIndex - 1),
          currentHunkIndex: 0,
        }));
      }
      if (key.name === "right") {
        useDiffStateStore.setState((state) => ({
          currentFileIndex: Math.min(displayFiles.length - 1, state.currentFileIndex + 1),
          currentHunkIndex: 0,
        }));
      }
    } else if (mode === Mode.HUNK_ONLY) {
      const totalHunks = getTotalHunks(displayFiles);
      if (key.name === "left") {
        useDiffStateStore.setState((state) => {
          const currentLinear = fileHunkToLinear(displayFiles, state.currentFileIndex, state.currentHunkIndex);
          const newLinear = Math.max(0, currentLinear - 1);
          const { fileIndex, hunkIndex } = linearToFileHunk(displayFiles, newLinear);
          return { currentFileIndex: fileIndex, currentHunkIndex: hunkIndex };
        });
      }
      if (key.name === "right") {
        useDiffStateStore.setState((state) => {
          const currentLinear = fileHunkToLinear(displayFiles, state.currentFileIndex, state.currentHunkIndex);
          const newLinear = Math.min(totalHunks - 1, currentLinear + 1);
          const { fileIndex, hunkIndex } = linearToFileHunk(displayFiles, newLinear);
          return { currentFileIndex: fileIndex, currentHunkIndex: hunkIndex };
        });
      }
    } else if (mode === Mode.INTELLIGENT) {
      const totalHunks = getTotalHunks(displayFiles);
      if (key.name === "left") {
        useDiffStateStore.setState((state) => {
          const currentLinear = fileHunkToLinear(displayFiles, state.currentFileIndex, state.currentHunkIndex);
          const newLinear = Math.max(0, currentLinear - 1);
          const { fileIndex, hunkIndex } = linearToFileHunk(displayFiles, newLinear);
          return { currentFileIndex: fileIndex, currentHunkIndex: hunkIndex };
        });
      }
      if (key.name === "right") {
        useDiffStateStore.setState((state) => {
          const currentLinear = fileHunkToLinear(displayFiles, state.currentFileIndex, state.currentHunkIndex);
          const newLinear = Math.min(totalHunks - 1, currentLinear + 1);
          const { fileIndex, hunkIndex } = linearToFileHunk(displayFiles, newLinear);
          return { currentFileIndex: fileIndex, currentHunkIndex: hunkIndex };
        });
      }
    }
  });

  const { FileEditPreview } = require("./diff.tsx");

  // Ensure current index is valid
  const validIndex = Math.min(currentFileIndex, displayFiles.length - 1);
  const currentFile = displayFiles[validIndex];
  const currentHunkIndex = useDiffStateStore((s) => s.currentHunkIndex);

  if (!currentFile) {
    return (
      <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR, height: "100%", justifyContent: "center", alignItems: "center" }}>
        <text>No files to display</text>
      </box>
    );
  }

  const fileName = getFileName(currentFile) || "";
  const validHunkIndex = Math.min(currentHunkIndex, currentFile.hunks.length - 1);
  const currentHunk = currentFile.hunks[validHunkIndex];

  let additions = 0;
  let deletions = 0;
  if (MODE_CONFIG[mode].showSingleHunk) {
    if (currentHunk) {
      currentHunk.lines.forEach((line: string) => {
        if (line.startsWith("+")) additions++;
        if (line.startsWith("-")) deletions++;
      });
    }
  } else {
    currentFile.hunks.forEach((hunk: StructuredPatchHunk) => {
      hunk.lines.forEach((line: string) => {
        if (line.startsWith("+")) additions++;
        if (line.startsWith("-")) deletions++;
      });
    });
  }

  const dropdownOptions = displayFiles.map((file, idx) => {
    const name = getFileName(file) || "";
    return {
      title: name,
      value: String(idx),
      keywords: name.split("/"),
    };
  });

  const handleFileSelect = (value: string) => {
    const index = parseInt(value, 10);
    useDiffStateStore.setState({ currentFileIndex: index, currentHunkIndex: 0 });
    setShowDropdown(false);
  };

  if (showDropdown) {
    return (
      <box
        style={{ flexDirection: "column", height: "100%", padding: 1, backgroundColor: BACKGROUND_COLOR }}
      >
        <box style={{ flexDirection: "column", justifyContent: "center", flexGrow: 1 }}>
          <Dropdown
            tooltip="Select file"
            options={dropdownOptions}
            selectedValues={[String(validIndex)]}
            onChange={handleFileSelect}
            placeholder="Search files..."
            enableHover={MODE_CONFIG[mode].enableHover}
          />
        </box>
      </box>
    );
  }

  return (
    <box
      key={String(useSplitView)}
      style={{ flexDirection: "column", height: "100%", padding: 1, backgroundColor: BACKGROUND_COLOR }}
    >
      {/* Navigation header */}
      <box style={{ paddingBottom: 1, paddingLeft: 1, paddingRight: 1, flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
        <text fg="#ffffff">←</text>
        <box flexGrow={1} />
        <text onMouseDown={() => setShowDropdown(true)}>
          {fileName.trim()}
        </text>
        {mode === Mode.INTELLIGENT && isAnalyzing && (
          <>
            <text fg="#666666"> | </text>
            <spinner type={spinners.bouncingBall} color="#FFA500" />
          </>
        )}
        {MODE_CONFIG[mode].showSingleHunk && (
          <>
            <text fg="#666666"> | Hunk </text>
            <text fg="#ffffff">{validHunkIndex + 1}</text>
            <text fg="#666666">/{currentFile.hunks.length}</text>
          </>
        )}
        <text fg="#00ff00"> +{additions}</text>
        <text fg="#ff0000">-{deletions}</text>
        <box flexGrow={1} />
        <text fg="#ffffff">→</text>
      </box>

      {/* Intelligent summary section */}
      {mode === Mode.INTELLIGENT && !isAnalyzing && intelligentAnalysis && currentHunk && (() => {
        const hunkStart = currentHunk.newStart || 0;
        const hunkAnalysis = intelligentAnalysis.hunks.find(h =>
          h.file === fileName &&
          hunkStart >= h.lineStart &&
          hunkStart <= h.lineEnd
        );
        if (hunkAnalysis) {
          const tag = getClassificationTag(hunkAnalysis.classification);
          return (
            <box style={{
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 2,
              paddingRight: 2,
              marginBottom: 2,
              flexShrink: 0,
              flexDirection: "column",
              backgroundColor: "#1a1a1a",
              alignItems: "center",
              justifyContent: "center"
            }}>
              <box style={{ flexDirection: "row", alignItems: "center" }}>
                <text fg={tag.color} >{tag.label}</text>
                <text fg="#666666"> | </text>
                <text fg="#999999">Risk: </text>
                <text fg={
                  hunkAnalysis.risk === "high" ? "#ff0000" :
                  hunkAnalysis.risk === "medium" ? "#ffaa00" :
                  "#00ff00"
                }>{hunkAnalysis.risk}</text>
              </box>
              {hunkAnalysis.description && (
                <box style={{ paddingTop: 1 }}>
                  <text fg="#cccccc">{hunkAnalysis.description}</text>
                </box>
              )}
            </box>
          );
        }
        return null;
      })()}

      <scrollbox
        scrollAcceleration={scrollAcceleration}
        style={{
          flexGrow: 1,
          rootOptions: {
            backgroundColor: "transparent",
            border: false,
          },

          scrollbarOptions: {
            showArrows: false,
            trackOptions: {
              foregroundColor: "#4a4a4a",
              backgroundColor: "transparent",
            },
          },
        }}
      >
        <box style={{
          flexDirection: "column",
          justifyContent: MODE_CONFIG[mode].showSingleHunk ? "center" : undefined,
          minHeight: "100%"
        }}>
          <FileEditPreview
            hunks={MODE_CONFIG[mode].showSingleHunk ? (currentHunk ? [currentHunk] : []) : currentFile.hunks}
            paddingLeft={0}
            splitView={useSplitView}
            filePath={fileName}
          />
        </box>
      </scrollbox>

      {/* Bottom navigation */}
      <box style={{ paddingTop: 1, paddingLeft: 1, paddingRight: 1, flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
        {mode === Mode.FILE_NAVIGATION && (
          <>
            <text fg="#ffffff">↑</text>
            <text fg="#666666"> prev file</text>
            <box flexGrow={1} />
            <text fg="#ffffff">m</text>
            <text fg="#666666"> mode: </text>
            <text fg="#FFA500">FILE</text>
            <text fg="#666666"> | </text>
            <text fg="#ffffff">ctrl p</text>
            <text fg="#666666"> select</text>
            <text fg="#666666"> ({validIndex + 1}/{displayFiles.length})</text>
            <box flexGrow={1} />
            <text fg="#666666">next file </text>
            <text fg="#ffffff">↓</text>
          </>
        )}
        {mode === Mode.HUNK_NAVIGATION && (
          <>
            <text fg="#ffffff">↑</text>
            <text fg="#666666"> prev hunk</text>
            <box flexGrow={1} />
            <text fg="#ffffff">←→</text>
            <text fg="#666666"> files</text>
            <text fg="#666666"> | </text>
            <text fg="#ffffff">m</text>
            <text fg="#666666"> mode: </text>
            <text fg="#FFA500">HUNK</text>
            <text fg="#666666"> | </text>
            <text fg="#ffffff">ctrl p</text>
            <text fg="#666666"> select</text>
            <text fg="#666666"> ({validIndex + 1}/{displayFiles.length})</text>
            <box flexGrow={1} />
            <text fg="#666666">next hunk </text>
            <text fg="#ffffff">↓</text>
          </>
        )}
        {mode === Mode.HUNK_ONLY && (
          <>
            <text fg="#ffffff">←</text>
            <text fg="#666666"> prev hunk</text>
            <box flexGrow={1} />
            <text fg="#ffffff">m</text>
            <text fg="#666666"> mode: </text>
            <text fg="#FFA500">HUNK_ONLY</text>
            <text fg="#666666"> | </text>
            <text fg="#ffffff">ctrl p</text>
            <text fg="#666666"> select</text>
            <text fg="#666666"> ({fileHunkToLinear(displayFiles, validIndex, validHunkIndex) + 1}/{getTotalHunks(displayFiles)})</text>
            <box flexGrow={1} />
            <text fg="#666666">next hunk </text>
            <text fg="#ffffff">→</text>
          </>
        )}
        {mode === Mode.INTELLIGENT && (
          <>
            <text fg="#ffffff">←</text>
            <text fg="#666666"> prev hunk</text>
            <box flexGrow={1} />
            <text fg="#ffffff">m</text>
            <text fg="#666666"> mode: </text>
            <text fg="#FFA500">INTELLIGENT</text>
            <text fg="#666666"> | </text>
            <text fg="#ffffff">ctrl p</text>
            <text fg="#666666"> select</text>
            <text fg="#666666"> ({fileHunkToLinear(displayFiles, validIndex, validHunkIndex) + 1}/{getTotalHunks(displayFiles)})</text>
            <box flexGrow={1} />
            <text fg="#666666">next hunk </text>
            <text fg="#ffffff">→</text>
          </>
        )}
      </box>
    </box>
  );
}



cli
  .command(
    "[ref]",
    "Show diff for a git reference (defaults to unstaged changes)",
  )
  .option("--staged", "Show staged changes")
  .option("--commit <ref>", "Show changes from a specific commit")
  .option("--watch", "Watch for file changes and refresh diff")
  .option("--model <name>", "AI model for intelligent mode: claude or codex (default: claude)")
  .action(async (ref, options) => {
    if (options.model && options.model !== "claude" && options.model !== "codex") {
      console.error(`Invalid model: ${options.model}. Must be "claude" or "codex"`);
      process.exit(1);
    }
    try {
      const gitCommand = (() => {
        if (options.staged) return "git diff --cached --no-prefix";
        if (options.commit) return `git show ${options.commit} --no-prefix`;
        if (ref) return `git show ${ref} --no-prefix`;
        return "git add -N . && git diff --no-prefix";
      })();

      const [diffModule, { parsePatch }] = await Promise.all([
        import("./diff.tsx"),
        import("diff"),
      ]);

      const shouldWatch = options.watch && !ref && !options.commit;
      const selectedModel = options.model || useDiffStateStore.getState().preferredModel || "claude";

      if (options.model) {
        useDiffStateStore.setState({ preferredModel: options.model });
      }

      function AppWithWatch() {
        const [parsedFiles, setParsedFiles] = useState<ParsedFile[] | null>(null);
        const [gitDiff, setGitDiff] = useState<string>("");
        const [filteredFiles, setFilteredFiles] = useState<ParsedFile[]>([]);
        const mode = useDiffStateStore((s) => s.mode);
        const isAnalyzing = useDiffStateStore((s) => s.isAnalyzing);

        useEffect(() => {
          const fetchDiff = async () => {
            try {
              const { stdout: diff } = await execAsync(gitCommand, {
                encoding: "utf-8",
              });

              if (!diff.trim()) {
                setParsedFiles([]);
                return;
              }

              setGitDiff(diff);

              const files = parsePatch(diff);

              const filtered = files.filter((file) => {
                const fileName = getFileName(file);
                if (!fileName) return false;
                const baseName = fileName.split("/").pop() || "";

                if (IGNORED_FILES.includes(baseName) || baseName.endsWith(".lock")) {
                  return false;
                }

                const totalLines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
                return totalLines <= 6000;
              });

              setFilteredFiles(filtered);

              const sortedFiles = filtered.sort((a, b) => {
                const aSize = a.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
                const bSize = b.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
                return aSize - bSize;
              });
              setParsedFiles(sortedFiles);
            } catch (error) {
              setParsedFiles([]);
            }
          };

          fetchDiff();

          if (!shouldWatch) {
            return;
          }

          const cwd = process.cwd();

          return () => {};
        }, []);

        useEffect(() => {
          const runAnalysis = async () => {
            if (mode !== Mode.INTELLIGENT || !gitDiff || filteredFiles.length === 0) {
              return;
            }

            const currentAnalysis = useDiffStateStore.getState().intelligentAnalysis;
            if (currentAnalysis) {
              setParsedFiles(filteredFiles);
              return;
            }

            useDiffStateStore.setState({ isAnalyzing: true });
            const repoDir = getRepoRoot();
            const commitKey = getCommitKey(options, ref);
            const diffSha = crypto
              .createHash("sha1")
              .update(`v2:${selectedModel}:${gitDiff}`)
              .digest("hex");

            if (repoDir && commitKey) {
              const cached = loadCachedAnalysis(repoDir, commitKey, diffSha);
              if (cached) {
                useDiffStateStore.setState({
                  intelligentAnalysis: cached,
                  isAnalyzing: false,
                });
                setParsedFiles(filteredFiles);
                return;
              }
            }

            const analysis = await analyzeDiff(gitDiff, selectedModel);

            if (repoDir && commitKey) {
              saveAnalysisCache(repoDir, commitKey, diffSha, analysis);
            }

            useDiffStateStore.setState({
              intelligentAnalysis: analysis,
              isAnalyzing: false,
            });
            setParsedFiles(filteredFiles);
          };

          runAnalysis();
        }, [mode, gitDiff, filteredFiles]);

        // Ensure currentFileIndex stays valid when files change
        useEffect(() => {
          if (parsedFiles && parsedFiles.length > 0) {
            const currentIndex = useDiffStateStore.getState().currentFileIndex;
            if (currentIndex >= parsedFiles.length) {
              useDiffStateStore.setState({ currentFileIndex: parsedFiles.length - 1 });
            }
          }
        }, [parsedFiles]);

        useKeyboard((key) => {
          if ((key.name === "escape" || key.name === "q") && parsedFiles?.length === 0) {
            process.exit(0);
          }
        });

        if (parsedFiles === null) {
          return (
            <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR }}>
              <text>Loading...</text>
            </box>
          );
        }

        if (parsedFiles.length === 0) {
          return (
            <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR, height: "100%", justifyContent: "center", alignItems: "center" }}>
              <text>No changes to display</text>
            </box>
          );
        }

        if (mode === Mode.INTELLIGENT && isAnalyzing) {
          return (
            <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR, height: "100%", justifyContent: "center", alignItems: "center" }}>
              <box style={{ flexDirection: "row", alignItems: "center" }}>
                <spinner type={spinners.bouncingBall} color="#FFA500" />
                <text> Analyzing diff...</text>
              </box>
            </box>
          );
        }

        return <App parsedFiles={parsedFiles} />;
      }

      const { ErrorBoundary } = diffModule;

      const renderer = await createCliRenderer();
      createRoot(renderer).render(
        createElement(
          ErrorBoundary,
          null,
          createElement(AppWithWatch)
        )
      );
    } catch (error) {
      console.error("Error getting git diff:", error);
      process.exit(1);
    }
  });

cli
  .command("difftool <local> <remote>", "Git difftool integration")
  .action(async (local: string, remote: string) => {
    if (!process.stdout.isTTY) {
      execSync(`git diff --no-ext-diff "${local}" "${remote}"`, {
        stdio: "inherit",
      });
      process.exit(0);
    }

    try {
      const [localContent, remoteContent, diffModule, { structuredPatch }] =
        await Promise.all([
          fs.readFileSync(local, "utf-8"),
          fs.readFileSync(remote, "utf-8"),
          import("./diff.tsx"),
          import("diff"),
        ]);

      const patch = structuredPatch(
        local,
        remote,
        localContent,
        remoteContent,
        "",
        "",
      );

      if (patch.hunks.length === 0) {
        console.log("No changes to display");
        process.exit(0);
      }

      const { ErrorBoundary } = diffModule;

      const renderer = await createCliRenderer();
      createRoot(renderer).render(
        createElement(
          ErrorBoundary,
          null,
          createElement(App, { parsedFiles: [patch] })
        )
      );
    } catch (error) {
      console.error("Error displaying diff:", error);
      process.exit(1);
    }
  });

cli
  .command("pick <branch>", "Pick files from another branch to apply to HEAD")
  .action(async (branch: string) => {
    try {
      const { stdout: currentBranch } = await execAsync(
        "git branch --show-current",
      );
      const current = currentBranch.trim();

      if (current === branch) {
        console.error("Cannot pick from the same branch");
        process.exit(1);
      }

      const { stdout: branchExists } = await execAsync(
        `git rev-parse --verify ${branch}`,
        { encoding: "utf-8" },
      ).catch(() => ({ stdout: "" }));

      if (!branchExists.trim()) {
        console.error(`Branch "${branch}" does not exist`);
        process.exit(1);
      }

      const { stdout: diffOutput } = await execAsync(
        `git diff --name-only HEAD...${branch}`,
        { encoding: "utf-8" },
      );

      const files = diffOutput
        .trim()
        .split("\n")
        .filter((f) => f);

      if (files.length === 0) {
        console.log("No differences found between branches");
        process.exit(0);
      }

      interface PickState {
        selectedFiles: Set<string>;
        appliedFiles: Map<string, boolean>; // Track which files have patches applied
        message: string;
        messageType: "info" | "error" | "success" | "";
      }

      const usePickStore = create<PickState>(() => ({
        selectedFiles: new Set(),
        appliedFiles: new Map(),
        message: "",
        messageType: "",
      }));

      interface PickAppProps {
        files: string[];
        branch: string;
      }

      function PickApp({ files, branch }: PickAppProps) {
        const selectedFiles = usePickStore((s) => s.selectedFiles);
        const message = usePickStore((s) => s.message);
        const messageType = usePickStore((s) => s.messageType);

        const handleChange = async (value: string) => {
          const isSelected = selectedFiles.has(value);

          if (isSelected) {
            const { error } = execSyncWithError(
              `git checkout HEAD -- "${value}"`,
              { stdio: "pipe" },
            );

            if (error) {
              if (error.includes("did not match any file(s) known to git")) {
                if (fs.existsSync(value)) {
                  fs.unlinkSync(value);
                }
              } else {
                usePickStore.setState({
                  message: `Failed to restore ${value}: ${error}`,
                  messageType: "error",
                });
                return;
              }
            }

            usePickStore.setState((state) => ({
              selectedFiles: new Set(
                Array.from(state.selectedFiles).filter((f) => f !== value),
              ),
              appliedFiles: new Map(
                Array.from(state.appliedFiles).filter(([k]) => k !== value),
              ),
            }));
          } else {
            const { stdout: mergeBase } = await execAsync(
              `git merge-base HEAD ${branch}`,
              { encoding: "utf-8" },
            );
            const base = mergeBase.trim();

            const { stdout: patchData } = await execAsync(
              `git diff ${base} ${branch} -- ${value}`,
              { encoding: "utf-8" },
            );

            const patchFile = join(
              tmpdir(),
              `tracer-pick-${Date.now()}.patch`,
            );
            fs.writeFileSync(patchFile, patchData);

            const result1 = execSyncWithError(
              `git apply --3way "${patchFile}"`,
              {
                stdio: "pipe",
              },
            );

            if (result1.error) {
              const result2 = execSyncWithError(`git apply "${patchFile}"`, {
                stdio: "pipe",
              });

              if (result2.error) {
                usePickStore.setState({
                  message: `Failed to apply ${value}: ${result2.error}`,
                  messageType: "error",
                });
                fs.unlinkSync(patchFile);
                return;
              }
            }

            fs.unlinkSync(patchFile);

            const { stdout: conflictCheck } = await execAsync(
              `git diff --name-only --diff-filter=U -- "${value}"`,
              { encoding: "utf-8" },
            );

            const hasConflict = conflictCheck.trim().length > 0;

            usePickStore.setState((state) => ({
              selectedFiles: new Set([...state.selectedFiles, value]),
              appliedFiles: new Map([...state.appliedFiles, [value, true]]),
              message: hasConflict ? `Applied ${value} with conflicts` : `Applied ${value}`,
              messageType: hasConflict ? "error" : "",
            }));
          }
        };

        return (
          <box style={{ padding: 1, flexDirection: "column", backgroundColor: BACKGROUND_COLOR }}>
            <Dropdown
              tooltip={`Pick files from "${branch}"`}
              onChange={handleChange}
              selectedValues={Array.from(selectedFiles)}
              placeholder="Search files..."
              options={files.map((file) => ({
                value: file,
                title: "/" + file,
                keywords: file.split("/"),
              }))}
            />
            {message && (
              <box
                style={{
                  paddingLeft: 2,
                  paddingRight: 2,
                  paddingTop: 1,
                  paddingBottom: 1,
                  marginTop: 1,
                  backgroundColor: BACKGROUND_COLOR,
                }}
              >
                <text
                  fg={
                    messageType === "error"
                      ? "#ff6b6b"
                      : messageType === "success"
                        ? "#51cf66"
                        : "#ffffff"
                  }
                >
                  {message}
                </text>
              </box>
            )}
          </box>
        );
      }

      const renderer = await createCliRenderer();
      createRoot(renderer).render(<PickApp files={files} branch={branch} />);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

cli.help();
cli.version("1.0.0");
cli.parse();
