const state = {
  notebookPath: "startup.ijsnb",
  activePath: null,
  activeResourceType: "notebook",
  notebook: null,
  filePreview: null,
  modules: [],
  installedPackages: [],
  typeLibraries: [],
  packageExports: [],
  loadedTypePackages: new Set(),
  localFiles: [],          // { name, content } for .js/.ts files in the notebook dir
  workspaceRoot: null,
  monaco: null,
  monacoReady: false,
  activeCellId: null,
  dirty: false,
  kernelBusy: false,
  lastSavedAt: null,
  packagesDrawerOpen: false,
  packageDocsOpen: false,
  packageDocsLoading: false,
  packageDocsPackage: null,
  packageDocsData: null,
  packageDocsError: null,
  envPanelOpen: false,
  aiAssistantOpen: false,
  aiAssistantLoading: false,
  aiAssistantCellId: null,
  aiAssistantMessages: [],
  aiAssistantHasKey: false,
  aiAssistantModels: [],
  aiAssistantModel: "llama-3.3-70b-versatile",
  sidebarOpen: true,
  explorerOpen: true,
  // 0 = both visible, 1 = workspace panel hidden (sidebar always shown)
  sidebarLayoutState: Math.min(Number(sessionStorage.getItem("sidebarLayoutState") ?? 0), 1),
  theme: localStorage.getItem("nodebook-theme") || "antariksha",
  editorFontSize: Number(localStorage.getItem("nodebook-font-size")) || 13,
  editorFontFamily: localStorage.getItem("nodebook-font-family") || "default",
  cellTimings: new Map(),
  notebookLanguage: "typescript",   // global notebook-level language
  runningCells: new Set(),
  // ── Terminal ──────────────────────────────────────────
  terminalOpen: false,
  terminalCwd: null,         // current working directory shown in header
  terminalHistory: [],      // [{command, output, ok, running}]
  terminalCmdHistory: [],   // strings for Up/Down navigation
  terminalHistoryIdx: -1
};


export {state}