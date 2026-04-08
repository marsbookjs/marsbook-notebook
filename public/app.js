import { state } from "./components/state.js";
import { genAIPackages } from "./components/packages.js";
import {
  MONACO_THEME_DEFS,
  THEMES,
  NODE_GLOBALS_DTS,
} from "./components/constants.js";
import { elements } from "./components/elements.js";

const editorInstances = new Map();
const modelInstances = new Map();
const modelListeners = new Map();
const markdownModes = new Map();
const directoryCache = new Map();
const expandedDirectories = new Set();
const monacoExtraLibs = [];

const executedInSession = new Set();
let monacoPromise = null;
let completionProvider = null;
let javascriptCompletionProvider = null;
let saveQueue = Promise.resolve();
let currentExecutionAbort = null; // AbortController for the active cell execution
let pendingInlineInputCount = 0; // Number of inline input widgets currently awaiting user input
let activeExecutionCount = 0; // Number of cell executions currently in flight (code or prompt)
const outputScrollPositions = new Map();

// File editor (Monaco instance for editing .js/.ts workspace files)
let fileEditorInstance = null;
let fileEditorModel = null;
let fileEditorDirty = false;

// Restore sidebar layout state from sessionStorage on page load
// (syncSidebarState is defined later in the file but we just apply classes directly here)
{
  const s = state.sidebarLayoutState;
  if (s >= 1) elements.notebookListPanel?.classList.add("is-collapsed");
  elements.explorerToggleBtn?.classList.toggle("is-active", s === 0);
}

function applyTheme(themeId) {
  const resolvedId = THEMES[themeId]
    ? themeId
    : THEMES["obsidian"]
      ? "obsidian"
      : Object.keys(THEMES)[0];
  const def = THEMES[resolvedId];
  if (!def) return;
  state.theme = resolvedId;
  document.documentElement.setAttribute("data-theme", resolvedId);
  document.documentElement.setAttribute("data-theme-base", def.base);
  localStorage.setItem("nodebook-theme", resolvedId);
  if (state.monacoReady) {
    state.monaco.editor.setTheme(def.monacoId);
  }
  document.querySelectorAll(".theme-select").forEach((sel) => {
    sel.value = resolvedId;
  });
}

/* ===== FONT SIZE / SETTINGS MODAL ===== */
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 20;

// Resolve "default" sentinel to Monaco's built-in default font stack
function resolvedFontFamily(value) {
  return value === "default"
    ? "'Menlo', 'Monaco', 'Courier New', monospace"
    : value;
}

function applyFontSize(size) {
  size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  state.editorFontSize = size;
  localStorage.setItem("nodebook-font-size", size);
  // Update all live Monaco editor instances and force host height recalc
  for (const [cellId, editor] of editorInstances.entries()) {
    editor.updateOptions({ fontSize: size });
    // Allow Monaco to re-measure then resize the host element
    requestAnimationFrame(() => {
      const host = document.querySelector(`[data-editor-host="${cellId}"]`);
      if (!host) return;
      const h = Math.max(60, Math.min(editor.getContentHeight(), 600));
      host.style.height = `${h}px`;
      editor.layout();
    });
  }
  if (fileEditorInstance) {
    fileEditorInstance.updateOptions({ fontSize: size });
  }
  // Flush Monaco's glyph-width cache so cursor stays accurate at the new size
  if (state.monacoReady) {
    requestAnimationFrame(() => state.monaco.editor.remeasureFonts());
  }
  // Update settings modal display and preview
  const display = document.getElementById("font-size-display");
  if (display) display.textContent = `${size}px`;
  const preview = document.getElementById("font-size-preview");
  if (preview) preview.style.fontSize = `${size}px`;
}

function applyFontFamily(value) {
  state.editorFontFamily = value;
  localStorage.setItem("nodebook-font-family", value);
  const fontFamily = resolvedFontFamily(value);
  // Update all live Monaco editor instances
  for (const editor of editorInstances.values()) {
    editor.updateOptions({ fontFamily });
  }
  if (fileEditorInstance) {
    fileEditorInstance.updateOptions({ fontFamily });
  }
  // Update preview pane
  const preview = document.getElementById("font-size-preview");
  if (preview) preview.style.fontFamily = fontFamily;
  // Tell Monaco to flush its glyph-width cache for the new font so cursor
  // X position is recalculated correctly after the font switch.
  if (state.monacoReady) {
    // Wait one frame for the browser to apply the new font, then remeasure
    requestAnimationFrame(() => {
      state.monaco.editor.remeasureFonts();
    });
  }
}

function openSettingsModal() {
  const modal = document.getElementById("settings-modal");
  const scrim = document.getElementById("settings-modal-scrim");
  if (!modal || !scrim) return;
  // Sync current font size into modal
  const display = document.getElementById("font-size-display");
  if (display) display.textContent = `${state.editorFontSize}px`;
  // Sync font family selector
  const fontSel = document.getElementById("font-family-select");
  if (fontSel) fontSel.value = state.editorFontFamily;
  // Sync preview
  const preview = document.getElementById("font-size-preview");
  if (preview) {
    preview.style.fontSize = `${state.editorFontSize}px`;
    preview.style.fontFamily = resolvedFontFamily(state.editorFontFamily);
  }
  modal.classList.remove("hidden");
  scrim.classList.remove("hidden");
}

function closeSettingsModal() {
  document.getElementById("settings-modal")?.classList.add("hidden");
  document.getElementById("settings-modal-scrim")?.classList.add("hidden");
}

// Settings modal event wiring (runs after DOM ready)
document
  .getElementById("settings-btn")
  ?.addEventListener("click", openSettingsModal);
document
  .getElementById("settings-close-btn")
  ?.addEventListener("click", closeSettingsModal);
document
  .getElementById("settings-modal-scrim")
  ?.addEventListener("click", closeSettingsModal);
document
  .getElementById("font-size-dec")
  ?.addEventListener("click", () => applyFontSize(state.editorFontSize - 1));
document
  .getElementById("font-size-inc")
  ?.addEventListener("click", () => applyFontSize(state.editorFontSize + 1));
document
  .getElementById("font-family-select")
  ?.addEventListener("change", (e) => applyFontFamily(e.target.value));

/* ===== KEYBOARD SHORTCUTS ===== */
const SHORTCUTS = [
  { keys: ["Shift", "Enter"], description: "Run cell and move to next" },
  { keys: ["Ctrl/Cmd", "S"], description: "Save notebook" },
  { keys: ["Ctrl/Cmd", "Enter"], description: "Run cell" },
  { keys: ["Ctrl/Cmd", "Shift", "K"], description: "Delete cell" },
  { keys: ["?"], description: "Toggle keyboard shortcuts" },
];

function showShortcutsModal() {
  const existing = document.querySelector(".shortcuts-overlay");
  if (existing) {
    existing.remove();
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay";

  const panel = document.createElement("div");
  panel.className = "shortcuts-panel";

  const title = document.createElement("h3");
  title.className = "shortcuts-title";
  title.textContent = "Keyboard Shortcuts";
  panel.appendChild(title);

  for (const shortcut of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "shortcut-row";

    const desc = document.createElement("span");
    desc.textContent = shortcut.description;
    row.appendChild(desc);

    const keysDiv = document.createElement("div");
    keysDiv.className = "shortcut-keys";

    for (const key of shortcut.keys) {
      const kbd = document.createElement("span");
      kbd.className = "shortcut-key";
      kbd.textContent = key;
      keysDiv.appendChild(kbd);
    }

    row.appendChild(keysDiv);
    panel.appendChild(row);
  }

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

/* ===== UTILITIES ===== */
function createCell(type = "code", source = "", language = "typescript") {
  const cell = {
    id: crypto.randomUUID(),
    type,
    source,
    executionCount: null,
    outputs: [],
    collapsed: false,
    outputCollapsed: false,
  };

  if (type === "code") {
    cell.language = language;
  }

  if (type === "prompt") {
    cell.prompt = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      system: "",
      temperature: 0.2,
    };
  }

  return cell;
}

function getCellLanguage(cell) {
  // Default to typescript for code cells that have no language set.
  // NOTE: The global language toggle explicitly sets cell.language on every cell,
  // so relying on state.notebookLanguage here is unnecessary and risks placing
  // cells into JavaScript mode (giving them .mjs URIs) when the user has TypeScript
  // selected — which severely degrades library IntelliSense.
  if (cell.type !== "code") return undefined;
  return cell.language ?? "typescript";
}

function estimateTokens(value) {
  const source = String(value ?? "").trim();
  if (!source) return 0;
  return Math.max(1, Math.ceil(source.split(/\s+/).join(" ").length / 4));
}

function deriveTitleFromPath(notebookPath) {
  const fileName = notebookPath.split("/").pop() ?? "Untitled Nodebook.ijsnb";
  return fileName.replace(/\.ijsnb$/i, "") || "Untitled Nodebook";
}

function isNotebookView() {
  return state.activeResourceType === "notebook" && !!state.notebook;
}

function isFileView() {
  return state.activeResourceType === "file" && !!state.filePreview;
}

function sanitizeNotebookFileName(title) {
  const normalized = String(title ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "untitled";
}

function deriveNotebookPathFromTitle(notebookPath, title) {
  const segments = notebookPath.split("/");
  segments[segments.length - 1] = `${sanitizeNotebookFileName(title)}.ijsnb`;
  return segments.join("/");
}

function getAppPathForFilePath(filePath) {
  if (!filePath) return "/";
  const normalized = filePath.replaceAll("\\", "/");

  // If we have the workspace root, compute the relative path and add /notebooks/ prefix.
  if (state.workspaceRoot) {
    const wsNorm = state.workspaceRoot.replaceAll("\\", "/");
    if (normalized.startsWith(`${wsNorm}/`)) {
      const rel = normalized.slice(`${wsNorm}/`.length);
      return `/notebooks/${rel}`;
    }
  }

  // Fallback: strip any existing /notebooks/ prefix then re-add it to normalise.
  const clean = normalized.replace(/^\/+/, "").replace(/^notebooks\//, "");
  return `/notebooks/${clean}`;
}

function updateBrowserUrl(appPath, historyMode = "push") {
  const nextUrl = appPath || "/";

  if (window.location.pathname === nextUrl) {
    return;
  }

  const operation = historyMode === "replace" ? "replaceState" : "pushState";
  window.history[operation]({ path: nextUrl }, "", nextUrl);
}

function dirname(filePath) {
  const normalized = filePath.replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : normalized;
}

function basename(filePath) {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

function isCompactViewport() {
  return window.matchMedia("(max-width: 920px)").matches;
}

/**
 * Apply the current sidebarLayoutState to the DOM.
 *
 * State 0 — both sidebar nav and workspace panel visible
 * State 1 — workspace panel collapsed, sidebar nav always visible
 */
function syncSidebarState() {
  const s = state.sidebarLayoutState;
  const panel = elements.notebookListPanel;

  // Workspace panel: hidden in state 1 (sidebar always stays visible)
  const panelHidden = s >= 1;
  panel?.classList.toggle("is-collapsed", panelHidden);
  elements.explorerToggleBtn?.classList.toggle("is-active", !panelHidden);

  // Persist to sessionStorage so choice survives refresh
  sessionStorage.setItem("sidebarLayoutState", String(s));
}

function syncPackageDocsDrawer() {
  elements.packageDocsDrawer?.classList.toggle(
    "is-open",
    state.packageDocsOpen,
  );
  elements.packageDocsScrim?.classList.toggle("is-open", state.packageDocsOpen);
}

function setSidebarOpen(nextOpen) {
  state.sidebarOpen = nextOpen;
  syncSidebarState();
}

function toggleSidebar() {
  setSidebarOpen(!state.sidebarOpen);
}

/** Toggle workspace panel: 0 (panel visible) ↔ 1 (panel hidden) */
function cycleSidebarLayout() {
  state.sidebarLayoutState = state.sidebarLayoutState === 0 ? 1 : 0;
  syncSidebarState();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeUrl(url, allowedProtocols = ["http:", "https:"]) {
  const value = String(url ?? "").trim();

  if (!value) {
    return null;
  }

  if (value.startsWith("#")) {
    return value;
  }

  try {
    const parsed = new URL(value, window.location.origin);
    if (!allowedProtocols.includes(parsed.protocol)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function sanitizeHtmlFragment(source) {
  const allowedTags = new Set([
    "a",
    "img",
    "p",
    "div",
    "span",
    "br",
    "strong",
    "em",
    "b",
    "i",
    "code",
    "pre",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
  ]);
  const stripContentTags = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
  ]);
  const allowedAttributes = new Map([
    ["a", new Set(["href", "title"])],
    ["img", new Set(["src", "alt", "title", "width", "height"])],
    ["p", new Set(["align"])],
    ["div", new Set(["align"])],
    ["span", new Set(["align"])],
  ]);
  const closingTagMatch = source.match(/^<\/([A-Za-z][\w:-]*)\s*>$/);

  if (closingTagMatch) {
    const tagName = closingTagMatch[1].toLowerCase();
    return allowedTags.has(tagName) ? `</${tagName}>` : "";
  }

  const template = document.createElement("template");
  template.innerHTML = source;

  const sanitizeNode = (node) => {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    for (const child of [...node.childNodes]) {
      sanitizeNode(child);
    }

    const tagName = node.tagName.toLowerCase();

    if (stripContentTags.has(tagName)) {
      node.remove();
      return;
    }

    if (!allowedTags.has(tagName)) {
      const children = [...node.childNodes];
      node.replaceWith(...children);
      return;
    }

    const allowedForTag = allowedAttributes.get(tagName) ?? new Set();
    for (const attribute of [...node.attributes]) {
      if (!allowedForTag.has(attribute.name.toLowerCase())) {
        node.removeAttribute(attribute.name);
      }
    }

    if (tagName === "a") {
      const safeHref = sanitizeUrl(node.getAttribute("href"), [
        "http:",
        "https:",
        "mailto:",
      ]);
      if (!safeHref) {
        const children = [...node.childNodes];
        node.replaceWith(...children);
        return;
      }
      node.setAttribute("href", safeHref);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }

    if (tagName === "img") {
      const safeSrc = sanitizeUrl(node.getAttribute("src"), [
        "http:",
        "https:",
      ]);
      if (!safeSrc) {
        node.remove();
        return;
      }
      node.setAttribute("src", safeSrc);
      if (!node.hasAttribute("alt")) {
        node.setAttribute("alt", "");
      }
      node.setAttribute("loading", "lazy");
    }
  };

  for (const child of [...template.content.childNodes]) {
    sanitizeNode(child);
  }

  return template.innerHTML;
}

function restoreTokenValues(source, tokenPrefix, values) {
  let result = source;

  for (let index = 0; index < values.length; index += 1) {
    result = result.replaceAll(`${tokenPrefix}${index}__`, values[index]);
  }

  return result;
}

function isLikelyImageUrl(url) {
  const value = String(url ?? "").trim();

  if (!value) {
    return false;
  }

  if (value.startsWith("data:image/")) {
    return true;
  }

  const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".bmp", ".ico"];

  try {
    const parsed = new URL(value, window.location.origin);
    const knownImageHosts = new Set([
      "img.shields.io",
      "badge.fury.io",
      "badgen.net",
      "user-images.githubusercontent.com",
      "raw.githubusercontent.com",
    ]);

    if (knownImageHosts.has(parsed.hostname)) return true;

    // Check both the raw pathname and the decoded pathname (handles %20, %2E etc.)
    const rawPath = parsed.pathname.toLowerCase();
    let decodedPath = rawPath;
    try { decodedPath = decodeURIComponent(rawPath); } catch { /* keep raw */ }

    // Strip query string from the path segment before extension check
    const pathForExt = decodedPath.split("?")[0].split("#")[0];

    if (imageExtensions.some((ext) => rawPath.endsWith(ext) || pathForExt.endsWith(ext))) {
      return true;
    }

    // Last resort: check the last path segment of the full URL string
    const lastSegment = value.split("/").pop()?.split("?")[0].toLowerCase() ?? "";
    return imageExtensions.some((ext) => lastSegment.endsWith(ext));
  } catch {
    // For non-parseable URLs, fall back to checking the raw string
    const lower = value.toLowerCase();
    return imageExtensions.some((ext) => lower.includes(ext));
  }
}

function createMarkdownImageHtml(altText, url) {
  const raw = String(url ?? "").trim();

  // Handle local/relative image paths — route through the workspace file API
  const isRelative =
    raw &&
    !raw.startsWith("http://") &&
    !raw.startsWith("https://") &&
    !raw.startsWith("data:") &&
    !raw.startsWith("//") &&
    !raw.startsWith("#");

  if (isRelative) {
    const imgExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"];
    const ext = raw.split(".").pop()?.toLowerCase() ?? "";
    if (imgExts.includes(ext)) {
      // Resolve relative to the current notebook directory
      const nbDir = (state.notebookPath ?? "").split("/").slice(0, -1).join("/");
      const cleanRel = raw.replace(/^\.\//, "");
      const resolvedPath = nbDir ? `${nbDir}/${cleanRel}` : cleanRel;
      const apiSrc = `/api/file/content?path=${encodeURIComponent(resolvedPath)}`;
      return `<img src="${apiSrc}" alt="${altText}" loading="lazy" style="max-width:100%;max-height:250px;object-fit:contain;border-radius:4px;" />`;
    }
  }

  const safeUrl = sanitizeUrl(url, ["http:", "https:"]);

  if (!safeUrl) {
    return altText || "";
  }

  if (!isLikelyImageUrl(safeUrl)) {
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${altText || safeUrl}</a>`;
  }

  return `<img src="${safeUrl}" alt="${altText}" loading="lazy" />`;
}

function renderInlineMarkdown(source, htmlTokens = []) {
  const codeTokens = [];
  const withCodeTokens = source.replace(/`([^`]+)`/g, (_, code) => {
    const token = `__NODEBOOK_INLINE_CODE_${codeTokens.length}__`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  let html = withCodeTokens
    .replace(
      /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g,
      (_, altText, imageUrl, href) => {
        const safeHref = sanitizeUrl(href, ["http:", "https:", "mailto:"]);
        const imageHtml = createMarkdownImageHtml(altText, imageUrl);

        if (!safeHref) {
          return imageHtml;
        }

        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${imageHtml}</a>`;
      },
    )
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, altText, imageUrl) =>
      createMarkdownImageHtml(altText, imageUrl),
    )
    .replace(
      /\[(<a\b[^>]*><img\b[^>]*><\/a>)\]\(([^)\s]+)\)/g,
      (_, linkedImageHtml, href) => {
        const safeHref = sanitizeUrl(href, ["http:", "https:", "mailto:"]);
        if (!safeHref) {
          return linkedImageHtml;
        }
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${linkedImageHtml}</a>`;
      },
    )
    .replace(/\[(<img\b[^>]*>)\]\(([^)\s]+)\)/g, (_, imageHtml, href) => {
      const safeHref = sanitizeUrl(href, ["http:", "https:", "mailto:"]);
      if (!safeHref) {
        return imageHtml;
      }
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${imageHtml}</a>`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const safeHref = sanitizeUrl(href, ["http:", "https:", "mailto:"]);
      if (!safeHref) {
        return label;
      }
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  html = restoreTokenValues(html, "__NODEBOOK_INLINE_CODE_", codeTokens);
  return restoreTokenValues(html, "__NODEBOOK_HTML_TOKEN_", htmlTokens);
}

function renderMarkdown(source) {
  const codeBlocks = [];
  const normalized = source.replace(/\r\n/g, "\n");
  const withoutCodeBlocks = normalized.replace(
    /```([\w-]+)?\n([\s\S]*?)```/g,
    (_, language = "", code = "") => {
      const token = `__NODEBOOK_CODE_BLOCK_${codeBlocks.length}__`;
      const langAttr = language
        ? ` data-language="${escapeHtml(language)}"`
        : "";
      codeBlocks.push(
        `<pre class="md-code-block"><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`,
      );
      return token;
    },
  );
  const htmlTokens = [];
  const withoutHtml = withoutCodeBlocks.replace(
    /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g,
    (fragment) => {
      if (fragment.startsWith("<!--")) {
        return "";
      }

      const sanitized = sanitizeHtmlFragment(fragment);
      if (!sanitized) {
        return "";
      }

      const token = `__NODEBOOK_HTML_TOKEN_${htmlTokens.length}__`;
      htmlTokens.push(sanitized);
      return token;
    },
  );
  const escaped = escapeHtml(withoutHtml);
  const lines = escaped.split("\n");
  const blocks = [];
  let paragraphLines = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let tableLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(
      `<p>${renderInlineMarkdown(paragraphLines.join("<br />"), htmlTokens)}</p>`,
    );
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    const tag = listType === "ol" ? "ol" : "ul";
    blocks.push(
      `<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item, htmlTokens)}</li>`).join("")}</${tag}>`,
    );
    listType = null;
    listItems = [];
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    blocks.push(
      `<blockquote><p>${renderInlineMarkdown(quoteLines.join("<br />"), htmlTokens)}</p></blockquote>`,
    );
    quoteLines = [];
  };

  const parseTableRow = (line) => {
    // Strip leading/trailing pipe and split on remaining pipes
    return line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  };

  const isTableSeparatorRow = (line) => {
    // Must be all dashes, colons, pipes, and spaces — e.g. |---|:---:|---:|
    return /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?$/.test(line);
  };

  const flushTable = () => {
    if (tableLines.length === 0) return;
    // Need at least a header row + separator row
    if (tableLines.length < 2 || !isTableSeparatorRow(tableLines[1])) {
      // Not a real table — fall back to paragraphs
      for (const l of tableLines) paragraphLines.push(l);
      tableLines = [];
      return;
    }
    const headers = parseTableRow(tableLines[0]);
    const dataRows = tableLines.slice(2).map(parseTableRow);
    let html = `<table class="md-table"><thead><tr>`;
    for (const h of headers) {
      html += `<th>${renderInlineMarkdown(h, htmlTokens)}</th>`;
    }
    html += `</tr></thead><tbody>`;
    for (const row of dataRows) {
      html += `<tr>`;
      for (let i = 0; i < headers.length; i++) {
        html += `<td>${renderInlineMarkdown(row[i] ?? "", htmlTokens)}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    blocks.push(html);
    tableLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (
      trimmed.startsWith("__NODEBOOK_CODE_BLOCK_") &&
      trimmed.endsWith("__")
    ) {
      flushParagraph();
      flushList();
      flushQuote();
      flushTable();
      const index = Number(trimmed.match(/(\d+)/)?.[1] ?? -1);
      blocks.push(codeBlocks[index] ?? "");
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      flushTable();
      continue;
    }

    // Table row: starts with | and contains at least one more |
    if (trimmed.startsWith("|") && trimmed.indexOf("|", 1) !== -1) {
      flushParagraph();
      flushList();
      flushQuote();
      tableLines.push(trimmed);
      continue;
    }
    flushTable();

    const quoteMatch = trimmed.match(/^&gt;\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }
    flushQuote();

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      blocks.push(
        `<h${level}>${renderInlineMarkdown(headingMatch[2], htmlTokens)}</h${level}>`,
      );
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(orderedMatch[1]);
      continue;
    }

    if (listType) {
      listItems[listItems.length - 1] += `<br />${trimmed}`;
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushTable();

  return restoreTokenValues(
    blocks.join(""),
    "__NODEBOOK_HTML_TOKEN_",
    htmlTokens,
  );
}

function closePackageDocsDrawer() {
  state.packageDocsOpen = false;
  syncPackageDocsDrawer();
}

function resetPackageDocsDrawer() {
  state.packageDocsOpen = false;
  state.packageDocsLoading = false;
  state.packageDocsPackage = null;
  state.packageDocsData = null;
  state.packageDocsError = null;
  renderPackageDocsDrawer();
}

function renderPackageDocsDrawer() {
  syncPackageDocsDrawer();
  elements.packageDocsContent.innerHTML = "";

  const title = state.packageDocsPackage ?? "Select a package";
  elements.packageDocsTitle.replaceChildren(document.createTextNode(title));

  const version = state.packageDocsData?.version
    ? `v${state.packageDocsData.version}`
    : "";
  elements.packageDocsVersion.textContent = version;
  elements.packageDocsVersion.classList.toggle("hidden", !version);

  if (state.packageDocsLoading) {
    elements.packageDocsStatus.classList.remove("hidden");
    elements.packageDocsContent.classList.add("hidden");
    elements.packageDocsStatus.textContent = `Loading docs for ${title}...`;
    return;
  }

  if (state.packageDocsError) {
    elements.packageDocsStatus.classList.remove("hidden");
    elements.packageDocsContent.classList.add("hidden");
    elements.packageDocsStatus.textContent = state.packageDocsError;
    return;
  }

  if (!state.packageDocsData) {
    elements.packageDocsStatus.classList.remove("hidden");
    elements.packageDocsContent.classList.add("hidden");
    elements.packageDocsStatus.textContent =
      "Click an installed package to load its README here.";
    return;
  }

  const { npmUrl, description, readme } = state.packageDocsData;

  if (npmUrl) {
    const titleLink = document.createElement("a");
    titleLink.className = "package-docs-title-link";
    titleLink.href = npmUrl;
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
    titleLink.textContent = title;
    elements.packageDocsTitle.replaceChildren(titleLink);
  }

  elements.packageDocsStatus.classList.add("hidden");
  elements.packageDocsContent.classList.remove("hidden");

  if (description) {
    const summary = document.createElement("p");
    summary.className = "package-docs-summary";
    summary.textContent = description;
    elements.packageDocsContent.appendChild(summary);
  }

  const sectionTitle = document.createElement("p");
  sectionTitle.className = "package-docs-section-title";
  sectionTitle.textContent = "README";
  elements.packageDocsContent.appendChild(sectionTitle);

  const readmeBlock = document.createElement("div");
  readmeBlock.className = "package-docs-readme rendered-markdown";
  readmeBlock.innerHTML = renderMarkdown(
    readme || "No README available for this package.",
  );
  elements.packageDocsContent.appendChild(readmeBlock);
}

async function openPackageDocs(moduleName) {
  state.packageDocsOpen = true;
  state.packageDocsLoading = true;
  state.packageDocsPackage = moduleName;
  state.packageDocsData = null;
  state.packageDocsError = null;
  renderPackageDocsDrawer();

  try {
    const data = await api(
      `/api/package-docs?path=${encodeURIComponent(state.notebookPath)}&package=${encodeURIComponent(moduleName)}`,
    );
    state.packageDocsData = data;
  } catch (error) {
    state.packageDocsError =
      error.message || `Unable to load docs for ${moduleName}`;
    showToast(state.packageDocsError, "error");
  } finally {
    state.packageDocsLoading = false;
    renderPackageDocsDrawer();
  }
}

function setKernelStatus(label, busy = false) {
  state.kernelBusy = busy;
  if (elements.kernelPillLabel)
    elements.kernelPillLabel.textContent = busy ? "Running…" : "Connected";
  if (elements.kernelPill) {
    elements.kernelPill.classList.toggle("running", busy);
    elements.kernelPill.classList.toggle("disconnected", false);
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  const label = dirty
    ? "Unsaved changes"
    : state.lastSavedAt
      ? `Saved ${new Date(state.lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Saved";
  if (elements.nbSaveState) elements.nbSaveState.textContent = label;
}

function updateHeader() {
  const title = isNotebookView()
    ? (state.notebook?.metadata?.title ??
      deriveTitleFromPath(state.notebookPath))
    : basename(state.activePath ?? "");

  if (elements.nbTitleDisplay) {
    elements.nbTitleDisplay.textContent = title;
    elements.nbTitleDisplay.classList.toggle("hidden", false);
  }
  if (elements.nbTitleInput) {
    elements.nbTitleInput.value = title;
  }
  if (elements.breadcrumbTitle) {
    elements.breadcrumbTitle.textContent = title;
  }
  if (elements.nbCellCount) {
    const count = state.notebook?.cells?.length ?? 0;
    elements.nbCellCount.textContent = `${count} cell${count !== 1 ? "s" : ""}`;
  }
  if (elements.nbLangBadge) {
    const firstCode = state.notebook?.cells?.find((c) => c.type === "code");
    const lang = firstCode
      ? firstCode.language === "javascript"
        ? "JavaScript"
        : "TypeScript"
      : "TypeScript";
    elements.nbLangBadge.textContent = lang;
    elements.nbLangBadge.className = `nb-meta-badge${firstCode?.language === "javascript" ? " js" : ""}`;
  }
  // Update global lang toggle button
  const nbLang =
    state.notebookLanguage ??
    state.notebook?.metadata?.language ??
    "typescript";
  if (elements.nbLangToggle) {
    elements.nbLangToggle.textContent =
      nbLang === "javascript" ? "JavaScript" : "TypeScript";
    elements.nbLangToggle.dataset.lang = nbLang === "javascript" ? "js" : "ts";
  }
}

function updateWorkspaceMode() {
  const notebookView = isNotebookView();
  elements.notebookCells?.classList.toggle("hidden", !notebookView);
  elements.filePreview?.classList.toggle("hidden", !isFileView());
  elements.addCodeButton && (elements.addCodeButton.disabled = !notebookView);
  elements.addMarkdownButton &&
    (elements.addMarkdownButton.disabled = !notebookView);
  elements.runAllBtn && (elements.runAllBtn.disabled = !notebookView);
  const showEnv = notebookView && state.envPanelOpen;
  elements.envPanel?.classList.toggle("is-open", showEnv);
  elements.envModalScrim?.classList.toggle("is-open", showEnv);
  const showAi = notebookView && state.aiAssistantOpen;
  elements.aiAssistantSheet?.classList.toggle("is-open", showAi);
  elements.aiModalScrim?.classList.toggle("is-open", showAi);
  // Update terminal CWD label whenever the active path changes
  if (state.terminalOpen) updateTerminalCwd();
}

function disposeFileEditor() {
  if (fileEditorInstance) {
    fileEditorInstance.dispose();
    fileEditorInstance = null;
  }
  if (fileEditorModel) {
    fileEditorModel.dispose();
    fileEditorModel = null;
  }
  fileEditorDirty = false;
}

async function saveCurrentFile() {
  if (!state.filePreview?.path || !fileEditorModel) return;
  const content = fileEditorModel.getValue();
  const result = await api("/api/file/save", {
    method: "POST",
    body: JSON.stringify({ path: state.filePreview.path, content }),
  });
  fileEditorDirty = false;
  const statusEl = document.querySelector("#file-editor-status");
  if (statusEl) statusEl.textContent = "Saved";

  // If the saved file is a .js or .ts file, update the formatted content in the
  // editor (server applies Prettier) and refresh local file IntelliSense so that
  // notebook cells instantly see the latest exports from the saved file.
  const ext = (state.filePreview.extension ?? "").toLowerCase();
  if ((ext === ".js" || ext === ".ts") && result?.formattedContent != null) {
    const cursorPos = fileEditorInstance?.getPosition();
    fileEditorModel.setValue(result.formattedContent);
    if (cursorPos) fileEditorInstance?.setPosition(cursorPos);
  }

  if (ext === ".js" || ext === ".ts" || ext === ".mjs") {
    try {
      const localData = await api(
        `/api/local-files?path=${encodeURIComponent(state.notebookPath)}`,
      );
      state.localFiles = localData.files ?? [];
      refreshMonacoLibraries();
    } catch {
      /* ignore */
    }
  }

  showToast("File saved", "success");
}

function renderFilePreview() {
  if (!isFileView()) {
    disposeFileEditor();
    elements.filePreview.innerHTML = "";
    return;
  }

  const { kind, name, extension, content, contentUrl } = state.filePreview;

  if (kind === "image") {
    disposeFileEditor();
    elements.filePreview.innerHTML = `
      <article class="file-preview-card">
        <div class="file-preview-header">
          <h2 class="file-preview-title">${escapeHtml(name)}</h2>
          <span class="file-preview-badge">${escapeHtml(extension.toUpperCase().replace(/^\./, ""))}</span>
        </div>
        <div class="file-preview-image-wrap">
          <img class="file-preview-image" src="${contentUrl}" alt="${escapeHtml(name)}" />
        </div>
      </article>
    `;
    return;
  }

  if (kind === "pdf") {
    disposeFileEditor();
    elements.filePreview.innerHTML = `
      <article class="file-preview-card">
        <div class="file-preview-header">
          <h2 class="file-preview-title">${escapeHtml(name)}</h2>
          <span class="file-preview-badge">PDF</span>
        </div>
        <iframe class="file-preview-pdf" src="${contentUrl}" title="${escapeHtml(name)}"></iframe>
      </article>
    `;
    return;
  }

  // Editable Monaco editor for .js, .ts, .md, .txt files
  const editableExts = new Set([".js", ".ts", ".md", ".txt"]);
  if (editableExts.has(extension) && state.monacoReady) {
    disposeFileEditor();
    elements.filePreview.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "file-editor-wrap";

    const toolbar = document.createElement("div");
    toolbar.className = "file-editor-toolbar";
    const isRunnable = extension === ".js" || extension === ".ts";
    toolbar.innerHTML = `
      <span class="file-editor-name">${escapeHtml(name)}</span>
      <div class="file-editor-actions">
        <span class="file-editor-status" id="file-editor-status">No changes</span>
        ${
          isRunnable
            ? `<button class="btn-file-run" id="file-editor-run-btn" type="button" title="Run file in terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Run
        </button>`
            : ""
        }
        <button class="btn-primary small" id="file-editor-save-btn" type="button">Save</button>
      </div>
    `;
    wrap.appendChild(toolbar);

    const editorHost = document.createElement("div");
    editorHost.className = "file-editor-host";
    wrap.appendChild(editorHost);
    elements.filePreview.appendChild(wrap);

    const langMap = {
      ".ts": "typescript",
      ".js": "javascript",
      ".md": "markdown",
      ".txt": "plaintext",
    };
    const lang = langMap[extension] ?? "plaintext";
    // Place the model under the same virtual root as notebook cells so that
    // TypeScript's module resolver walks up to file:///node_modules/ and finds
    // the virtual type declarations registered by refreshMonacoLibraries().
    fileEditorModel = state.monaco.editor.createModel(
      content ?? "",
      lang,
      state.monaco.Uri.parse(`file:///notebook/workspace/${name}`),
    );

    const editorTheme = (THEMES[state.theme] ?? THEMES["obsidian"]).monacoId;
    fileEditorInstance = state.monaco.editor.create(editorHost, {
      model: fileEditorModel,
      theme: editorTheme,
      fontFamily: resolvedFontFamily(state.editorFontFamily),
      fontSize: state.editorFontSize,
      fontLigatures: false,
      disableMonospaceOptimizations: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: "off",
      renderLineHighlight: "all",
      padding: { top: 12, bottom: 12 },
    });

    fileEditorModel.onDidChangeContent(() => {
      if (!fileEditorDirty) {
        fileEditorDirty = true;
        const statusEl = document.querySelector("#file-editor-status");
        if (statusEl) statusEl.textContent = "Unsaved changes";
      }
    });

    document
      .querySelector("#file-editor-save-btn")
      ?.addEventListener("click", () => {
        saveCurrentFile().catch(handleError);
      });

    // Run button — save first, then run in terminal
    document
      .querySelector("#file-editor-run-btn")
      ?.addEventListener("click", async () => {
        // Auto-save before running
        if (fileEditorDirty) await saveCurrentFile().catch(handleError);
        const fullPath = state.filePreview?.path ?? "";
        const cmd =
          extension === ".ts" ? `npx tsx "${fullPath}"` : `node "${fullPath}"`;
        openTerminal();
        await runTerminalCommand(cmd).catch(handleError);
      });

    // Ctrl+S / Cmd+S to save
    fileEditorInstance.addCommand(
      state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.KeyS,
      () => saveCurrentFile().catch(handleError),
    );
    return;
  }

  // Fallback: read-only text preview (when Monaco not ready yet)
  disposeFileEditor();
  elements.filePreview.innerHTML = `
    <article class="file-preview-card">
      <div class="file-preview-header">
        <h2 class="file-preview-title">${escapeHtml(name)}</h2>
        <span class="file-preview-badge">${escapeHtml(extension.toUpperCase().replace(/^\./, ""))}</span>
      </div>
      <pre class="file-preview-text"><code>${escapeHtml(content ?? "")}</code></pre>
    </article>
  `;
}

// ── Global (workspace-level) env vars ────────────────────────────────────────
// Stored in localStorage so they persist without a notebook open.
// When a notebook loads, any key from globalEnv that doesn't already exist
// in the notebook's own env is merged in automatically.
function loadGlobalEnv() {
  try {
    return JSON.parse(localStorage.getItem("marsbook-global-env") || "{}");
  } catch {
    return {};
  }
}
function saveGlobalEnv(env) {
  localStorage.setItem("marsbook-global-env", JSON.stringify(env));
}

function getEnvTarget() {
  // Returns { env, isGlobal } — env is the mutable object to read/write.
  if (state.notebook) {
    ensureNotebookMetadata();
    if (!state.notebook.metadata.env) state.notebook.metadata.env = {};
    return { env: state.notebook.metadata.env, isGlobal: false };
  }
  const g = loadGlobalEnv();
  return { env: g, isGlobal: true };
}

function getNotebookEnvEntries() {
  const { env } = getEnvTarget();
  return Object.entries(env);
}

function hasGroqKeyConfigured() {
  return Boolean(
    state.notebook?.metadata?.env?.GROQ_API_KEY?.trim() ||
    state.aiAssistantHasKey,
  );
}

function renderEnvPanel() {
  elements.envPanel?.classList.toggle("is-open", state.envPanelOpen);
  elements.envModalScrim?.classList.toggle("is-open", state.envPanelOpen);
  elements.envList.innerHTML = "";
  const { isGlobal } = getEnvTarget();
  const entries = getNotebookEnvEntries();
  const tableHeader = document.querySelector("#env-table-header");
  if (tableHeader) tableHeader.classList.toggle("hidden", entries.length === 0);

  // Show a banner when in global mode (no notebook open)
  let globalBanner = elements.envPanel?.querySelector(".env-global-banner");
  if (isGlobal) {
    if (!globalBanner) {
      globalBanner = document.createElement("div");
      globalBanner.className = "env-global-banner";
      globalBanner.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Global vars — applied to all notebooks`;
      elements.envList?.parentElement?.insertBefore(
        globalBanner,
        elements.envList,
      );
    }
  } else {
    globalBanner?.remove();
  }

  for (const [key, value] of entries) {
    const row = document.createElement("div");
    row.className = "env-row";

    // Key field
    const keyInput = document.createElement("input");
    keyInput.className = "env-key-input";
    keyInput.value = key;
    keyInput.placeholder = "VARIABLE_NAME";
    keyInput.setAttribute("autocomplete", "off");

    // Value field with show/hide toggle
    const valWrap = document.createElement("div");
    valWrap.className = "env-val-wrap";

    const valueInput = document.createElement("input");
    valueInput.className = "env-val-input";
    valueInput.value = value;
    valueInput.placeholder = "secret_value";
    valueInput.type = "password";
    valueInput.setAttribute("autocomplete", "off");

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "env-val-toggle";
    toggleBtn.title = "Show / hide value";
    toggleBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    toggleBtn.addEventListener("click", () => {
      const shown = valueInput.type === "text";
      valueInput.type = shown ? "password" : "text";
      toggleBtn.classList.toggle("is-active", !shown);
    });
    valWrap.append(valueInput, toggleBtn);

    const removeButton = document.createElement("button");
    removeButton.className = "env-remove-btn";
    removeButton.type = "button";
    removeButton.title = "Remove variable";
    removeButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    // Mark row dirty on change (visual feedback before Save)
    const markDirty = () => row.classList.add("env-row-dirty");
    keyInput.addEventListener("input", markDirty);
    valueInput.addEventListener("input", markDirty);

    removeButton.addEventListener("click", () => {
      const { env, isGlobal } = getEnvTarget();
      const updated = { ...env };
      delete updated[key];
      if (isGlobal) {
        saveGlobalEnv(updated);
      } else {
        state.notebook.metadata.env = updated;
        setDirty(true);
        queueAutoSave();
      }
      renderEnvPanel();
      if (state.aiAssistantOpen) renderAiAssistant();
    });

    row.append(keyInput, valWrap, removeButton);
    elements.envList.appendChild(row);
  }
}

function closeEnvPanel() {
  state.envPanelOpen = false;
  renderEnvPanel();
}

function renderAiAssistant() {
  const hasGroqKey = hasGroqKeyConfigured();
  elements.aiAssistantSheet?.classList.toggle("is-open", state.aiAssistantOpen);
  elements.aiModalScrim?.classList.toggle("is-open", state.aiAssistantOpen);
  elements.aiMissingKey.classList.toggle("hidden", hasGroqKey);
  elements.aiChatForm.classList.toggle("hidden", !hasGroqKey);
  elements.aiModelSelect.classList.toggle("hidden", !hasGroqKey);
  elements.aiModelSelect.innerHTML = "";

  for (const modelName of state.aiAssistantModels) {
    const option = document.createElement("option");
    option.value = modelName;
    option.textContent = modelName;
    option.selected = modelName === state.aiAssistantModel;
    elements.aiModelSelect.appendChild(option);
  }

  if (!hasGroqKey && !state.aiAssistantMessages.length) {
    elements.aiChatList.innerHTML = "";
    elements.aiChatList.style.display = "none";
  } else {
    // Reset any programmatic display:none set by a previous no-key render.
    // Without this, the flex:1 chat list stays hidden and the input form
    // floats to the top of the sheet instead of sitting at the bottom.
    elements.aiChatList.style.display = "";
    renderAiChatMessages();
  }

  const activeCell = state.notebook?.cells.find(
    (cell) => cell.id === state.aiAssistantCellId,
  );
  elements.aiSheetSubtitle.textContent = activeCell
    ? `Ask about ${activeCell.type} cell`
    : "Ask about the active cell";
  elements.aiSendButton.disabled = !hasGroqKey || state.aiAssistantLoading;
  elements.aiChatInput.disabled = !hasGroqKey || state.aiAssistantLoading;
  elements.aiModelSelect.disabled = !hasGroqKey || state.aiAssistantLoading;
  elements.aiSendButton.textContent = state.aiAssistantLoading
    ? "Thinking..."
    : "Send";
  elements.aiChatList.scrollTop = elements.aiChatList.scrollHeight;
}

/* ═══════════════════════════════════════════════════════
   GLOBAL TERMINAL
═══════════════════════════════════════════════════════ */

function updateTerminalCwd() {
  const cwd = state.terminalCwd ?? "";
  if (elements.terminalCwdLabel)
    elements.terminalCwdLabel.textContent = cwd || "~";
}

function openTerminal() {
  state.terminalOpen = true;
  if (!state.terminalCwd) {
    state.terminalCwd = state.workspaceRoot ?? null;
  }
  elements.terminalSheet?.classList.add("is-open");
  elements.terminalScrim?.classList.add("is-open");
  document
    .querySelectorAll(".terminal-open-btn")
    .forEach((b) => b.classList.add("is-active"));
  updateTerminalCwd();
  renderTerminalHistory();
  // Focus input after slide-in animation
  setTimeout(() => elements.terminalInput?.focus(), 320);
}

function closeTerminal() {
  state.terminalOpen = false;
  elements.terminalSheet?.classList.remove("is-open");
  elements.terminalScrim?.classList.remove("is-open");
  document
    .querySelectorAll(".terminal-open-btn")
    .forEach((b) => b.classList.remove("is-active"));
}

function toggleTerminal() {
  if (state.terminalOpen) closeTerminal();
  else openTerminal();
}

function renderTerminalHistory() {
  if (!elements.terminalHistoryEl) return;
  if (state.terminalHistory.length === 0) {
    elements.terminalHistoryEl.innerHTML = `<div class="terminal-welcome">Type a command and press Enter or Run</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of state.terminalHistory) {
    const div = document.createElement("div");
    div.className = "terminal-entry";

    const cmdLine = document.createElement("div");
    cmdLine.className = "terminal-cmd-line";
    cmdLine.innerHTML = `<span class="terminal-cmd-prompt">$</span><span class="terminal-cmd-text">${escapeHtml(entry.command)}</span>`;
    div.appendChild(cmdLine);

    const outputEl = document.createElement("pre");
    outputEl.className =
      "terminal-output-text" +
      (entry.running ? " is-running" : entry.ok ? "" : " is-error");
    outputEl.textContent = entry.running
      ? "Running…"
      : entry.output || "(no output)";
    div.appendChild(outputEl);

    fragment.appendChild(div);
  }

  elements.terminalHistoryEl.innerHTML = "";
  elements.terminalHistoryEl.appendChild(fragment);
  // Auto-scroll to bottom
  elements.terminalHistoryEl.scrollTop =
    elements.terminalHistoryEl.scrollHeight;
}

async function runTerminalCommand(command) {
  const cmd = command.trim();
  if (!cmd) return;

  // Handle clear / cls locally — same as clicking the Clear button
  if (cmd === "clear" || cmd === "cls") {
    state.terminalHistory = [];
    state.terminalHistoryIdx = -1;
    if (elements.terminalInput) elements.terminalInput.value = "";
    renderTerminalHistory();
    return;
  }

  // Add to command history (deduplicated, newest first, max 100)
  state.terminalCmdHistory = [
    cmd,
    ...state.terminalCmdHistory.filter((c) => c !== cmd),
  ].slice(0, 100);
  state.terminalHistoryIdx = -1;

  // Push entry with running state immediately
  const entry = { command: cmd, output: "", ok: true, running: true };
  state.terminalHistory.push(entry);
  if (elements.terminalInput) elements.terminalInput.value = "";
  renderTerminalHistory();

  try {
    const result = await api("/api/shell", {
      method: "POST",
      body: JSON.stringify({
        path: state.activePath ?? state.notebookPath,
        command: cmd,
        cwd: state.terminalCwd, // send persistent CWD so server uses it
      }),
    });

    // Update CWD from server response (handles cd and any other cwd changes)
    if (typeof result.cwd === "string" && result.cwd) {
      state.terminalCwd = result.cwd;
      updateTerminalCwd();
    }

    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    entry.output = output;
    entry.ok = result.ok;
    entry.running = false;

    // If modules changed (e.g. npm install), reload suggestions
    if (result.modules) {
      state.modules = result.modules;
      state.installedPackages =
        result.installedPackages ?? state.installedPackages;
      await loadSuggestions();
    }
  } catch (error) {
    entry.output = error?.message ?? String(error);
    entry.ok = false;
    entry.running = false;
  }

  renderTerminalHistory();
}

/* ─────────────────────────────────────────────────────── */

function closeAiAssistant() {
  state.aiAssistantOpen = false;
  state.aiAssistantLoading = false;
  renderAiAssistant();
}

async function loadAiAssistantConfig() {
  if (!isNotebookView()) return;

  const data = await api(
    `/api/ai/config?path=${encodeURIComponent(state.notebookPath)}`,
  );
  state.aiAssistantHasKey = Boolean(data.hasGroqKey);
  state.aiAssistantModels = data.models ?? [];
  state.aiAssistantModel =
    data.defaultModel ?? state.aiAssistantModels[0] ?? state.aiAssistantModel;
}

async function openAiAssistant(cellId) {
  state.aiAssistantOpen = true;
  state.aiAssistantCellId = cellId;
  state.aiAssistantMessages = [];
  await loadAiAssistantConfig();
  renderAiAssistant();
}

async function sendAiAssistantMessage() {
  const content = elements.aiChatInput.value.trim();
  if (!content || !hasGroqKeyConfigured() || state.aiAssistantLoading) return;

  const cell = state.notebook?.cells.find(
    (item) => item.id === state.aiAssistantCellId,
  );
  const source =
    cell?.type === "code"
      ? (modelInstances.get(cell.id)?.getValue() ?? cell.source)
      : (cell?.source ?? "");

  state.aiAssistantMessages = [
    ...state.aiAssistantMessages,
    { role: "user", content },
  ];
  // Add a placeholder assistant message that we'll stream into
  state.aiAssistantMessages = [
    ...state.aiAssistantMessages,
    { role: "assistant", content: "" },
  ];
  state.aiAssistantLoading = true;
  elements.aiChatInput.value = "";
  renderAiAssistant();

  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: state.notebookPath,
        cellType: cell?.type ?? "code",
        source,
        // Send all messages except the blank placeholder we just pushed
        messages: state.aiAssistantMessages.slice(0, -1),
        model: state.aiAssistantModel,
        env: state.notebook?.metadata?.env ?? {},
      }),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "Request failed");
      throw new Error(errText);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    const TOKEN_SENTINEL = "\x02TOKEN_USAGE:";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });

      // Strip token-usage sentinel if present (we don't show it in UI)
      const sentinelIdx = accumulated.indexOf(TOKEN_SENTINEL);
      if (sentinelIdx !== -1) {
        accumulated = accumulated.slice(0, sentinelIdx);
      }

      // Update the last (placeholder) assistant message with accumulated text
      const msgs = [...state.aiAssistantMessages];
      msgs[msgs.length - 1] = { role: "assistant", content: accumulated };
      state.aiAssistantMessages = msgs;

      // Re-render just the chat list for live streaming effect
      renderAiChatMessages();
    }
  } catch (err) {
    // Replace placeholder with error message
    const msgs = [...state.aiAssistantMessages];
    msgs[msgs.length - 1] = {
      role: "assistant",
      content: `⚠️ Error: ${err.message}`,
    };
    state.aiAssistantMessages = msgs;
  } finally {
    state.aiAssistantLoading = false;
    renderAiAssistant();
  }
}

/** Re-render only the message list portion (used during streaming to avoid full re-render). */
function renderAiChatMessages() {
  if (!elements.aiChatList) return;
  elements.aiChatList.innerHTML = "";

  if (!state.aiAssistantMessages.length) {
    const empty = document.createElement("div");
    empty.className = "ai-chat-empty";
    empty.textContent = "Start a conversation about the active cell.";
    elements.aiChatList.appendChild(empty);
    return;
  }

  for (const message of state.aiAssistantMessages) {
    const row = document.createElement("div");
    row.className = `ai-chat-row is-${message.role}`;

    const label = document.createElement("div");
    label.className = "ai-chat-role";
    label.textContent = message.role === "assistant" ? "Assistant" : "You";

    const bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble rendered-markdown";
    // Show a blinking cursor while streaming the last assistant message
    const isStreamingThis =
      state.aiAssistantLoading &&
      message ===
        state.aiAssistantMessages[state.aiAssistantMessages.length - 1] &&
      message.role === "assistant";
    bubble.innerHTML =
      renderMarkdown(message.content || "") +
      (isStreamingThis ? '<span class="ai-stream-cursor"></span>' : "");

    row.append(label, bubble);
    elements.aiChatList.appendChild(row);
  }

  elements.aiChatList.scrollTop = elements.aiChatList.scrollHeight;
}

function updatePackagesDrawer() {
  // Packages are now shown on the dedicated packages page — no inline drawer
}

function showToast(message, tone = "success") {
  const ICONS = {
    success: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    info: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    warning: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };
  const LABELS = {
    success: "Success",
    error: "Error",
    info: "Info",
    warning: "Warning",
  };
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.innerHTML = `
    <div class="toast-icon">${ICONS[tone] ?? ICONS.info}</div>
    <div class="toast-body">
      <div class="toast-title">${LABELS[tone] ?? tone}</div>
      <div class="toast-message">${message}</div>
    </div>`;
  elements.toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4000);
}

function closeConfirmModal() {
  elements.confirmModal?.classList.remove("is-open");
  elements.confirmScrim?.classList.remove("is-open");
}

/** Promise-based confirm dialog (centered modal). */
function confirmAction({
  title,
  message,
  confirmLabel = "Confirm",
  tone = "danger",
} = {}) {
  if (!elements.confirmModal) return Promise.resolve(false);

  elements.confirmTitle.textContent = title || "Are you sure?";
  elements.confirmMessage.textContent = message || "";
  elements.confirmConfirm.textContent = confirmLabel;
  elements.confirmConfirm.classList.toggle("is-danger", tone === "danger");

  elements.confirmModal.classList.add("is-open");
  elements.confirmScrim?.classList.add("is-open");
  const prevActive = document.activeElement;
  elements.confirmCancel?.focus();

  return new Promise((resolve) => {
    const cleanup = () => {
      closeConfirmModal();
      elements.confirmCancel?.removeEventListener("click", onCancel);
      elements.confirmConfirm?.removeEventListener("click", onConfirm);
      elements.confirmScrim?.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      prevActive?.focus?.();
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onConfirm = () => {
      cleanup();
      resolve(true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (
        e.key === "Enter" &&
        elements.confirmModal?.classList.contains("is-open")
      ) {
        e.preventDefault();
        onConfirm();
      }
    };
    elements.confirmCancel?.addEventListener("click", onCancel);
    elements.confirmConfirm?.addEventListener("click", onConfirm);
    elements.confirmScrim?.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

/* ===== FILE TREE ===== */
async function loadDirectory(directoryPath = state.workspaceRoot ?? "") {
  const queryPath = directoryPath || "";
  const data = await api(`/api/files?path=${encodeURIComponent(queryPath)}`);
  state.workspaceRoot = data.rootPath;
  directoryCache.set(data.directoryPath, data.entries);
  expandedDirectories.add(data.directoryPath);
}

async function ensureFileVisible(filePath) {
  if (!state.workspaceRoot || !filePath.startsWith(state.workspaceRoot)) return;

  const directories = [];
  let currentDirectory = dirname(filePath);

  while (currentDirectory.startsWith(state.workspaceRoot)) {
    directories.unshift(currentDirectory);
    if (currentDirectory === state.workspaceRoot) break;
    currentDirectory = dirname(currentDirectory);
  }

  for (const directoryPath of directories) {
    expandedDirectories.add(directoryPath);
    if (!directoryCache.has(directoryPath)) {
      await loadDirectory(directoryPath);
    }
  }
}

function renderTreeEntries(container, entries, depth) {
  for (const entry of entries) {
    const group = document.createElement("div");
    group.className = "file-tree-group";

    const row = document.createElement("div");
    row.className = "file-tree-row";
    row.classList.toggle("is-openable", entry.openable || entry.expandable);
    row.classList.toggle("is-active", entry.path === state.activePath);

    for (let level = 0; level < depth; level += 1) {
      const indent = document.createElement("span");
      indent.className = "file-tree-indent";
      row.appendChild(indent);
    }

    const chevron = document.createElement("span");
    chevron.className = "file-tree-chevron";
    chevron.textContent = entry.expandable
      ? expandedDirectories.has(entry.path)
        ? "\u25BE"
        : "\u25B8"
      : "";
    row.appendChild(chevron);

    const label = document.createElement("span");
    label.className = "file-tree-name";
    label.textContent = entry.name;
    row.appendChild(label);

    row.addEventListener("click", async () => {
      try {
        if (entry.expandable) {
          if (expandedDirectories.has(entry.path)) {
            expandedDirectories.delete(entry.path);
            renderFileTree();
            return;
          }
          await loadDirectory(entry.path);
          return;
        }

        if (entry.openable) {
          await openResource(entry.path);
          await ensureFileVisible(entry.path);
          if (isCompactViewport()) setSidebarOpen(false);
          renderFileTree();
          return;
        }

        showToast(
          "Only notebooks, images, text, .js, .ts, and PDFs can be opened",
          "error",
        );
      } catch (error) {
        handleError(error);
      }
    });

    group.appendChild(row);

    if (entry.expandable && expandedDirectories.has(entry.path)) {
      const children = directoryCache.get(entry.path) ?? [];
      const childrenContainer = document.createElement("div");
      childrenContainer.className = "file-tree-children";
      renderTreeEntries(childrenContainer, children, depth + 1);
      group.appendChild(childrenContainer);
    }

    container.appendChild(group);
  }
}

function renderFileTree() {
  // File tree replaced by notebook list panel — no-op
}

function ensureNotebookMetadata() {
  if (!state.notebook) return;
  if (!state.notebook.metadata || typeof state.notebook.metadata !== "object") {
    state.notebook.metadata = {};
  }
  if (
    !state.notebook.metadata.ai ||
    typeof state.notebook.metadata.ai !== "object"
  ) {
    state.notebook.metadata.ai = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
    };
  }
  if (
    !state.notebook.metadata.env ||
    typeof state.notebook.metadata.env !== "object"
  ) {
    state.notebook.metadata.env = {};
  }
}

function getMarkdownMode(cellId) {
  return markdownModes.get(cellId) ?? "preview";
}

function setMarkdownMode(cellId, mode) {
  markdownModes.set(cellId, mode);
}

/* ===== API ===== */
async function api(requestPath, options = {}) {
  const response = await fetch(requestPath, {
    headers: { "content-type": "application/json" },
    ...options,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

/* ===== MONACO ===== */
function extractNotebookSymbols() {
  const symbols = new Set([
    "Array",
    "Buffer",
    "console",
    "fetch",
    "globalThis",
    "JSON",
    "Map",
    "Math",
    "Object",
    "process",
    "Promise",
    "require",
    "Set",
    "URL",
  ]);

  const pattern = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;

  for (const cell of state.notebook?.cells ?? []) {
    if (cell.type !== "code") continue;
    let match;
    while ((match = pattern.exec(cell.source))) {
      symbols.add(match[1]);
    }
  }

  for (const moduleName of state.modules) {
    symbols.add(moduleName);
  }

  return Array.from(symbols);
}


function getCurrentLinePrefix(model, position) {
  return model
    .getLineContent(position.lineNumber)
    .slice(0, position.column - 1);
}

function getModulePathContext(model, position) {
  const linePrefix = getCurrentLinePrefix(model, position);
  const modulePathMatch = linePrefix.match(
    /(?:from\s+|import\s*\(\s*)["']([@\w./-]*)$/,
  );

  if (!modulePathMatch) return null;

  const fragment = modulePathMatch[1] ?? "";
  const startColumn = position.column - fragment.length;

  return {
    fragment,
    range: new state.monaco.Range(
      position.lineNumber,
      startColumn,
      position.lineNumber,
      position.column,
    ),
  };
}

function getImportInsertionEdits(model, suggestion) {
  const source = model.getValue();
  const importStatement = suggestion.isDefault
    ? `import ${suggestion.importName} from "${suggestion.moduleName}";\n`
    : `import { ${suggestion.exportName === suggestion.importName ? suggestion.exportName : `${suggestion.exportName} as ${suggestion.importName}`} } from "${suggestion.moduleName}";\n`;

  const sameModulePattern = new RegExp(
    `^import\\s+([^;]+)\\s+from\\s+["']${suggestion.moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'];?\\s*$`,
    "m",
  );
  const sameModuleMatch = source.match(sameModulePattern);

  if (sameModuleMatch) {
    const fullImport = sameModuleMatch[0];
    if (fullImport.includes(suggestion.importName)) {
      return [];
    }

    if (!suggestion.isDefault) {
      const bracesMatch = fullImport.match(/\{([^}]*)\}/);
      if (bracesMatch) {
        const existingParts = bracesMatch[1]
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        const nextPart =
          suggestion.exportName === suggestion.importName
            ? suggestion.exportName
            : `${suggestion.exportName} as ${suggestion.importName}`;
        existingParts.push(nextPart);
        existingParts.sort((left, right) => left.localeCompare(right));
        const updatedImport = fullImport.replace(
          /\{([^}]*)\}/,
          `{ ${existingParts.join(", ")} }`,
        );
        const startOffset = sameModuleMatch.index ?? 0;
        const endOffset = startOffset + fullImport.length;
        const startPos = model.getPositionAt(startOffset);
        const endPos = model.getPositionAt(endOffset);

        return [
          {
            range: new state.monaco.Range(
              startPos.lineNumber,
              startPos.column,
              endPos.lineNumber,
              endPos.column,
            ),
            text: updatedImport,
          },
        ];
      }

      const defaultOnlyMatch = fullImport.match(
        /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["'];?$/,
      );
      if (defaultOnlyMatch) {
        const nextPart =
          suggestion.exportName === suggestion.importName
            ? suggestion.exportName
            : `${suggestion.exportName} as ${suggestion.importName}`;
        const updatedImport = fullImport.replace(
          /^import\s+([A-Za-z_$][\w$]*)\s+from\s+/,
          `import $1, { ${nextPart} } from `,
        );
        const startOffset = sameModuleMatch.index ?? 0;
        const endOffset = startOffset + fullImport.length;
        const startPos = model.getPositionAt(startOffset);
        const endPos = model.getPositionAt(endOffset);

        return [
          {
            range: new state.monaco.Range(
              startPos.lineNumber,
              startPos.column,
              endPos.lineNumber,
              endPos.column,
            ),
            text: updatedImport,
          },
        ];
      }
    }

    return [];
  }

  const importMatches = [...source.matchAll(/^import[\s\S]*?;?\s*$/gm)];
  const insertionOffset =
    importMatches.length > 0
      ? (importMatches.at(-1).index ?? 0) + importMatches.at(-1)[0].length
      : 0;
  const insertionPosition = model.getPositionAt(insertionOffset);

  return [
    {
      range: new state.monaco.Range(
        insertionPosition.lineNumber,
        insertionPosition.column,
        insertionPosition.lineNumber,
        insertionPosition.column,
      ),
      text: `${importStatement}${insertionOffset > 0 ? "" : "\n"}`,
    },
  ];
}

function getPackageExportCompletionKind(kind) {
  const { CompletionItemKind } = state.monaco.languages;

  switch (kind) {
    case "class":
      return CompletionItemKind.Class;
    case "function":
      return CompletionItemKind.Function;
    case "interface":
    case "type":
      return CompletionItemKind.Interface;
    case "enum":
      return CompletionItemKind.Enum;
    case "variable":
    case "default":
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Module;
  }
}

function getNotebookBaseDirectory() {
  return state.notebookPath.startsWith("/")
    ? dirname(state.notebookPath)
    : `${state.workspaceRoot}/${dirname(state.notebookPath)}`;
}

function getNotebookSupportUri(fileName) {
  return `file:///node_modules/.nodebook-types/${fileName}`;
}

function getNotebookModelUri(cellId, language = "typescript") {
  // Place models under file:///notebook/cells/ — a clean virtual root.
  // TypeScript's node_modules resolution walks up two hops to file:///node_modules/,
  // which is exactly where the server places all type declaration virtual files.
  // Using the real absolute path would require walking through the user's entire
  // directory tree before reaching the virtual node_modules root.
  const ext = language === "javascript" ? "mjs" : "ts";
  return state.monaco.Uri.parse(`file:///notebook/cells/${cellId}.${ext}`);
}

/**
 * Extracts brace-delimited blocks (interface / enum / class bodies) from source.
 * Returns the full raw text of each block found at or after `startOffset`.
 */
function extractBraceBlock(source, startOffset) {
  let depth = 0;
  let started = false;
  let i = startOffset;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
      started = true;
    } else if (ch === "}") {
      depth--;
      if (started && depth === 0) return source.slice(startOffset, i + 1);
    }
    i++;
  }

  return null;
}

/**
 * Extracts all TypeScript type-level declarations from a cell source:
 * interfaces, type aliases, enums, and re-emits them as ambient declarations.
 */
function extractTypeDeclarations(source) {
  const result = [];

  // interface Foo<T> { ... }  (may be exported)
  const ifaceRe =
    /(?:^|(?<=\n))(?:export\s+)?interface\s+(\w[\w$]*)\s*(?:<[^{]*>)?\s*(?:extends[^{]*)?\{/gm;
  let m;

  while ((m = ifaceRe.exec(source)) !== null) {
    const block = extractBraceBlock(source, m.index + m[0].length - 1);
    if (block) {
      // Strip leading export keyword so it works as ambient declaration
      const raw = source.slice(
        m.index,
        m.index + m[0].length - 1 + block.length,
      );
      result.push(raw.replace(/^export\s+/, ""));
    }
  }

  // type Foo = ...;  (single or multi-line, terminated by ; or end-of-block)
  const typeRe =
    /(?:^|(?<=\n))(?:export\s+)?type\s+(\w[\w$]*)\s*(?:<[^=]*>)?\s*=[^;{]*/gm;

  while ((m = typeRe.exec(source)) !== null) {
    // Find the ; that ends this type alias
    const afterEq = source.indexOf("=", m.index);
    let end = source.indexOf(";", afterEq);
    if (end === -1) end = source.indexOf("\n", afterEq);
    if (end === -1) end = source.length;

    const raw = source.slice(m.index, end + 1);
    if (!raw.includes("\n\n")) {
      // Skip multi-paragraph blocks (likely not a simple type alias)
      result.push(
        raw.trim().replace(/^export\s+/, "") +
          (raw.trim().endsWith(";") ? "" : ";"),
      );
    }
  }

  // enum Foo { ... }
  const enumRe =
    /(?:^|(?<=\n))(?:export\s+)?(?:const\s+)?enum\s+(\w[\w$]*)\s*\{/gm;

  while ((m = enumRe.exec(source)) !== null) {
    const block = extractBraceBlock(source, m.index + m[0].length - 1);
    if (block) {
      const raw = source.slice(
        m.index,
        m.index + m[0].length - 1 + block.length,
      );
      result.push(raw.replace(/^export\s+/, "").replace(/^const\s+/, ""));
    }
  }

  return result;
}

function buildCrossCellDeclarations(excludeCellId, cellMetadata = null) {
  if (!state.notebook) return "";

  const declarations = [];
  const seen = new Set();
  const metadataEntries =
    cellMetadata ??
    state.notebook.cells
      .filter((cell) => cell.type === "code")
      .map((cell) => {
        const source = modelInstances.get(cell.id)?.getValue() ?? cell.source;
        return {
          cellId: cell.id,
          source,
          bindings: collectCrossCellBindingsFallback(source),
        };
      });

  for (const metadata of metadataEntries) {
    if (metadata.cellId === excludeCellId) continue;

    const source = metadata.source;
    if (!source.trim()) continue;

    // ── 1. Type-level declarations: interfaces, type aliases, enums ──────────
    for (const decl of extractTypeDeclarations(source)) {
      declarations.push(decl);
    }
  }

  // Prefer the most recent binding when a name is reused across cells.
  for (const metadata of [...metadataEntries].reverse()) {
    if (metadata.cellId === excludeCellId) continue;
    if (!metadata.source.trim()) continue;

    for (const binding of metadata.bindings ?? []) {
      const name = binding.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const importPath = getNotebookSupportCellImportPath(metadata.cellId);
      if (binding.kind === "class") {
        declarations.push(`var ${name}: typeof import("${importPath}").${name};`);
        declarations.push(
          `type ${name} = InstanceType<typeof import("${importPath}").${name}>;`,
        );
        continue;
      }

      declarations.push(`var ${name}: typeof import("${importPath}").${name};`);
    }
  }

  if (declarations.length === 0) return "";

  // ── Wrap in declare global so all declarations are visible in TypeScript
  // module-mode files.  With moduleDetection:Force every .ts cell is an ES
  // module.  Plain ambient globals in addExtraLib are only guaranteed to be
  // visible in script-mode files; wrapping with `export {}; declare global {}`
  // makes them globally accessible even from module-mode TypeScript. ─────────
  const indented = declarations
    .map((d) =>
      d
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
    .join("\n");
  return `export {};\ndeclare global {\n${indented}\n}`;
}

// Holds disposables for only the cross-cell declarations extra lib so it can be
// swapped cheaply without rebuilding the heavier package-type libs.
let _crossCellLibTs = null;
let _crossCellLibJs = null;
let _crossCellRefreshVersion = 0;
const _crossCellSupportLibsTs = [];
const _crossCellSupportLibsJs = [];

function getNotebookSupportCellModuleUri(cellId, language = "typescript") {
  const ext = language === "javascript" ? "js" : "ts";
  return getNotebookSupportUri(`cells/${cellId}.${ext}`);
}

function getNotebookSupportCellImportPath(cellId) {
  return `./cells/${cellId}`;
}

function addCrossCellSupportLib(content, uri) {
  _crossCellSupportLibsTs.push(
    state.monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri),
  );
  _crossCellSupportLibsJs.push(
    state.monaco.languages.typescript.javascriptDefaults.addExtraLib(content, uri),
  );
}

function disposeCrossCellSupportLibs() {
  while (_crossCellSupportLibsTs.length) {
    _crossCellSupportLibsTs.pop().dispose();
  }
  while (_crossCellSupportLibsJs.length) {
    _crossCellSupportLibsJs.pop().dispose();
  }
}

function collectCrossCellBindingsFallback(source) {
  const bindings = [];
  const seen = new Set();

  const addBinding = (name, kind, exported = false) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    bindings.push({ name, kind, exported });
  };

  const importPattern =
    /(?:^|(?<=\n))(export\s+)?import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm;
  let match;

  while ((match = importPattern.exec(source)) !== null) {
    const exported = Boolean(match[1]);
    const importClause = match[2].trim();
    if (importClause.startsWith("type ")) continue;

    if (!importClause.startsWith("{") && !importClause.startsWith("*")) {
      const defaultMatch = importClause.match(/^([A-Za-z_$][\w$]*)/);
      if (defaultMatch && defaultMatch[1] !== "type") {
        addBinding(defaultMatch[1], "alias", exported);
      }
    }

    const namedBlockMatch = importClause.match(/\{([^}]+)\}/);
    if (namedBlockMatch) {
      for (const part of namedBlockMatch[1].split(",")) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith("type ")) continue;
        const [orig, alias] = trimmed.split(/\s+as\s+/);
        const localName = (alias || orig).trim();
        addBinding(localName, "alias", exported);
      }
    }

    const namespaceMatch = importClause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch) {
      addBinding(namespaceMatch[1], "alias", exported);
    }
  }

  const variablePattern =
    /(?:^|(?<=\n))(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm;
  while ((match = variablePattern.exec(source)) !== null) {
    addBinding(match[2], "const", Boolean(match[1]));
  }

  const functionPattern =
    /(?:^|(?<=\n))(export\s+)?function\s+([A-Za-z_$][\w$]*)\b/gm;
  while ((match = functionPattern.exec(source)) !== null) {
    addBinding(match[2], "function", Boolean(match[1]));
  }

  const classPattern =
    /(?:^|(?<=\n))(export\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm;
  while ((match = classPattern.exec(source)) !== null) {
    addBinding(match[2], "class", Boolean(match[1]));
  }

  return bindings;
}

function collectCrossCellBindingsFromNavigationTree(tree) {
  const bindings = [];
  const seen = new Set();

  for (const item of tree?.childItems ?? []) {
    const name = item?.text;
    const kind = item?.kind;
    if (!name || seen.has(name)) continue;
    if (String(item.kindModifiers ?? "").includes("type")) continue;
    if (!["alias", "const", "let", "var", "function", "class"].includes(kind)) {
      continue;
    }
    seen.add(name);
    bindings.push({
      name,
      kind,
      exported: String(item.kindModifiers ?? "").includes("export"),
    });
  }

  return bindings;
}

function buildCrossCellSupportPreamble(currentBindingNames, visibleMetadata) {
  const prelude = [];
  const seen = new Set(currentBindingNames);

  // Walk backwards so the nearest previous cell wins for shadowed names.
  for (const metadata of [...visibleMetadata].reverse()) {
    // Support modules all live in the same virtual directory
    // (file:///node_modules/.nodebook-types/cells/<cellId>.ts), so a peer
    // support module is simply "./<cellId>" — NOT "./cells/<cellId>", which
    // would incorrectly resolve to the non-existent "…/cells/cells/<cellId>"
    // path and make TypeScript fall back to `any` for every cross-cell type.
    const importPath = `./${metadata.cellId}`;

    for (const binding of metadata.bindings ?? []) {
      const name = binding.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      if (binding.kind === "class") {
        prelude.push(`declare const ${name}: typeof import("${importPath}").${name};`);
        prelude.push(
          `type ${name} = InstanceType<typeof import("${importPath}").${name}>;`,
        );
        continue;
      }

      prelude.push(`declare const ${name}: typeof import("${importPath}").${name};`);
    }
  }

  return prelude.join("\n");
}

function buildCrossCellSupportModuleSource(source, bindings, visibleMetadata = []) {
  const currentBindingNames = new Set((bindings ?? []).map((binding) => binding.name));
  const prelude = buildCrossCellSupportPreamble(
    currentBindingNames,
    visibleMetadata,
  );
  const exportNames = bindings
    .filter((binding) => !binding.exported)
    .map((binding) => binding.name);

  const sourceBody = source.trimEnd();
  const exportBlock =
    exportNames.length > 0 ? `export { ${exportNames.join(", ")} };` : "";
  const parts = [prelude, sourceBody, exportBlock].filter(Boolean);

  if (parts.length === 0) return "";
  return `${parts.join("\n\n")}\n`;
}

async function collectCrossCellMetadata(cell) {
  const source = modelInstances.get(cell.id)?.getValue() ?? cell.source;
  const language = getCellLanguage(cell);
  const fallbackBindings = collectCrossCellBindingsFallback(source);
  let bindings = fallbackBindings;

  const model = modelInstances.get(cell.id);
  const tsApi = state.monaco?.languages?.typescript;

  if (model && tsApi) {
    try {
      const workerAccessor =
        language === "javascript"
          ? tsApi.getJavaScriptWorker
          : tsApi.getTypeScriptWorker;
      if (typeof workerAccessor === "function") {
        const workerFactory = await workerAccessor();
        const worker = await workerFactory(model.uri);
        const tree = await worker.getNavigationTree(model.uri.toString());
        const treeBindings = collectCrossCellBindingsFromNavigationTree(tree);
        if (treeBindings.length > 0) {
          bindings = treeBindings;
        }
      }
    } catch {
      // Fall back to the lightweight regex collector when the worker is not ready.
    }
  }

  return {
    cellId: cell.id,
    source,
    language,
    bindings,
  };
}

/**
 * Lightweight refresh: only rebuilds the cross-cell declarations lib.
 * Called on every keystroke (debounced 300 ms). Does NOT touch package-type
 * libs, so Monaco's TypeScript worker doesn't have to re-index npm types.
 */
async function refreshCrossCellDeclarations() {
  if (!state.monacoReady || !state.notebook) return;

  const refreshVersion = ++_crossCellRefreshVersion;
  const cellMetadata = await Promise.all(
    state.notebook.cells
      .filter((cell) => cell.type === "code")
      .map((cell) => collectCrossCellMetadata(cell)),
  );

  if (refreshVersion !== _crossCellRefreshVersion) return;

  _crossCellLibTs?.dispose();
  _crossCellLibJs?.dispose();
  _crossCellLibTs = null;
  _crossCellLibJs = null;
  disposeCrossCellSupportLibs();

  for (const [index, metadata] of cellMetadata.entries()) {
    const supportModuleSource = buildCrossCellSupportModuleSource(
      metadata.source,
      metadata.bindings,
      cellMetadata.slice(0, index),
    );
    if (!supportModuleSource.trim()) continue;
    addCrossCellSupportLib(
      supportModuleSource,
      getNotebookSupportCellModuleUri(metadata.cellId, metadata.language),
    );
  }

  const dts = buildCrossCellDeclarations(null, cellMetadata);
  if (!dts) return;

  const uri = getNotebookSupportUri("cross-cell-context.d.ts");
  _crossCellLibTs =
    state.monaco.languages.typescript.typescriptDefaults.addExtraLib(
      dts,
      uri,
    );
  _crossCellLibJs =
    state.monaco.languages.typescript.javascriptDefaults.addExtraLib(
      dts,
      uri,
    );
}

function refreshMonacoLibraries() {
  if (!state.monacoReady) return;

  const addExtraLib = (content, filePath) => {
    monacoExtraLibs.push(
      state.monaco.languages.typescript.typescriptDefaults.addExtraLib(
        content,
        filePath,
      ),
    );
    monacoExtraLibs.push(
      state.monaco.languages.typescript.javascriptDefaults.addExtraLib(
        content,
        filePath,
      ),
    );
  };

  while (monacoExtraLibs.length) {
    monacoExtraLibs.pop().dispose();
  }
  // The cross-cell lib is managed separately — dispose it too so we get a clean slate
  _crossCellLibTs?.dispose();
  _crossCellLibTs = null;
  _crossCellLibJs?.dispose();
  _crossCellLibJs = null;
  disposeCrossCellSupportLibs();

  addExtraLib(NODE_GLOBALS_DTS, getNotebookSupportUri("node-globals.d.ts"));

  const typedModules = new Set();

  for (const typeLibrary of state.typeLibraries) {
    typedModules.add(typeLibrary.moduleName);
    addExtraLib(typeLibrary.content, typeLibrary.file);
  }

  // Build a reverse-lookup set: for every "@types/X" lib that is loaded, also
  // record "X" (or "@scope/Y" for "@types/scope__Y") as covered by types.
  // This lets addFallbackDecl() avoid adding a weak `declare module "express" { any }`
  // that would shadow the real @types/express declarations already registered above.
  const atTypesCompanionCovered = new Set();
  for (const moduleName of typedModules) {
    if (!moduleName.startsWith("@types/")) continue;
    const base = moduleName.slice("@types/".length); // e.g. "express" or "scope__pkg"
    if (base.includes("__")) {
      atTypesCompanionCovered.add("@" + base.replace("__", "/")); // → "@scope/pkg"
    } else {
      atTypesCompanionCovered.add(base); // → "express"
    }
  }

  const untypedDeclarations = [];
  const coveredByFallback = new Set();

  const addFallbackDecl = (moduleName) => {
    if (typedModules.has(moduleName) || coveredByFallback.has(moduleName))
      return;
    // Also skip if a @types/<name> companion package is already loaded.
    // Adding `declare module "express" { any }` would shadow the real @types/express
    // declarations that are registered as virtual node_modules files above.
    if (atTypesCompanionCovered.has(moduleName)) return;
    coveredByFallback.add(moduleName);
    untypedDeclarations.push(
      `declare module "${moduleName}" { const _default: any; export default _default; export = _default; }`,
    );
    // Also emit a bare-name alias for node: prefixed modules so both
    // `import fs from 'node:fs'` and `import fs from 'fs'` are covered.
    if (moduleName.startsWith("node:")) {
      const bareName = moduleName.slice(5);
      if (!typedModules.has(bareName) && !coveredByFallback.has(bareName)) {
        coveredByFallback.add(bareName);
        untypedDeclarations.push(
          `declare module "${bareName}" { const _default: any; export default _default; export = _default; }`,
        );
      }
    }
  };

  // Declared modules from the workspace's package.json
  for (const moduleName of state.modules) addFallbackDecl(moduleName);

  // Also cover every package the user has actually written an import/require for,
  // even if the package isn't listed in the workspace's package.json.
  // This ensures packages installed via npm install (without updating package.json),
  // or accessible via CommonJS require() from a parent node_modules, still get at
  // least a basic `any`-typed declaration so Monaco can resolve the import at all.
  if (state.notebook) {
    for (const moduleName of extractNotebookImports(state.notebook))
      addFallbackDecl(moduleName);
  }

  if (untypedDeclarations.length > 0) {
    addExtraLib(
      untypedDeclarations.join("\n"),
      getNotebookSupportUri("node-modules.d.ts"),
    );
  }

  // ── Local workspace files (.js/.ts — same dir, subdirs, and parent dir) ────
  // Each file's `name` is its import-ready relative path from the notebook dir:
  //   "utils.js"              → same directory  → import "./utils.js"
  //   "controller/app.js"     → subdirectory    → import "./controller/app.js"
  //   "../shared.js"          → parent dir      → import "../shared.js"
  //
  // Cell models live at  file:///notebook/cells/<cellId>.ts
  // File-editor models at file:///notebook/workspace/<relativePath>
  //
  // TypeScript resolves imports relative to the model's URI, so we must mirror
  // the same folder structure under each virtual root.
  //
  // For same-dir / subdir files (name = "controller/app.js"):
  //   • cell root     → file:///notebook/cells/controller/app.js
  //   • workspace root → file:///notebook/workspace/controller/app.js
  //
  // For parent-dir files (name = "../shared.js"):
  //   • cells/../     → file:///notebook/shared.js  (one level above cells/)
  //   • workspace/../ → file:///notebook/shared.js  (same resolved path)
  //   Both roots collapse to the same URI, so one registration covers both.
  for (const { name, content } of state.localFiles) {
    if (name.startsWith("../")) {
      // Parent-directory file: strip the "../" and register one level above the
      // virtual cell/workspace roots — both collapse to file:///notebook/<name>.
      const basename = name.slice(3);
      addExtraLib(content, `file:///notebook/${basename}`);
    } else {
      // Same directory or subdirectory: mirror path under both virtual roots.
      addExtraLib(content, `file:///notebook/cells/${name}`);
      addExtraLib(content, `file:///notebook/workspace/${name}`);
    }
  }

  // Add cross-cell declarations via the dedicated lightweight refresh
  refreshCrossCellDeclarations();
}

function registerCompletionProvider() {
  if (completionProvider || !state.monacoReady) return;

  const { CompletionItemKind, CompletionItemInsertTextRule } =
    state.monaco.languages;
  const Range = state.monaco.Range;

  const provider = {
    // Trigger on quote chars (import paths), @ (scoped packages), and word chars
    triggerCharacters: ["'", '"', "/", "@", "-"],

    provideCompletionItems(model, position) {
      const modulePathContext = getModulePathContext(model, position);
      const word = model.getWordUntilPosition(position);
      const range =
        modulePathContext?.range ??
        new Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
      const suggestions = [];
      const seen = new Set();

      const push = (s) => {
        if (seen.has(s.label)) return;
        seen.add(s.label);
        suggestions.push({ ...s, range });
      };

      // ── Module path completion (after from / require / import) ─────────────
      if (modulePathContext) {
        const frag = modulePathContext.fragment.toLowerCase();
        const isRelative = frag.startsWith(".");

        // Show local workspace files for relative imports (./ or ../)
        if (isRelative || frag === "") {
          for (const { name } of state.localFiles) {
            // Parent-dir files already start with "../"; everything else gets "./"
            const importPath = name.startsWith("../") ? name : `./${name}`;
            if (frag && !importPath.toLowerCase().startsWith(frag)) continue;

            push({
              label: importPath,
              kind: CompletionItemKind.File,
              insertText: importPath,
              detail: "Local file",
              documentation: { value: `\`import ... from '${importPath}'\`` },
              sortText: `0_${name}`,
            });
          }
        }

        // Show npm packages for non-relative imports
        if (!isRelative) {
          for (const moduleName of state.modules) {
            if (frag && !moduleName.toLowerCase().startsWith(frag)) continue;

            const isScoped = moduleName.startsWith("@");
            const isNode =
              moduleName.startsWith("node:") ||
              [
                "fs",
                "path",
                "os",
                "http",
                "https",
                "crypto",
                "events",
                "stream",
                "util",
                "url",
                "buffer",
                "child_process",
                "net",
                "readline",
                "assert",
                "zlib",
                "dns",
                "tls",
              ].includes(moduleName);

            push({
              label: moduleName,
              kind: CompletionItemKind.Module,
              insertText: moduleName,
              detail: isNode ? "Node.js built-in" : "Installed package",
              documentation: { value: `\`import ... from '${moduleName}'\`` },
              // Sort: node built-ins first, then regular, then scoped
              sortText: isNode
                ? `0_${moduleName}`
                : isScoped
                  ? `2_${moduleName}`
                  : `1_${moduleName}`,
            });
          }
        }

        return { suggestions };
      }

      const prefix = word.word.toLowerCase();

      // ── Package export completions with auto-import ────────────────────────
      // Show named exports (e.g. Router, Request from express) and insert the
      // import statement automatically via additionalTextEdits.
      if (prefix.length > 0) {
        for (const exportEntry of state.packageExports) {
          if (!exportEntry.exportName.toLowerCase().startsWith(prefix))
            continue;

          push({
            label: exportEntry.exportName,
            kind: getPackageExportCompletionKind(exportEntry.kind),
            insertText: exportEntry.importName,
            detail: `from "${exportEntry.moduleName}"`,
            documentation: {
              value: exportEntry.isDefault
                ? `\`import ${exportEntry.importName} from "${exportEntry.moduleName}"\``
                : `\`import { ${exportEntry.exportName} } from "${exportEntry.moduleName}"\``,
            },
            additionalTextEdits: getImportInsertionEdits(model, exportEntry),
            sortText: `5_${exportEntry.exportName}`,
          });
        }
      }

      // ── Supplementary notebook-symbol completions ──────────────────────────
      // Monaco's built-in TS IntelliSense handles types/methods/properties.
      // We only add symbols that might not be in Monaco's model (cross-cell vars).
      const symbols = extractNotebookSymbols();

      for (const symbol of symbols) {
        if (prefix && !symbol.toLowerCase().startsWith(prefix)) continue;

        push({
          label: symbol,
          kind: CompletionItemKind.Variable,
          insertText: symbol,
          detail: "Notebook variable",
          sortText: `9_${symbol}`,
        });
      }

      return { suggestions };
    },
  };

  completionProvider = state.monaco.languages.registerCompletionItemProvider(
    "typescript",
    provider,
  );
  javascriptCompletionProvider =
    state.monaco.languages.registerCompletionItemProvider(
      "javascript",
      provider,
    );
}

function initializeMonaco(monaco) {
  if (state.monacoReady) return;

  state.monaco = monaco;
  state.monacoReady = true;

  // After all web fonts have loaded, tell Monaco to re-measure character widths.
  // remeasureFonts() is the correct API — it flushes Monaco's internal glyph
  // width cache so cursor X position matches the actual rendered characters.
  document.fonts.ready.then(() => {
    monaco.editor.remeasureFonts();
  });

  // Register all 7 named themes
  for (const [id, def] of Object.entries(MONACO_THEME_DEFS)) {
    monaco.editor.defineTheme(id, def);
  }

  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    noUnusedLocals: false, // prevent TS6133 for unused local variables
    noUnusedParameters: false, // prevent TS6133 for unused parameters
    // skipLibCheck prevents cascading type errors inside node_modules .d.ts files
    // (e.g. transitive imports that can't be resolved in virtual FS).
    skipLibCheck: true,
    // Models live at file:///notebook/cells/cellId.ts.
    // TypeScript walks up two hops and finds file:///node_modules/ where
    // the server's type libraries live — no baseUrl/paths hacks needed.
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
    // ModuleDetectionKind.Force (= 3) makes TypeScript treat every cell as an ES module,
    // so top-level await is valid and local declarations don't pollute the global scope.
    // NOTE: ModuleDetectionKind is not exposed in Monaco 0.55.1's public API, so we
    // pass the raw numeric value directly — the underlying TS worker understands it.
    moduleDetection: 3,
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.React,
    typeRoots: ["file:///node_modules/@types", "file:///node_modules"],
  };

  // Diagnostic codes suppressed for notebook-style code.
  // diagnosticCodesToIgnore is supported by Monaco 0.55.1's TypeScript worker
  // (confirmed in tsMode worker source), even though it's not in the TS d.ts.
  const SUPPRESSED_DIAGNOSTICS = [
    1375, // top-level await only allowed in module (handled by moduleDetection:Force, but kept as safety net)
    1378, // top-level for-await only in async
    1280, // namespaces not allowed in global scripts (use force or export {})
    2304, // cannot find name (cross-cell refs handled by extra libs)
    2552, // cannot find name 'X', did you mean 'Y'? (cross-cell class refs)
    2451, // cannot redeclare block-scoped variable (cross-cell declaration clash)
    2468, // cannot redeclare block-scoped variable (alternate)
    2300, // duplicate identifier (cross-cell)
    1259, // module can only be default-imported
    2792, // cannot find module — module resolution for complex packages in virtual FS
    6133, // 'X' is declared but its value is never read (unused imports across cells)
    6196, // 'X' is declared but never used (unused type parameter)
    7044, // parameter implicitly has any type
    7005, // variable implicitly has any type
    7006, // parameter implicitly has any type
    7031, // binding element implicitly has any type
    1208, // all files must be modules
    8009, // 'interface' declarations can only be used in TypeScript files
    8010, // 'type annotations' can only be used in TypeScript files
    8006, // 'decorators' can only be used in TypeScript files
    8008, // Type parameter declarations can only be used in TypeScript files
    5097, // An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled
  ];

  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: SUPPRESSED_DIAGNOSTICS,
  });
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(
    compilerOptions,
  );
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: SUPPRESSED_DIAGNOSTICS,
  });
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(
    compilerOptions,
  );

  refreshMonacoLibraries();
  registerCompletionProvider();
}

function loadMonaco() {
  if (monacoPromise) return monacoPromise;

  monacoPromise = new Promise((resolve, reject) => {
    if (window.monaco) {
      initializeMonaco(window.monaco);
      resolve(window.monaco);
      return;
    }

    if (!window.require?.config) {
      reject(new Error("Monaco loader is not available"));
      return;
    }

    // Monaco 0.55.1 ships workers as standalone IIFE bundles in /vs/assets/.
    // We set getWorker (not getWorkerUrl) so Monaco's workers file picks it up
    // before editor.main.js runs its own self.MonacoEnvironment assignment.
    // Using classic Worker (no type:"module") matches how Monaco creates them
    // internally in editor.main.js — the IIFE bundles are not ES modules.
    window.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        const base = "/vendor/monaco/vs/assets/";
        if (label === "typescript" || label === "javascript") {
          return new Worker(base + "ts.worker-CMbG-7ft.js");
        }
        if (label === "css" || label === "scss" || label === "less") {
          return new Worker(base + "css.worker-HnVq6Ewq.js");
        }
        if (label === "html" || label === "handlebars" || label === "razor") {
          return new Worker(base + "html.worker-B51mlPHg.js");
        }
        if (label === "json") {
          return new Worker(base + "json.worker-DKiEKt88.js");
        }
        return new Worker(base + "editor.worker-Be8ye1pW.js");
      },
    };

    window.require.config({ paths: { vs: "/vendor/monaco/vs" } });

    window.require(
      ["vs/editor/editor.main"],
      () => {
        initializeMonaco(window.monaco);
        resolve(window.monaco);
      },
      reject,
    );
  });

  return monacoPromise;
}

function disposeEditors() {
  for (const editor of editorInstances.values()) {
    editor.dispose();
  }
  editorInstances.clear();
}

function disposeModel(cellId) {
  modelListeners.get(cellId)?.dispose();
  modelListeners.delete(cellId);
  modelInstances.get(cellId)?.dispose();
  modelInstances.delete(cellId);
  markdownModes.delete(cellId);
}

function syncCodeModels() {
  if (!state.monacoReady || !state.notebook) return;

  const codeCellIds = new Set(
    state.notebook.cells.filter((c) => c.type === "code").map((c) => c.id),
  );

  for (const cellId of modelInstances.keys()) {
    if (!codeCellIds.has(cellId)) disposeModel(cellId);
  }

  for (const cell of state.notebook.cells) {
    if (cell.type !== "code") continue;

    if (!modelInstances.has(cell.id)) {
      // getCellLanguage always returns a non-falsy string for code cells
      const cellLang = getCellLanguage(cell);
      const model = state.monaco.editor.createModel(
        cell.source,
        cellLang,
        getNotebookModelUri(cell.id, cellLang),
      );

      let crossCellDebounceTimer = null;
      let importWatcherTimer = null;
      const listener = model.onDidChangeContent(() => {
        const nextCell = state.notebook.cells.find(
          (item) => item.id === cell.id,
        );
        if (!nextCell) return;
        nextCell.source = model.getValue();
        setDirty(true);

        // Debounced refresh of cross-cell context for IntelliSense.
        // Uses the lightweight refresher (only replaces the cross-cell lib,
        // not the full package-type libs) so suggestions stay fast while typing.
        clearTimeout(crossCellDebounceTimer);
        crossCellDebounceTimer = setTimeout(
          () => refreshCrossCellDeclarations(),
          300,
        );

        // Lazy import watcher: when the user types a new import statement for a
        // package whose types aren't loaded yet, fetch only that package's types.
        // Uses a longer debounce (1.5 s) so we don't fire mid-typing.
        clearTimeout(importWatcherTimer);
        importWatcherTimer = setTimeout(async () => {
          if (!isNotebookView()) return;
          const currentImports = extractNotebookImports(state.notebook);
          // Only request packages that haven't been attempted yet.
          // We intentionally do NOT filter by state.installedPackages because:
          //   1. CommonJS require() imports packages that may live in a parent or
          //      global node_modules and therefore not appear in the workspace's
          //      own package.json (which is all installedPackages reflects).
          //   2. The server gracefully returns empty results for unresolvable
          //      packages, so the extra round-trip is harmless.
          const newPackages = [...currentImports].filter(
            (pkg) => !state.loadedTypePackages.has(pkg),
          );
          if (newPackages.length === 0) return;
          // Pre-mark all as attempted so that repeated edits don't keep re-firing
          // for packages that have no bundled types (the server will return empty
          // for them, and mergeSuggestionsIntoState won't add them to loadedTypePackages).
          for (const pkg of newPackages) state.loadedTypePackages.add(pkg);
          try {
            const data = await api(
              `/api/suggestions?path=${encodeURIComponent(state.notebookPath)}` +
                `&fields=typeLibraries,packageExports` +
                `&packages=${encodeURIComponent(newPackages.join(","))}`,
            );
            mergeSuggestionsIntoState(data);
            refreshMonacoLibraries();
          } catch {
            /* ignore — types will load on next full refresh */
          }
        }, 1500);
      });

      modelInstances.set(cell.id, model);
      modelListeners.set(cell.id, listener);
      continue;
    }

    const model = modelInstances.get(cell.id);
    if (model.getValue() !== cell.source) {
      model.setValue(cell.source);
    }
  }
}

function refreshActiveCellStyles() {
  document.querySelectorAll(".notebook-cell").forEach((cellElement) => {
    const frame = cellElement.querySelector(".cell-frame");
    const isActive = cellElement.dataset.cellId === state.activeCellId;
    frame?.classList.toggle("is-active", isActive);
    cellElement.classList.toggle("is-focused", isActive);
  });
  // Also refresh sidebar explorer active state — match by file path
  document.querySelectorAll(".nlp-item").forEach((item) => {
    const active =
      !!item.dataset.path && item.dataset.path === state.activePath;
    item.classList.toggle("is-active", active);
  });
}

function focusCell(cellId, { scrollIntoView = false } = {}) {
  state.activeCellId = cellId;
  refreshActiveCellStyles();

  if (scrollIntoView) {
    // Intentional scroll (e.g. after adding a cell)
    const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
    cellEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const editor = editorInstances.get(cellId);
  if (editor) {
    // Preserve page scroll position — editor.focus() triggers browser auto-scroll
    const savedScrollY = window.scrollY;
    editor.focus();
    if (!scrollIntoView) {
      requestAnimationFrame(() =>
        window.scrollTo({ top: savedScrollY, behavior: "instant" }),
      );
    }
    return;
  }

  const markdownInput = document.querySelector(
    `[data-markdown-editor="${cellId}"]`,
  );
  if (markdownInput) {
    markdownInput.focus({ preventScroll: !scrollIntoView });
    return;
  }

  const promptInput = document.querySelector(
    `.notebook-cell[data-cell-id="${cellId}"] .prompt-editor`,
  );
  promptInput?.focus({ preventScroll: !scrollIntoView });
}

function focusNextCell(cellId) {
  const index = state.notebook.cells.findIndex((cell) => cell.id === cellId);
  const nextCell = state.notebook.cells[index + 1];

  if (nextCell) {
    requestAnimationFrame(() => focusCell(nextCell.id));
    return;
  }

  insertCell(cellId, "code");
}

function renderTableOutput(rows) {
  const table = document.createElement("table");
  table.className = "output-table";
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const columns = Array.from(
    new Set(
      normalizedRows.flatMap((row) =>
        row && typeof row === "object" ? Object.keys(row) : ["value"],
      ),
    ),
  );

  if (columns.length === 0) {
    columns.push("value");
  }

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of normalizedRows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      const value = row && typeof row === "object" ? row[column] : row;
      td.textContent =
        typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  return table;
}

function renderMarkdownBlock(markdown) {
  const block = document.createElement("div");
  block.className = "rendered-markdown";
  block.innerHTML = renderMarkdown(markdown);
  return block;
}

function renderTextLikeOutput(text) {
  const value = String(text ?? "");
  const trimmed = value.trim();
  // Detect markdown: headings, code fences, blockquotes, lists, bold/italic, links, tables, hr
  const looksMarkdown =
    /(^|\n)#{1,6}\s|```|~~|>\s|(\*\*|\*|__)[^\s]|(\*|-|\+|\d+\.)\s+\S|\[.+?\]\(.+?\)|\|.*\|.*\||(^|\n)---+/m.test(
      trimmed,
    );
  if (looksMarkdown) {
    return renderMarkdownBlock(value);
  }
  const pre = document.createElement("pre");
  pre.className = "output-pre";
  pre.textContent = value;
  return pre;
}

function renderStructuredOutputBody(output, body) {
  const dataType = output.dataType ?? "text";

  if (dataType === "table") {
    body.appendChild(renderTableOutput(output.data));
    return;
  }

  if (dataType === "array") {
    const wrapper = document.createElement("div");
    wrapper.className = "array-output-wrapper";

    // Toggle button (only shown when tableData is available)
    if (output.tableData) {
      const header = document.createElement("div");
      header.className = "array-output-header";
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "array-toggle-btn";
      toggleBtn.title = "Switch to table view";
      toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg> Table`;
      header.appendChild(toggleBtn);
      wrapper.appendChild(header);

      const jsonEl = document.createElement("pre");
      jsonEl.className = "output-pre";
      jsonEl.textContent = output.text ?? "";

      const tableEl = renderTableOutput(output.tableData);
      tableEl.classList.add("array-table-view");
      tableEl.style.display = "none";

      wrapper.appendChild(jsonEl);
      wrapper.appendChild(tableEl);

      let showTable = false;
      toggleBtn.addEventListener("click", () => {
        showTable = !showTable;
        jsonEl.style.display = showTable ? "none" : "";
        tableEl.style.display = showTable ? "" : "none";
        toggleBtn.innerHTML = showTable
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg> Array`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg> Table`;
        toggleBtn.title = showTable
          ? "Switch to array view"
          : "Switch to table view";
        toggleBtn.classList.toggle("is-active", showTable);
      });
    } else {
      const jsonEl = document.createElement("pre");
      jsonEl.className = "output-pre";
      jsonEl.textContent = output.text ?? "";
      wrapper.appendChild(jsonEl);
    }

    body.appendChild(wrapper);
    return;
  }

  if (dataType === "image" && output.data?.src) {
    const image = document.createElement("img");
    image.className = "output-image";
    image.src = output.data.src;
    image.alt = output.data.alt ?? "";
    body.appendChild(image);
    return;
  }

  if (dataType === "markdown" && output.data?.markdown) {
    body.appendChild(renderMarkdownBlock(output.data.markdown));
    return;
  }

  if (dataType === "html" && output.data?.html != null) {
    const iframe = document.createElement("iframe");
    iframe.className = "output-html-frame";
    // allow-scripts lets Chart.js / D3 etc. run; no allow-same-origin keeps it sandboxed
    iframe.sandbox = "allow-scripts allow-popups";
    iframe.srcdoc = output.data.html;
    iframe.style.border = "none";
    iframe.style.width = "100%";
    iframe.style.minHeight = "320px";
    iframe.style.display = "block";
    // Auto-resize iframe to fit its content once loaded
    iframe.addEventListener("load", () => {
      try {
        const h = iframe.contentDocument?.documentElement?.scrollHeight;
        if (h && h > 0) iframe.style.height = `${h}px`;
      } catch {
        /* cross-origin guard */
      }
    });
    body.appendChild(iframe);
    return;
  }

  body.appendChild(renderTextLikeOutput(output.text ?? ""));
}

function renderOutputs(container, outputs, cell, options = {}) {
  const preserveScroll = options.preserveScroll === true;
  let atBottom = false;
  let prevScrollTop = 0;
  if (preserveScroll && container) {
    prevScrollTop = container.scrollTop;
    atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      20;
  }

  container.innerHTML = "";

  // Hide panel entirely if no output OR cell has no code
  const hasCode =
    cell?.type === "code" && (cell?.source ?? "").trim().length > 0;
  if (!outputs?.length || (cell?.type === "code" && !hasCode)) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");

  if (cell?.type === "prompt") {
    const metrics =
      cell.metrics && typeof cell.metrics === "object" ? cell.metrics : {};
    const outputTokens = Number.isFinite(metrics.aiTokensOut)
      ? metrics.aiTokensOut
      : estimateTokens(outputs?.map((o) => o.text).join("\n"));
    const inputTokens =
      Number.isFinite(metrics.aiTokensIn) && metrics.aiTokensIn > 0
        ? metrics.aiTokensIn
        : null;
    const meta = document.createElement("div");
    meta.className = "output-meta";
    meta.textContent = `Output: ${outputTokens} tokens${inputTokens ? ` · Input: ${inputTokens} tokens` : ""}`;
    container.appendChild(meta);
  }

  // Render each output directly — no header, no collapse controls
  for (const output of outputs) {
    const body = document.createElement("div");
    body.className = `output-body output-${output.type}`;
    renderStructuredOutputBody(output, body);
    container.appendChild(body);
  }

  // Restore or pin scroll position
  const saved = cell?.id ? outputScrollPositions.get(cell.id) : null;
  requestAnimationFrame(() => {
    if (preserveScroll) {
      if (atBottom) {
        container.scrollTop = container.scrollHeight;
      } else {
        container.scrollTop = prevScrollTop;
      }
      return;
    }
    if (saved) {
      if (saved.atBottom) {
        container.scrollTop = container.scrollHeight;
      } else {
        container.scrollTop = saved.scrollTop ?? 0;
      }
    }
  });
}

function updateCellStatus(cellElement, status, timing) {
  const statusBadge = cellElement.querySelector(".cell-status-badge");
  const timingEl = cellElement.querySelector(".cell-timing");

  if (statusBadge) {
    statusBadge.className = "cell-status-badge";
    if (status === "success") {
      statusBadge.classList.add("is-success");
      statusBadge.textContent = "Done";
    } else if (status === "error") {
      statusBadge.classList.add("is-error");
      statusBadge.textContent = "Error";
    } else if (status === "running") {
      statusBadge.classList.add("is-running");
      statusBadge.textContent = "Running...";
    }
  }

  if (timingEl && timing !== undefined) {
    timingEl.classList.toggle("is-visible", timing !== null);
    timingEl.textContent = timing !== null ? `${timing}ms` : "";
  }
}

function updateCellOutputsInDom(cell) {
  const cellEl = document.querySelector(`[data-cell-id="${cell.id}"]`);
  if (!cellEl) return;
  const panel = cellEl.querySelector(".output-panel");
  if (!panel) return;
  renderOutputs(panel, cell.outputs, cell, { preserveScroll: true });
}

function createEditorForCell(cell) {
  const host = document.querySelector(`[data-editor-host="${cell.id}"]`);
  if (!host) return;

  const model = modelInstances.get(cell.id);
  const editorTheme = (THEMES[state.theme] ?? THEMES["obsidian"]).monacoId;

  const editor = state.monaco.editor.create(host, {
    model,
    theme: editorTheme,
    fontFamily: resolvedFontFamily(state.editorFontFamily),
    fontSize: state.editorFontSize,
    fontLigatures: false,
    disableMonospaceOptimizations: true,
    minimap: { enabled: false },
    wordWrap: "on",
    lineNumbers: "on",
    glyphMargin: false,
    folding: true,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    overviewRulerLanes: 0,
    renderLineHighlightOnlyWhenFocus: false,
    scrollbar: {
      vertical: "hidden",
      horizontal: "auto",
      alwaysConsumeMouseWheel: false,
    },
    padding: { top: 10, bottom: 10 },
    suggest: {
      showWords: false, // no plain document-word noise
      showSnippets: true,
      preview: true, // ghost-text preview of selected item
      previewMode: "subwordSmart",
      filterGraceful: true,
      insertMode: "insert", // never overwrite — just insert at cursor
      localityBonus: true, // prefer nearby / recently-used symbols
      shareSuggestSelections: true,
      selectionMode: "always", // always keep a suggestion selected
      showDeprecated: false,
      // Show every completion kind (mirroring VS Code defaults)
      showMethods: true,
      showFunctions: true,
      showConstructors: true,
      showFields: true,
      showVariables: true,
      showClasses: true,
      showStructs: true,
      showInterfaces: true,
      showModules: true,
      showProperties: true,
      showEvents: true,
      showOperators: true,
      showUnits: true,
      showValues: true,
      showConstants: true,
      showEnums: true,
      showEnumMembers: true,
      showKeywords: true,
      showTypeParameters: true,
      showColors: true,
      showFiles: true,
      showReferences: true,
      showFolders: true,
      showIssues: true,
      showUsers: true,
    },
    // Trigger completions immediately in all contexts, including inside strings
    // (needed for import path completion and string-literal enum suggestions).
    quickSuggestions: {
      other: "on",
      comments: false,
      strings: "on", // triggers model:"gpt…" string-literal completions
    },
    quickSuggestionsDelay: 0, // no delay — show the list instantly
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: "smart",
    acceptSuggestionOnCommitCharacter: true,
    tabCompletion: "on",
    wordBasedSuggestions: "off", // let the TS worker own all symbol completions
    parameterHints: { enabled: true, cycle: true },
    hover: { enabled: true, delay: 300, sticky: true },
    inlayHints: { enabled: "on" },
    occurrencesHighlight: "singleFile",
    lightbulb: { enabled: "on" },
    tabSize: 2,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
    "semanticHighlighting.enabled": true,
  });

  const layoutEditor = () => {
    const lineCount = Math.max(model.getLineCount(), 1);
    // Use the actual Monaco content height so the cell grows correctly at any
    // font size. `editor.getContentHeight()` returns the real rendered height
    // (line height × line count + padding), so the host always fits the text.
    const monacoHeight = editor.getContentHeight();
    const contentHeight = Math.max(60, Math.min(monacoHeight, 600));
    host.style.height = `${contentHeight}px`;
    editor.layout();
  };

  editor.onDidContentSizeChange(layoutEditor);
  editor.onDidFocusEditorText(() => {
    state.activeCellId = cell.id;
    refreshActiveCellStyles();
  });
  editor.onDidBlurEditorText(() => {
    // Suppress the auto-save triggered by blur during cell insertion —
    // insertCell sets this flag to prevent a racing save from re-rendering
    // the notebook while the new cell is being added to the DOM.
    if (state._insertingCell) return;
    queueAutoSave();
  });

  editor.onKeyDown((event) => {
    if (
      event.keyCode === state.monaco.KeyCode.Enter &&
      event.shiftKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.browserEvent.preventDefault();
      executeCell(cell.id, { focusNext: true }).catch(handleError);
    }

    if (
      event.keyCode === state.monaco.KeyCode.Enter &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.browserEvent.preventDefault();
      executeCell(cell.id, { focusNext: false }).catch(handleError);
    }
  });

  layoutEditor();
  editorInstances.set(cell.id, editor);
}

/* ===== RENDER NOTEBOOK ===== */
function renderNotebook() {
  if (!state.notebook) return;

  const previouslyFocusedCellId = state.activeCellId;

  // Save output scroll positions (to preserve bottom anchoring for streaming logs)
  outputScrollPositions.clear();
  document.querySelectorAll(".notebook-cell").forEach((cellEl) => {
    const cellId = cellEl.dataset.cellId;
    const panel = cellEl.querySelector(".output-panel");
    if (!cellId || !panel) return;
    const atBottom =
      panel.scrollHeight - panel.scrollTop - panel.clientHeight < 20;
    outputScrollPositions.set(cellId, { scrollTop: panel.scrollTop, atBottom });
  });

  // Save editor scroll positions before disposing — restoring after rebuild prevents scroll-to-top
  const savedScrollPositions = new Map();
  for (const [cellId, editor] of editorInstances) {
    try {
      savedScrollPositions.set(cellId, editor.getScrollTop());
    } catch (_e) {}
  }

  disposeEditors();
  if (state.monacoReady) syncCodeModels();

  elements.notebookCells.innerHTML = "";
  updateHeader();

  for (const cell of state.notebook.cells) {
    const fragment = elements.cellTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".notebook-cell");
    const executionCount = fragment.querySelector(".execution-count");
    const runButton = fragment.querySelector(".cell-run-button");
    const typeSelect = null; // removed from new template
    const languageBadge = null; // badge removed from cell template
    const editorHost = fragment.querySelector(".editor-host");
    const markdownEditor = fragment.querySelector(".markdown-editor");
    const markdownPreview = fragment.querySelector(".markdown-preview");
    const promptPanel = fragment.querySelector(".prompt-panel");
    const promptEditor = fragment.querySelector(".prompt-editor");
    const promptSystemInput = fragment.querySelector(".prompt-system-input");
    const promptModelInput =
      fragment.querySelector(".prompt-model-select") ??
      fragment.querySelector(".prompt-model-input");
    const promptTemperatureInput = fragment.querySelector(
      ".prompt-temperature-input",
    );
    const promptTokenCount = fragment.querySelector(".prompt-token-count");
    const outputPanel = fragment.querySelector(".output-panel");
    const moveUp = fragment.querySelector(".move-up");
    const moveDown = fragment.querySelector(".move-down");
    const aiAssistButton = fragment.querySelector(".ai-assist-button");
    const deleteCellButton = fragment.querySelector(".delete-cell");
    const insertCodeButton = fragment.querySelector(".insert-code");
    const insertMarkdownButton = fragment.querySelector(".insert-markdown");

    const cellLang = getCellLanguage(cell);
    const langToggle = fragment.querySelector(".lang-toggle");
    const toolbarButtons = [
      runButton,
      moveUp,
      moveDown,
      aiAssistButton,
      deleteCellButton,
    ];

    root.dataset.cellId = cell.id;
    root.dataset.cellType = cell.type;
    executionCount.textContent = cell.executionCount
      ? `[${cell.executionCount}]`
      : "[ ]";
    const isRunning = state.runningCells.has(cell.id);
    if (isRunning) {
      runButton.classList.add("is-running", "is-stop");
      runButton.title = "Stop execution";
      runButton.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop`;
      updateCellStatus(root, "running", null);
    } else {
      runButton.title =
        cell.type === "code"
          ? "Run cell"
          : cell.type === "prompt"
            ? "Run prompt"
            : "Render markdown";
    }

    for (const button of toolbarButtons) {
      button?.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
    }

    if (cell.type === "code") {
      if (languageBadge)
        languageBadge.textContent =
          cellLang === "javascript" ? "JavaScript" : "TypeScript";
      // langToggle is removed from cell template (now global per notebook)
      if (langToggle) {
        langToggle.textContent = cellLang === "javascript" ? "JS" : "TS";
        langToggle.classList.toggle("is-js", cellLang === "javascript");
        langToggle.title =
          cellLang === "javascript"
            ? "JavaScript — click to switch to TypeScript"
            : "TypeScript — click to switch to JavaScript";
        langToggle.addEventListener("click", () => {
          cell.source = modelInstances.get(cell.id)?.getValue() ?? cell.source;
          cell.language =
            cellLang === "javascript" ? "typescript" : "javascript";
          disposeModel(cell.id);
          setDirty(true);
          renderNotebook();
          requestAnimationFrame(() => focusCell(cell.id));
        });
      }
    } else {
      if (languageBadge)
        languageBadge.textContent =
          cell.type === "prompt" ? "Prompt" : "Markdown";
      langToggle?.classList.add("hidden");
    }

    editorHost.dataset.editorHost = cell.id;
    editorHost.classList.toggle("hidden", cell.type !== "code");

    markdownEditor.value = cell.source;
    markdownEditor.dataset.markdownEditor = cell.id;
    const markdownPreviewMode =
      cell.type === "markdown" && getMarkdownMode(cell.id) === "preview";
    // Toggle clean-view class on the cell article (no chrome in preview mode)
    const cellArticle = fragment.querySelector(".notebook-cell");
    cellArticle?.classList.toggle("is-markdown-preview", markdownPreviewMode);
    markdownPreview.title = markdownPreviewMode ? "Double-click to edit" : "";
    markdownEditor.classList.toggle(
      "hidden",
      cell.type !== "markdown" || markdownPreviewMode,
    );
    markdownPreview.classList.toggle(
      "hidden",
      cell.type !== "markdown" || !markdownPreviewMode,
    );
    markdownPreview.innerHTML = renderMarkdown(cell.source);
    promptPanel.classList.toggle("hidden", cell.type !== "prompt");
    promptEditor.value = cell.type === "prompt" ? cell.source : "";
    promptSystemInput.value =
      cell.type === "prompt" ? (cell.prompt?.system ?? "") : "";
    // Populate prompt model select with available models
    if (promptModelInput && promptModelInput.tagName === "SELECT") {
      const models = state.aiAssistantModels.length
        ? state.aiAssistantModels
        : [];
      if (promptModelInput.options.length === 0) {
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          promptModelInput.appendChild(opt);
        }
      }
      promptModelInput.value =
        cell.type === "prompt"
          ? (cell.prompt?.model ?? "llama-3.3-70b-versatile")
          : "llama-3.3-70b-versatile";
    } else if (promptModelInput) {
      promptModelInput.value =
        cell.type === "prompt"
          ? (cell.prompt?.model ?? "llama-3.3-70b-versatile")
          : "";
    }
    promptTemperatureInput.value = String(
      cell.type === "prompt" ? (cell.prompt?.temperature ?? 0.2) : 0.2,
    );
    promptTokenCount.textContent = `${estimateTokens((cell.prompt?.system ?? "") + "\n" + (cell.source ?? ""))} tokens`;

    renderOutputs(outputPanel, cell.outputs, cell);

    // Restore cell status — show badge + timing for every cell that has been
    // executed in this session, regardless of whether it produced output.
    const timing = state.cellTimings.get(cell.id);
    const hasBeenExecuted = state.cellTimings.has(cell.id);
    const hasError = cell.outputs?.some((o) => o.type === "error");
    const statusBadge = fragment.querySelector(".cell-status-badge");
    const timingEl = fragment.querySelector(".cell-timing");
    if (statusBadge && hasBeenExecuted) {
      statusBadge.className = `cell-status-badge ${hasError ? "is-error" : "is-success"}`;
      statusBadge.textContent = hasError ? "Error" : "Done";
    }
    if (timingEl && timing !== undefined) {
      timingEl.classList.add("is-visible");
      timingEl.textContent = `${timing}ms`;
    }

    // typeSelect removed from new template — cell type is set at creation time

    markdownEditor.addEventListener("focus", () => {
      state.activeCellId = cell.id;
      refreshActiveCellStyles();
      // Size the textarea to fit content when switching to edit mode
      markdownEditor.style.height = "auto";
      markdownEditor.style.height = Math.min(markdownEditor.scrollHeight, 400) + "px";
    });

    markdownEditor.addEventListener("input", () => {
      cell.source = markdownEditor.value;
      markdownPreview.innerHTML = renderMarkdown(cell.source);
      // Auto-resize textarea up to 400px
      markdownEditor.style.height = "auto";
      markdownEditor.style.height = Math.min(markdownEditor.scrollHeight, 400) + "px";
      setDirty(true);
    });
    markdownEditor.addEventListener("blur", () => {
      queueAutoSave();
    });

    markdownEditor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        setMarkdownMode(cell.id, "preview");
        renderNotebook();
        focusNextCell(cell.id);
      }
    });

    markdownPreview.addEventListener("dblclick", () => {
      setMarkdownMode(cell.id, "edit");
      renderNotebook();
      requestAnimationFrame(() => focusCell(cell.id));
    });

    promptEditor.addEventListener("focus", () => {
      state.activeCellId = cell.id;
      refreshActiveCellStyles();
    });
    promptEditor.addEventListener("input", () => {
      cell.source = promptEditor.value;
      promptTokenCount.textContent = `${estimateTokens((cell.prompt?.system ?? "") + "\n" + promptEditor.value)} tokens`;
      setDirty(true);
    });
    promptEditor.addEventListener("blur", () => {
      queueAutoSave();
    });
    promptEditor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        cell.source = promptEditor.value;
        executePromptCell(cell.id).catch(handleError);
      }
    });
    promptSystemInput.addEventListener("input", () => {
      cell.prompt = cell.prompt ?? {};
      cell.prompt.system = promptSystemInput.value;
      promptTokenCount.textContent = `${estimateTokens(promptSystemInput.value + "\n" + promptEditor.value)} tokens`;
      setDirty(true);
    });
    const promptModelEvent =
      promptModelInput?.tagName === "SELECT" ? "change" : "input";
    promptModelInput?.addEventListener(promptModelEvent, () => {
      cell.prompt = cell.prompt ?? {};
      cell.prompt.model =
        (promptModelInput.value ?? "").trim() || "llama-3.3-70b-versatile";
      setDirty(true);
    });
    promptTemperatureInput.addEventListener("input", () => {
      cell.prompt = cell.prompt ?? {};
      const value = Number(promptTemperatureInput.value);
      cell.prompt.temperature = Number.isFinite(value) ? value : 0.2;
      setDirty(true);
    });

    runButton.addEventListener("click", () => {
      if (cell.type === "code") {
        // If currently running (stop button mode), cancel the execution
        if (runButton.classList.contains("is-stop") && currentExecutionAbort) {
          currentExecutionAbort.abort();
          return;
        }
        executeCell(cell.id).catch(handleError);
        return;
      }
      if (cell.type === "prompt") {
        executePromptCell(cell.id).catch(handleError);
        return;
      }
      setMarkdownMode(cell.id, "preview");
      renderNotebook();
    });

    aiAssistButton.classList.toggle("hidden", cell.type === "markdown");
    aiAssistButton.addEventListener("click", () => {
      openAiAssistant(cell.id).catch(handleError);
    });

    moveUp.addEventListener("click", () => moveCell(cell.id, "up"));
    moveDown.addEventListener("click", () => moveCell(cell.id, "down"));
    deleteCellButton.addEventListener("click", () => deleteCell(cell.id));
    insertCodeButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      state._insertingCell = true;
      insertCell(cell.id, "code");
    });
    insertMarkdownButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      state._insertingCell = true;
      insertCell(cell.id, "markdown");
    });

    elements.notebookCells.appendChild(fragment);
  }

  refreshActiveCellStyles();

  if (state.monacoReady) {
    for (const cell of state.notebook.cells) {
      if (cell.type === "code") createEditorForCell(cell);
    }
  }

  if (!state.activeCellId && state.notebook.cells.length > 0) {
    state.activeCellId = state.notebook.cells[0].id;
  }

  if (previouslyFocusedCellId) {
    requestAnimationFrame(() => focusCell(previouslyFocusedCellId));
  }

  // Restore scroll positions after layout settles (double rAF to run after Monaco's own layout)
  if (savedScrollPositions.size > 0) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const [cellId, scrollTop] of savedScrollPositions) {
          if (scrollTop > 0) {
            const editor = editorInstances.get(cellId);
            if (editor) {
              try {
                editor.setScrollTop(scrollTop);
              } catch (_e) {}
            }
          }
        }
      });
    });
  }
}

/* ===== NOTEBOOK OPERATIONS ===== */

/**
 * Parse all code cells in the notebook and return the set of top-level npm
 * package names that are imported/required.  Handles:
 *   import Foo from "pkg"
 *   import { Bar } from "@scope/pkg"
 *   const x = require("pkg")
 * Returns a Set of bare package names (scoped packages keep their scope, e.g.
 * "@langchain/groq").
 */
function extractNotebookImports(notebook) {
  const packages = new Set();
  if (!notebook?.cells) return packages;

  // Regex: static import/export from "module-specifier"
  const importRe = /(?:import|export)\s[^'"]*from\s+['"]([^'"./][^'"]*)['"]/g;
  // Regex: dynamic import("module-specifier")
  const dynImportRe = /\bimport\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;

  for (const cell of notebook.cells) {
    if (cell.type !== "code") continue;
    const src = cell.source ?? "";

    for (const re of [importRe, dynImportRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const specifier = m[1];
        // Normalise to bare package name: "@scope/pkg/sub" → "@scope/pkg",  "pkg/sub" → "pkg"
        const pkg = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (pkg) packages.add(pkg);
      }
    }
  }

  return packages;
}

/**
 * Merge new suggestion data (typeLibraries / packageExports) from a partial
 * /api/suggestions response into the global state without wiping existing data.
 * Used for incremental type loading (e.g. after installing a single package).
 */
function mergeSuggestionsIntoState(data) {
  if (data.modules !== undefined) state.modules = data.modules;
  if (data.installedPackages !== undefined)
    state.installedPackages = data.installedPackages;

  if (data.typeLibraries?.length) {
    // Append only entries not already present (keyed by virtual file path).
    const existing = new Set(state.typeLibraries.map((l) => l.file));
    for (const lib of data.typeLibraries) {
      if (!existing.has(lib.file)) {
        state.typeLibraries.push(lib);
        existing.add(lib.file);
        state.loadedTypePackages.add(lib.moduleName);
        // For @types/* companions, also mark the base package name as loaded so
        // the import watcher does not re-request types already covered by @types.
        if (lib.moduleName.startsWith("@types/")) {
          const base = lib.moduleName.slice("@types/".length);
          state.loadedTypePackages.add(
            base.includes("__") ? "@" + base.replace("__", "/") : base,
          );
        }
      }
    }
  }

  if (data.packageExports?.length) {
    // Append only exports not already present (keyed by moduleName+exportName).
    const existing = new Set(
      state.packageExports.map((e) => `${e.moduleName}::${e.exportName}`),
    );
    for (const entry of data.packageExports) {
      const key = `${entry.moduleName}::${entry.exportName}`;
      if (!existing.has(key)) {
        state.packageExports.push(entry);
        existing.add(key);
      }
    }
  }
}

async function loadSuggestions() {
  // For JS/TS file views we also load suggestions so the Monaco editor gets
  // the same IntelliSense (Node globals, installed package types) as notebook cells.
  const fileExt = (state.filePreview?.extension ?? "").toLowerCase();
  const isEditableFile =
    isFileView() && (fileExt === ".js" || fileExt === ".ts");

  if (!isNotebookView() && !isEditableFile) {
    state.modules = [];
    state.installedPackages = [];
    state.typeLibraries = [];
    state.packageExports = [];
    state.localFiles = [];
    return;
  }

  // Use the active file's path for workspace resolution; notebook path otherwise.
  const queryPath = isNotebookView()
    ? state.notebookPath
    : (state.activePath ?? state.notebookPath);

  // For notebooks: only request types for imported packages (performance).
  // For standalone files: request all installed package types.
  let extraParams = "";
  if (isNotebookView()) {
    const usedPackages = extractNotebookImports(state.notebook);
    if (usedPackages.size > 0) {
      // Only fetch type data for packages actually imported in this notebook.
      extraParams = `&packages=${encodeURIComponent([...usedPackages].join(","))}`;
    } else {
      // No imports yet — skip the expensive type/export scan entirely.
      // Only fetch the module list and installed-package inventory (both cheap).
      extraParams = "&fields=modules,installedPackages";
    }
  }

  const data = await api(
    `/api/suggestions?path=${encodeURIComponent(queryPath)}${extraParams}`,
  );
  state.modules = data.modules;
  state.installedPackages = data.installedPackages ?? data.modules ?? [];
  state.typeLibraries = data.typeLibraries ?? [];
  state.packageExports = data.packageExports ?? [];

  // Track which packages we have types for (enables lazy on-demand loading).
  // Include both the exact module names ("@types/express") AND the corresponding
  // base package names ("express") so the import watcher does not try to re-fetch
  // types for packages whose @types companion has already been loaded.
  state.loadedTypePackages = new Set(
    state.typeLibraries.map((l) => l.moduleName),
  );
  for (const lib of state.typeLibraries) {
    if (!lib.moduleName.startsWith("@types/")) continue;
    const base = lib.moduleName.slice("@types/".length); // e.g. "express" or "scope__pkg"
    state.loadedTypePackages.add(
      base.includes("__") ? "@" + base.replace("__", "/") : base,
    );
  }

  // Fetch local .js/.ts workspace files so Monaco can resolve `./file.js` imports.
  try {
    const localData = await api(
      `/api/local-files?path=${encodeURIComponent(queryPath)}`,
    );
    state.localFiles = localData.files ?? [];
  } catch {
    state.localFiles = [];
  }

  refreshMonacoLibraries();
}

async function openResource(
  requestPath = state.activePath ?? state.notebookPath,
  options = {},
) {
  if (isNotebookView() && state.dirty && options.flushPendingSave !== false) {
    await queueNotebookSave({ silent: true });
  }

  setKernelStatus("Loading notebook...", true);
  closeAiAssistant();
  resetPackageDocsDrawer();
  disposeFileEditor();

  // Show the notebook page immediately with a loading spinner so the user
  // gets visual feedback right away instead of waiting silently.
  navigateTo("notebook", {
    historyPath: "/notebooks",
    historyMode: options.historyMode ?? "push",
  });
  if (elements.notebookCells) {
    elements.notebookCells.innerHTML = `<div class="notebook-loading-state">
      <div class="nb-spinner"></div>
      <p style="opacity:0.5;font-size:13px;margin-top:12px">Loading notebook…</p>
    </div>`;
  }
  // Yield to the browser so it can paint the spinner before the network
  // request starts — this guarantees the loader is visible even on fast
  // local servers where the response might arrive in the very next tick.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const requestedPath =
    requestPath === "/" ? "" : (requestPath ?? state.notebookPath);
  const data = await api(
    `/api/open?path=${encodeURIComponent(requestedPath || "")}`,
  );

  state.activePath = data.path;

  if (data.kind === "notebook") {
    state.activeResourceType = "notebook";
    state.notebookPath = data.path;
    // Remember the last opened notebook so bootstrap can restore it.
    // Store the URL-style appPath (/notebooks/relative_path) rather than the
    // absolute filesystem path so it resolves correctly even if the user later
    // starts marsbook with a different --workspace directory.
    localStorage.setItem("marsbook-last-notebook", data.appPath ?? data.path);
    state.notebook = data.notebook;
    state.filePreview = null;
    executedInSession.clear();
    ensureNotebookMetadata();
    // Merge global env vars into the notebook env (notebook keys take priority)
    const globalEnv = loadGlobalEnv();
    if (Object.keys(globalEnv).length > 0) {
      const notebookEnv = state.notebook.metadata.env ?? {};
      const merged = { ...globalEnv, ...notebookEnv }; // notebook wins on conflict
      state.notebook.metadata.env = merged;
    }
    // Sync global language toggle from notebook metadata
    state.notebookLanguage =
      state.notebook.metadata?.language ??
      state.notebook.cells?.find((c) => c.type === "code")?.language ??
      "typescript";
    markdownModes.clear();
    state.cellTimings.clear();
    for (const cell of state.notebook.cells) {
      if (cell.type === "markdown") setMarkdownMode(cell.id, "preview");
    }
    state.activeCellId = state.notebook.cells[0]?.id ?? null;
    await loadSuggestions();
    renderNotebook();
    refreshMonacoLibraries(); // re-index type libs after models are created
  } else {
    state.activeResourceType = "file";
    state.filePreview = data;
    state.notebook = null;
    state.activeCellId = null;

    // For JS/TS files we want Monaco IntelliSense — don't wipe types yet;
    // loadSuggestions will refresh them. For other file kinds clear the state.
    const openedExt = (data.extension ?? "").toLowerCase();
    const isEditableJsTs = openedExt === ".js" || openedExt === ".ts";
    if (!isEditableJsTs) {
      state.modules = [];
      state.installedPackages = [];
      state.typeLibraries = [];
      state.packageExports = [];
      state.localFiles = [];
    }

    updatePackagesDrawer();
    renderFilePreview();

    // Load workspace package info + types for JS/TS files so Monaco gets full
    // IntelliSense (node globals, installed packages, type declarations).
    if (isEditableJsTs) {
      loadSuggestions().catch(() => {});
    }
  }

  state.lastSavedAt = new Date().toISOString();
  setDirty(false);
  updateHeader();
  updateWorkspaceMode();
  renderEnvPanel();
  // Update the URL to the canonical notebook path now that we know it.
  if (window.location.pathname !== data.appPath) {
    window.history.replaceState({ page: "notebook" }, "", data.appPath);
  }
  // Refresh the notebook list panel
  renderNotebookListPanel().catch(() => {});
  setKernelStatus("Ready");
}

async function saveNotebookAction(options = {}) {
  if (!isNotebookView()) return;
  // Don't save while a cell execution is in flight. Saving mid-execution calls
  // `state.notebook = data.notebook` which orphans the `cell` reference held
  // by executeCell / executePromptCell, causing the streamed output to be lost.
  // The execution always calls queueNotebookSave() when it finishes, so the
  // final state is saved correctly once the run completes.
  if (activeExecutionCount > 0) return;
  const { silent = false } = options;

  state.notebook.metadata.title =
    (elements.nbTitleInput?.value ?? "").trim() ||
    state.notebook.metadata.title ||
    deriveTitleFromPath(state.notebookPath);

  for (const cell of state.notebook.cells) {
    if (cell.type === "code") {
      cell.source = modelInstances.get(cell.id)?.getValue() ?? cell.source;
    }
  }

  setKernelStatus("Saving...", true);
  const nextPath = deriveNotebookPathFromTitle(
    state.notebookPath,
    state.notebook.metadata.title,
  );
  const oldPath = state.notebookPath; // capture before save in case of rename

  const data = await api("/api/notebook/save", {
    method: "POST",
    body: JSON.stringify({
      path: state.notebookPath,
      nextPath,
      notebook: state.notebook,
    }),
  });

  state.notebookPath = data.notebookPath;
  state.activePath = data.notebookPath;

  // Save every editor's cursor position + scroll state before re-render,
  // because renderNotebook() recreates Monaco instances and resets them.
  const savedEditorState = new Map();
  for (const [cellId, editor] of editorInstances) {
    savedEditorState.set(cellId, {
      position: editor.getPosition(),
      selections: editor.getSelections(),
      scrollTop: editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft(),
    });
  }

  // Merge only server-updated metadata; keep the live cell sources so we
  // don't overwrite what's currently in the editors.
  if (data.notebook?.metadata) {
    state.notebook.metadata = data.notebook.metadata;
  }
  // Sync server-side cell changes. Apply Prettier-formatted source directly
  // into the Monaco model (preserves cursor/undo history) instead of replacing
  // the whole notebook, which would reset all editor state.
  if (data.notebook?.cells) {
    for (const serverCell of data.notebook.cells) {
      const localCell = state.notebook.cells.find(
        (c) => c.id === serverCell.id,
      );
      if (!localCell) continue;

      const formattedSource = serverCell.source ?? localCell.source;
      const currentSource = localCell.source ?? "";

      // Apply formatted source to the Monaco model only if Prettier changed it.
      // Using model.pushEditOperations preserves the undo stack and does NOT
      // move the cursor (the cursor restore below handles that).
      if (formattedSource !== currentSource) {
        const model = modelInstances.get(serverCell.id);
        if (model) {
          const fullRange = model.getFullModelRange();
          model.pushEditOperations(
            [],
            [{ range: fullRange, text: formattedSource }],
            () => null, // cursor position unchanged — restored below
          );
        }
        localCell.source = formattedSource;
      }

      // Sync all other server-side fields (execution counts, etc.)
      const { source: _skip, ...rest } = serverCell;
      Object.assign(localCell, rest);
    }
  }

  ensureNotebookMetadata();
  state.lastSavedAt = new Date().toISOString();
  setDirty(false);
  renderNotebook();
  updateHeader();

  // Restore cursor positions + scroll in all editors after re-render.
  for (const [cellId, saved] of savedEditorState) {
    const editor = editorInstances.get(cellId);
    if (!editor) continue;
    if (saved.selections?.length) editor.setSelections(saved.selections);
    else if (saved.position) editor.setPosition(saved.position);
    editor.setScrollTop(saved.scrollTop);
    editor.setScrollLeft(saved.scrollLeft);
  }
  // Keep focus in the active cell's editor
  if (state.activeCellId) {
    editorInstances.get(state.activeCellId)?.focus();
  }
  updateWorkspaceMode();
  if (data.appPath) {
    updateBrowserUrl(data.appPath, "replace");
  }

  // Update the explorer sidebar without collapsing the tree.
  // If the file was renamed, patch just that one entry in the cache so the
  // new filename appears immediately; then re-render the existing tree in-place.
  // If it was not renamed, a lightweight re-render still keeps the active-file
  // highlight in sync without any network request.
  if (oldPath !== data.notebookPath) {
    const newBasename = data.notebookPath.split("/").pop() ?? "";
    for (const [, entries] of directoryCache) {
      const idx = entries.findIndex((e) => e.path === oldPath);
      if (idx >= 0) {
        entries[idx] = {
          ...entries[idx],
          path: data.notebookPath,
          name: newBasename,
        };
        break;
      }
    }
  }
  renderExplorerTree();

  setKernelStatus("Saved");

  if (!silent) {
    showToast("Notebook saved");
  }
}

function queueNotebookSave(options = {}) {
  saveQueue = saveQueue
    .then(() => {
      if (!isNotebookView() || !state.dirty) return null;
      return saveNotebookAction(options);
    })
    .catch(handleError);

  return saveQueue;
}

function queueAutoSave() {
  return queueNotebookSave({ silent: true });
}

async function executePromptCell(cellId) {
  if (!isNotebookView()) return;
  const cell = state.notebook.cells.find((item) => item.id === cellId);
  if (!cell || cell.type !== "prompt") return;

  // Sync source from DOM textarea in case the input event hasn't fired yet
  // (e.g. on the first click before blur, or when triggered via Shift+Enter)
  const promptEditorEl = document.querySelector(
    `[data-cell-id="${cellId}"] .prompt-editor`,
  );
  if (promptEditorEl) cell.source = promptEditorEl.value;

  // Guard: prevent saveNotebookAction from replacing state.notebook (and
  // orphaning this `cell` reference) while we are streaming the response.
  activeExecutionCount++;

  const inputTokens = estimateTokens(
    (cell.prompt?.system ?? "") + "\n" + (cell.source ?? ""),
  );
  cell.metrics =
    cell.metrics && typeof cell.metrics === "object" ? cell.metrics : {};
  cell.metrics.aiTokensIn = inputTokens;
  cell.metrics.aiTokensOut = 0;
  cell.metrics.aiTokensTotal = inputTokens;
  cell.metrics.aiTokensUpdatedAt = new Date().toISOString();

  cell.outputs = [
    {
      type: "result",
      text: "",
      dataType: "markdown",
      data: { markdown: "" },
    },
  ];
  setDirty(true);
  updateCellOutputsInDom(cell);
  setKernelStatus("Streaming prompt...", true);
  let response;
  try {
    response = await fetch("/api/prompt/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: state.notebookPath,
        source: cell.source,
        prompt: cell.prompt,
        env: state.notebook.metadata.env ?? {},
      }),
    });
  } catch (err) {
    cell.outputs = [
      { type: "error", text: err?.message ?? String(err), dataType: "text" },
    ];
    activeExecutionCount--;
    updateCellOutputsInDom(cell);
    setKernelStatus("Prompt failed");
    return;
  }

  if (!response.ok || !response.body) {
    const rawError = await response
      .text()
      .catch(() => "Prompt execution failed");
    let errorText = rawError;
    try {
      const parsed = JSON.parse(rawError);
      if (parsed?.error) errorText = parsed.error;
    } catch {
      /* not JSON, use raw */
    }
    cell.outputs = [
      {
        type: "error",
        text: errorText || "Prompt execution failed",
        dataType: "text",
      },
    ];
    activeExecutionCount--;
    updateCellOutputsInDom(cell);
    setKernelStatus("Prompt failed");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  // Real token counts sent by server as a sentinel line at end of stream
  let apiTokensIn = null;
  let apiTokensOut = null;

  // Sentinel format written by server after streaming ends:
  //   \x02TOKEN_USAGE:{"in":N,"out":M}\n
  const TOKEN_SENTINEL = "\x02TOKEN_USAGE:";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += decoder.decode(value, { stream: true });

    // Extract sentinel if present (strip it from displayed content)
    const sentinelIdx = accumulated.indexOf(TOKEN_SENTINEL);
    let displayText = accumulated;
    if (sentinelIdx !== -1) {
      displayText = accumulated.slice(0, sentinelIdx);
      try {
        const jsonEnd = accumulated.indexOf("\n", sentinelIdx);
        const jsonStr = accumulated.slice(
          sentinelIdx + TOKEN_SENTINEL.length,
          jsonEnd !== -1 ? jsonEnd : undefined,
        );
        const usage = JSON.parse(jsonStr);
        if (typeof usage.in === "number") apiTokensIn = usage.in;
        if (typeof usage.out === "number") apiTokensOut = usage.out;
      } catch {
        // malformed sentinel — ignore
      }
    }

    cell.outputs = [
      {
        type: "result",
        text: displayText,
        dataType: "markdown",
        data: { markdown: displayText },
      },
    ];
    // Show live estimate while streaming; will be replaced with real count at end
    const outTokens = apiTokensOut ?? estimateTokens(displayText);
    cell.metrics.aiTokensOut = outTokens;
    cell.metrics.aiTokensTotal = outTokens + (cell.metrics.aiTokensIn || 0);
    cell.metrics.aiTokensUpdatedAt = new Date().toISOString();
    // Surgical DOM update — avoids full re-render on every streaming chunk
    updateCellOutputsInDom(cell);
  }

  cell.executionCount = (cell.executionCount ?? 0) + 1;

  // Strip sentinel from final output text in case it arrived in the last chunk
  const sentinelIdx = accumulated.indexOf(TOKEN_SENTINEL);
  const finalText =
    sentinelIdx !== -1 ? accumulated.slice(0, sentinelIdx) : accumulated;
  const trimmedFinal = finalText.trim();
  cell.outputs = trimmedFinal
    ? [
        {
          type: "result",
          text: trimmedFinal,
          dataType: "markdown",
          data: { markdown: trimmedFinal },
        },
      ]
    : [
        {
          type: "error",
          text: "No response from AI. Check your GROQ_API_KEY and prompt.",
          dataType: "text",
        },
      ];

  // Use real API token counts if available, fall back to estimate
  const finalOut = apiTokensOut ?? estimateTokens(finalText);
  const finalIn =
    apiTokensIn ??
    cell.metrics.aiTokensIn ??
    estimateTokens((cell.prompt?.system ?? "") + "\n" + (cell.source ?? ""));
  cell.metrics.aiTokensIn = finalIn;
  cell.metrics.aiTokensOut = finalOut;
  cell.metrics.aiTokensTotal = finalIn + finalOut;
  cell.metrics.aiTokensUpdatedAt = new Date().toISOString();
  setDirty(true);
  // Release the guard before DOM updates so queueNotebookSave (below) is
  // allowed to persist the final output to disk.
  activeExecutionCount--;

  // Targeted DOM updates — no full re-render so page scroll is preserved.
  updateCellOutputsInDom(cell);
  const _promptFinishedEl = document.querySelector(`[data-cell-id="${cell.id}"]`);
  if (_promptFinishedEl) {
    const _promptCountEl = _promptFinishedEl.querySelector(".execution-count");
    if (_promptCountEl) {
      _promptCountEl.textContent = cell.executionCount ? `[${cell.executionCount}]` : "[ ]";
    }
    updateCellStatus(_promptFinishedEl, "success", null);
  }

  queueNotebookSave({ silent: true });
  setKernelStatus("Prompt complete");
}

/**
 * Show a Jupyter-style inline input widget inside the cell's output panel.
 * Returns a Promise that resolves with the user's entered value.
 * The stream reader loop awaits this — no window.prompt() modal needed.
 * @param {object} cell - The cell object
 * @param {string} promptText - The prompt label shown before the input field
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel the widget
 */
function requestInlineInput(cell, promptText, signal) {
  return new Promise((resolve) => {
    // Find the output panel for this cell
    const cellEl = document.querySelector(`[data-cell-id="${cell.id}"]`);
    const outputPanel = cellEl?.querySelector(".output-panel");

    // Build the widget
    const widget = document.createElement("div");
    widget.className = "inline-input-widget";

    const label = document.createElement("span");
    label.className = "inline-input-label";
    label.textContent = promptText || "Enter input: ";

    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "inline-input-field";
    inputEl.setAttribute("autocomplete", "off");
    inputEl.setAttribute("spellcheck", "false");

    const submitBtn = document.createElement("button");
    submitBtn.className = "inline-input-submit";
    submitBtn.textContent = "Submit";

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      pendingInlineInputCount = Math.max(0, pendingInlineInputCount - 1);
      resolve(value);
    };
    const submit = () => {
      const value = inputEl.value;
      // Replace widget with static echo text (shows what was typed, like Jupyter)
      const echo = document.createElement("div");
      echo.className = "inline-input-echo";
      echo.textContent = (promptText || "Enter input: ") + value;
      if (widget.parentNode) widget.replaceWith(echo);
      settle(value);
    };

    submitBtn.addEventListener("click", submit);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    // If execution is aborted (user presses Stop), resolve with empty and remove widget
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (widget.parentNode) widget.remove();
          settle("");
        },
        { once: true },
      );
    }

    widget.appendChild(label);
    widget.appendChild(inputEl);
    widget.appendChild(submitBtn);

    if (outputPanel) {
      pendingInlineInputCount++;
      outputPanel.classList.remove("hidden");
      outputPanel.appendChild(widget);
      // Use setTimeout instead of requestAnimationFrame so focus fires after
      // any pending rAF callbacks (like focusCell) have already run. This
      // prevents the Monaco editor from gaining focus just before we steal it,
      // which would trigger onDidBlurEditorText → queueAutoSave.
      setTimeout(() => {
        if (!settled) inputEl.focus();
      }, 0);
    } else {
      // Fallback: resolve immediately with empty if no panel found
      settle("");
    }
  });
}

async function executeCell(cellId, options = {}) {
  if (!isNotebookView()) return;
  const cell = state.notebook.cells.find((item) => item.id === cellId);
  if (!cell || cell.type !== "code") return;

  const setRunButtonState = (isRunning) => {
    const cellElement = document.querySelector(`[data-cell-id="${cellId}"]`);
    if (!cellElement) return;
    const runBtn = cellElement.querySelector(".cell-run-button");
    if (!runBtn) return;
    if (isRunning) state.runningCells.add(cellId);
    else state.runningCells.delete(cellId);
    if (isRunning) {
      runBtn.classList.add("is-running", "is-stop");
      runBtn.title = "Stop execution";
      runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop`;
      updateCellStatus(cellElement, "running", null);
    } else {
      runBtn.classList.remove("is-running", "is-stop");
      runBtn.title = "Run cell";
      runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run`;
    }
  };

  cell.source = modelInstances.get(cell.id)?.getValue() ?? cell.source;

  // Guard: prevent saveNotebookAction from replacing state.notebook while
  // we are streaming, which would orphan this `cell` reference.
  activeExecutionCount++;

  setKernelStatus(`Running...`, true);

  // Cancel any previous execution
  if (currentExecutionAbort) {
    currentExecutionAbort.abort();
  }
  const abortController = new AbortController();
  currentExecutionAbort = abortController;

  // Update UI to show running state — swap run button to stop button
  const cellElement = document.querySelector(`[data-cell-id="${cellId}"]`);
  if (cellElement) {
    updateCellStatus(cellElement, "running", null);
  }
  setRunButtonState(true);

  const startTime = performance.now();

  let result;
  try {
    const response = await fetch("/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: state.notebookPath,
        cellId,
        code: cell.source,
        language: getCellLanguage(cell),
        env: state.notebook.metadata.env ?? {},
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error("Execution request failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;
    cell.outputs = [];
    // Targeted output clear — avoids a full re-render (which resets page scroll)
    updateCellOutputsInDom(cell);

    // Track input echoes so they survive the final `cell.outputs = result.outputs` merge
    const inputEchoes = []; // [{ insertAt: N, echo: outputObject }]
    let streamOutputCount = 0; // server outputs received so far

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.kind === "output") {
          cell.outputs.push(message.output);
          streamOutputCount++;
          updateCellOutputsInDom(cell);
          setRunButtonState(true);
        } else if (message.kind === "input_request") {
          // Show Jupyter-style inline input widget — no blocking modal.
          // The stream reader loop is paused here (await) while user types.
          const promptLabel = message.prompt || "Enter input: ";
          let answer = "";
          try {
            answer = await requestInlineInput(
              cell,
              promptLabel,
              abortController.signal,
            );
          } catch (_e) {
            answer = "";
          }
          // Record the echo output (prompt + answer) to persist it.
          // Track insertAt position so it survives the final result.outputs merge.
          const echoOutput = {
            type: "output",
            text: promptLabel + answer,
            dataType: "text",
          };
          cell.outputs.push(echoOutput);
          inputEchoes.push({ insertAt: streamOutputCount, echo: echoOutput });
          updateCellOutputsInDom(cell);
          try {
            await api("/api/execute/input", {
              method: "POST",
              body: JSON.stringify({
                path: state.notebookPath,
                runId: message.runId,
                value: answer,
              }),
            });
          } catch (err) {
            showToast("Failed to send input, execution cancelled", "error");
            // Cancel on the server to avoid a stuck kernel waiting for input
            api("/api/execute/cancel", {
              method: "POST",
              body: JSON.stringify({ path: state.notebookPath, cellId }),
            }).catch(() => {});
            throw err;
          }
        } else if (message.kind === "result") {
          finalResult = message.result;
        }
      }
    }

    if (!finalResult) {
      throw new Error("Execution did not return a result");
    }

    // Merge input echoes into the server's authoritative output list.
    // Echoes are inserted in reverse order so earlier indices remain correct.
    if (inputEchoes.length > 0) {
      const merged = [...finalResult.outputs];
      for (const { insertAt, echo } of [...inputEchoes].reverse()) {
        merged.splice(insertAt, 0, echo);
      }
      finalResult = { ...finalResult, outputs: merged };
    }

    result = finalResult;
  } catch (err) {
    if (err.name === "AbortError") {
      // Execution was cancelled — notify server to cancel and restore UI
      api("/api/execute/cancel", {
        method: "POST",
        body: JSON.stringify({ path: state.notebookPath, cellId }),
      }).catch(() => {});
      setKernelStatus("Execution cancelled");
      if (cellElement) {
        updateCellStatus(cellElement, "error", null);
      }
      setRunButtonState(false);
      if (currentExecutionAbort === abortController)
        currentExecutionAbort = null;
      activeExecutionCount--;
      return;
    }
    activeExecutionCount--;
    throw err;
  }

  if (currentExecutionAbort === abortController) currentExecutionAbort = null;

  const elapsed = Math.round(performance.now() - startTime);
  state.cellTimings.set(cellId, elapsed);

  cell.outputs = result.outputs;
  cell.executionCount = result.executionCount;
  // Mark as executed in the current session regardless of success/failure.
  // Even a failed cell (e.g. syntax error) has been "seen" by the kernel,
  // so we don't need to re-run it automatically when a later cell is run.
  executedInSession.add(cellId);
  setDirty(true);
  // Release the execution guard before DOM updates so that the save
  // triggered by queueNotebookSave (below) is allowed to run normally.
  activeExecutionCount--;

  // Targeted DOM updates — no full re-render so page scroll is preserved.
  updateCellOutputsInDom(cell);
  const _finishedCellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
  if (_finishedCellEl) {
    // Update the [N] execution-count badge
    const _countEl = _finishedCellEl.querySelector(".execution-count");
    if (_countEl) {
      _countEl.textContent = cell.executionCount ? `[${cell.executionCount}]` : "[ ]";
    }
    // Update Done / Error status badge with timing
    updateCellStatus(_finishedCellEl, result.ok ? "success" : "error", elapsed);
  }

  setKernelStatus(result.ok ? "Kernel ready" : "Execution failed");
  setRunButtonState(false);

  // Scroll the output area into view so the user sees the result
  // Only scroll once at end; avoid fighting streaming scroll
  requestAnimationFrame(() => {
    const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
    const outputPanel = cellEl?.querySelector(".output-panel");
    if (outputPanel && !outputPanel.classList.contains("hidden")) {
      const atBottom =
        outputPanel.scrollHeight -
          outputPanel.scrollTop -
          outputPanel.clientHeight <
        20;
      if (atBottom) outputPanel.scrollTop = outputPanel.scrollHeight;
    }
  });

  if (options.focusNext) {
    focusNextCell(cell.id);
  }

  // Refresh cross-cell IntelliSense so variables defined in this cell are
  // immediately available as autocomplete suggestions in subsequent cells.
  refreshCrossCellDeclarations();
}

async function runAllCells() {
  if (!isNotebookView()) return;
  const codeCells = state.notebook.cells.filter((cell) => cell.type === "code");

  for (const cell of codeCells) {
    await executeCell(cell.id);
  }
}

function moveCell(cellId, direction) {
  const index = state.notebook.cells.findIndex((cell) => cell.id === cellId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;

  if (
    index < 0 ||
    targetIndex < 0 ||
    targetIndex >= state.notebook.cells.length
  )
    return;

  const [cell] = state.notebook.cells.splice(index, 1);
  state.notebook.cells.splice(targetIndex, 0, cell);
  state.activeCellId = cell.id;
  setDirty(true);
  renderNotebook();
  queueNotebookSave({ silent: true });
}

function deleteCell(cellId) {
  const index = state.notebook.cells.findIndex((cell) => cell.id === cellId);
  if (index < 0) return;

  if (state.notebook.cells.length === 1) {
    state.notebook.cells[0] = createCell("code", "");
    disposeModel(cellId);
    state.activeCellId = state.notebook.cells[0].id;
    setDirty(true);
    renderNotebook();
    return;
  }

  state.notebook.cells = state.notebook.cells.filter(
    (cell) => cell.id !== cellId,
  );
  disposeModel(cellId);
  state.activeCellId = state.notebook.cells[Math.max(0, index - 1)]?.id ?? null;
  setDirty(true);
  renderNotebook();
}

function insertCell(afterCellId, type = "code") {
  if (!isNotebookView()) return;
  const index = state.notebook.cells.findIndex(
    (cell) => cell.id === afterCellId,
  );
  const cell = createCell(
    type,
    type === "markdown" ? "## Notes\n\nWrite documentation here." : "",
    type === "code" ? state.notebookLanguage : undefined,
  );

  if (index < 0) {
    state.notebook.cells.push(cell);
  } else {
    state.notebook.cells.splice(index + 1, 0, cell);
  }

  state.activeCellId = cell.id;
  if (type === "markdown") setMarkdownMode(cell.id, "edit");
  setDirty(true);
  // _insertingCell was already set true by the button handler BEFORE Monaco could
  // fire blur. Keep it true through renderNotebook AND any async Monaco blur
  // events that follow, then clear it after a short delay.
  renderNotebook();
  clearTimeout(state._insertingCellTimer);
  state._insertingCellTimer = setTimeout(() => {
    state._insertingCell = false;
  }, 150);
  // Scroll new cell into view intentionally
  requestAnimationFrame(() => focusCell(cell.id, { scrollIntoView: true }));
}

function openNewNotebookDialog() {
  if (!elements.newNbModal) return;
  elements.newNbInput.value = "";
  elements.newNbError.textContent = "";
  elements.newNbModal.classList.add("is-open");
  elements.newNbScrim?.classList.add("is-open");
  requestAnimationFrame(() => elements.newNbInput?.focus());
}

function closeNewNotebookDialog() {
  elements.newNbModal?.classList.remove("is-open");
  elements.newNbScrim?.classList.remove("is-open");
}

async function createNewNotebook(rawName) {
  // ── Normalise the input ────────────────────────────────────────────────
  let name = (rawName ?? "").trim();
  if (!name) return;

  // Strip /notebooks/ URL prefix if user copy-pasted from the address bar
  name = name.replace(/^\/notebooks\//, "");

  // Split into directory prefix and base filename
  const lastSlash = name.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? name.slice(0, lastSlash) : "";
  let filePart = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;

  // If the base has no extension, add .ijsnb (default for the notebook dialog)
  if (!filePart.includes(".")) {
    filePart = `${filePart}.ijsnb`;
  }

  // Final relative path (e.g. "courses/basic.ijsnb" or "notes.js")
  const relPath = dirPart ? `${dirPart}/${filePart}` : filePart;
  const appPath = `/notebooks/${relPath}`;

  // ── Check for existing file ──────────────────────────────────────────────
  try {
    const stat = await api(`/api/stat?path=${encodeURIComponent(appPath)}`);
    if (stat?.exists) {
      if (elements.newNbError)
        elements.newNbError.textContent =
          "A file with that name already exists.";
      return; // leave dialog open
    }
  } catch {
    // ignore — network error, proceed and let the server decide
  }

  closeNewNotebookDialog();

  // ── Non-notebook text files: create via /api/file/save, then open ───────
  const ext = filePart.includes(".")
    ? "." + filePart.split(".").pop().toLowerCase()
    : "";
  const isTextFile = [".js", ".ts", ".md", ".txt"].includes(ext);

  if (isTextFile) {
    try {
      await api("/api/file/save", {
        method: "POST",
        body: JSON.stringify({ path: appPath, content: "" }),
      });
    } catch (err) {
      showToast(`Could not create ${filePart}`, "error");
      return;
    }
    await openResource(appPath, { historyMode: "replace" });
    directoryCache.clear();
    renderNotebookListPanel().catch(() => {});
    return;
  }

  // ── Notebook (.ijsnb): open (server will create on first access) ─────────
  await openResource(appPath, { historyMode: "replace" });

  // Refresh the workspace explorer to show the new file
  directoryCache.clear();
  renderNotebookListPanel().catch(() => {});
}

// Wire up the new-notebook dialog buttons and keyboard
elements.newNbConfirm?.addEventListener("click", () => {
  createNewNotebook(elements.newNbInput?.value).catch(handleError);
});
elements.newNbCancel?.addEventListener("click", closeNewNotebookDialog);
elements.newNbScrim?.addEventListener("click", closeNewNotebookDialog);
elements.newNbInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createNewNotebook(elements.newNbInput.value).catch(handleError);
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeNewNotebookDialog();
  }
});

async function deleteFile(filePath, name = "file") {
  const ok = await confirmAction({
    title: "Delete file?",
    message: `"${name}" will be permanently removed.`,
    confirmLabel: "Delete",
    tone: "danger",
  });
  if (!ok) return false;

  await api("/api/file/delete", {
    method: "POST",
    body: JSON.stringify({ path: filePath }),
  });

  // Remove from cached explorer directories
  for (const [dir, entries] of directoryCache.entries()) {
    directoryCache.set(
      dir,
      entries.filter((entry) => entry.path !== filePath),
    );
  }

  // If this file was currently open as preview, close it
  if (state.activePath === filePath) {
    state.filePreview = null;
    state.activePath = null;
    state.activeResourceType = null;
    navigateTo("dashboard", {
      historyPath: "/dashboard",
      historyMode: "replace",
    });
  }

  renderExplorerTree();
  showToast(`"${name}" deleted`, "success");
  return true;
}

async function deleteFolder(folderPath, name = "folder") {
  const ok = await confirmAction({
    title: "Delete folder?",
    message: `"${name}" and all its contents will be permanently removed.`,
    confirmLabel: "Delete",
    tone: "danger",
  });
  if (!ok) return false;

  await api("/api/folder/delete", {
    method: "POST",
    body: JSON.stringify({ path: folderPath }),
  });

  // Remove from caches
  directoryCache.delete(folderPath);
  expandedDirectories.delete(folderPath);
  for (const [dir, entries] of directoryCache.entries()) {
    directoryCache.set(
      dir,
      entries.filter((entry) => entry.path !== folderPath),
    );
  }

  // If the currently open file lived inside the deleted folder, close its preview
  // without navigating away — just clear the canvas so the user stays in context.
  if (state.activePath && state.activePath.startsWith(folderPath + "/")) {
    disposeFileEditor();
    state.filePreview = null;
    state.activePath = null;
    state.activeResourceType = null;
    if (elements.filePreview) elements.filePreview.innerHTML = "";
    updateHeader();
    updateWorkspaceMode();
  }

  renderExplorerTree();
  showToast(`"${name}" deleted`, "success");
  return true;
}

async function deleteNotebook(path, title = "Notebook") {
  const ok = await confirmAction({
    title: "Delete notebook?",
    message: `"${title}" will be removed permanently.`,
    confirmLabel: "Delete",
    tone: "danger",
  });
  if (!ok) return false;

  await api("/api/notebook/delete", {
    method: "POST",
    body: JSON.stringify({ path }),
  });

  // Remove from cached explorer directories
  for (const [dir, entries] of directoryCache.entries()) {
    directoryCache.set(
      dir,
      entries.filter((entry) => entry.path !== path),
    );
  }
  // Remove from dashboard cache
  dashboardNotebooks = dashboardNotebooks.filter((nb) => nb.path !== path);

  // If the deleted notebook was open, reset the workspace view
  if (state.notebookPath === path || state.activePath === path) {
    disposeEditors();
    state.notebook = null;
    state.notebookPath = null;
    state.activePath = null;
    state.activeResourceType = null;
    if (elements.notebookCells) {
      elements.notebookCells.innerHTML = `<div class=\"notebook-empty-state\">\n        <svg width=\"48\" height=\"48\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"opacity:0.3;margin-bottom:12px\">\n          <path d=\"M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z\"/>\n          <path d=\"M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z\"/>\n        </svg>\n        <p style=\"opacity:0.5;font-size:14px\">Select a notebook from the Explorer to open it</p>\n      </div>`;
    }
    navigateTo("dashboard", {
      historyPath: "/dashboard",
      historyMode: "replace",
    });
  }

  renderNotebookListPanel().catch(() => {});
  loadDashboard().catch(() => {});
  showToast("Notebook deleted", "success");
  return true;
}

function handleError(error) {
  console.error(error);
  showToast(error.message || "Request failed", "error");
  setKernelStatus(error.message || "Request failed");
}

/* ===== EVENT LISTENERS ===== */

// Notebook title (click display → show input)
elements.nbTitleDisplay?.addEventListener("click", () => {
  if (!isNotebookView()) return;
  elements.nbTitleDisplay.classList.add("hidden");
  elements.nbTitleInput?.classList.remove("hidden");
  elements.nbTitleInput?.focus();
  elements.nbTitleInput?.select();
});
elements.nbTitleInput?.addEventListener("blur", () => {
  if (!isNotebookView()) return;
  const v = (elements.nbTitleInput.value ?? "").trim();
  state.notebook.metadata.title = v || deriveTitleFromPath(state.notebookPath);
  elements.nbTitleDisplay?.classList.remove("hidden");
  elements.nbTitleInput?.classList.add("hidden");
  updateHeader();
  setDirty(true);
  queueAutoSave(); // saveNotebookAction will patch the explorer tree after saving
});
elements.nbTitleInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") elements.nbTitleInput.blur();
  if (e.key === "Escape") {
    elements.nbTitleInput.value = state.notebook?.metadata?.title ?? "";
    elements.nbTitleInput.blur();
  }
});

// Ctrl+S / Cmd+S — save notebook from anywhere in the app
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (isNotebookView()) {
      queueNotebookSave().catch(handleError);
    }
  }
});

// Main actions
elements.saveBtn?.addEventListener("click", () =>
  queueNotebookSave().catch(handleError),
);
elements.runAllBtn?.addEventListener("click", () =>
  runAllCells().catch(handleError),
);
elements.clearOutputsBtn?.addEventListener("click", () => {
  if (!isNotebookView()) return;
  for (const cell of state.notebook.cells) {
    cell.outputs = [];
  }
  state.cellTimings.clear();
  setDirty(true);
  renderNotebook();
  showToast("Outputs cleared", "success");
});
elements.aiAssistBtn?.addEventListener("click", () => {
  openAiAssistant(state.activeCellId).catch(handleError);
});
elements.nlpNewBtn?.addEventListener("click", openNewNotebookDialog);
elements.newNotebookBtn?.addEventListener("click", openNewNotebookDialog);
elements.resetExecutionsBtn?.addEventListener("click", () =>
  resetExecutionStats().catch(handleError),
);
elements.resetTokensBtn?.addEventListener("click", () =>
  resetAiTokenStats().catch(handleError),
);

// Add cell — mousedown+preventDefault keeps Monaco focus; set _insertingCell=true HERE
// (before Monaco sees the event) so any blur the editor fires is suppressed immediately.
elements.addCodeButton?.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (!isNotebookView()) return;
  state._insertingCell = true;
  insertCell(state.activeCellId ?? state.notebook.cells.at(-1)?.id, "code");
});
elements.addMarkdownButton?.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (!isNotebookView()) return;
  state._insertingCell = true;
  insertCell(state.activeCellId ?? state.notebook.cells.at(-1)?.id, "markdown");
});
elements.addPromptBtn?.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (!isNotebookView()) return;
  if (!hasGroqKeyConfigured()) {
    showToast(
      "Add GROQ_API_KEY to environment variables to use AI Prompt cells",
      "error",
    );
    return;
  }
  state._insertingCell = true;
  insertCell(state.activeCellId ?? state.notebook.cells.at(-1)?.id, "prompt");
});

// ── Terminal ──────────────────────────────────────────────────────────────
// Open button — event delegation so all .terminal-open-btn instances work
document.addEventListener("click", (e) => {
  if (e.target.closest(".terminal-open-btn")) toggleTerminal();
});

elements.terminalScrim?.addEventListener("click", closeTerminal);
elements.terminalCloseBtn?.addEventListener("click", closeTerminal);

elements.terminalClearBtn?.addEventListener("click", () => {
  state.terminalHistory = [];
  renderTerminalHistory();
});

elements.terminalRunBtn?.addEventListener("click", () => {
  const cmd = elements.terminalInput?.value.trim();
  if (cmd) runTerminalCommand(cmd).catch(handleError);
});

elements.terminalInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const cmd = elements.terminalInput.value.trim();
    if (cmd) runTerminalCommand(cmd).catch(handleError);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    const next = Math.min(
      state.terminalHistoryIdx + 1,
      state.terminalCmdHistory.length - 1,
    );
    state.terminalHistoryIdx = next;
    elements.terminalInput.value = state.terminalCmdHistory[next] ?? "";
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const next = Math.max(state.terminalHistoryIdx - 1, -1);
    state.terminalHistoryIdx = next;
    elements.terminalInput.value =
      next >= 0 ? (state.terminalCmdHistory[next] ?? "") : "";
    return;
  }
});
// ─────────────────────────────────────────────────────────────────────────

/// Explorer toggle — shows/hides the workspace panel (sidebar is always visible)
elements.explorerToggleBtn?.addEventListener("click", cycleSidebarLayout);

// Env panel
elements.envToggle?.addEventListener("click", () => {
  state.envPanelOpen = !state.envPanelOpen;
  renderEnvPanel();
});
elements.envCloseButton?.addEventListener("click", closeEnvPanel);
elements.envModalScrim?.addEventListener("click", closeEnvPanel);
elements.envSaveButton?.addEventListener("click", () => {
  const { isGlobal } = getEnvTarget();
  const rows = elements.envList?.querySelectorAll(".env-row") ?? [];
  const env = {};
  for (const row of rows) {
    const k = row.querySelector(".env-key-input")?.value?.trim() ?? "";
    const v = row.querySelector(".env-val-input")?.value ?? "";
    if (k) env[k] = v;
    row.classList.remove("env-row-dirty");
  }
  if (isGlobal) {
    saveGlobalEnv(env);
  } else {
    ensureNotebookMetadata();
    state.notebook.metadata.env = env;
    setDirty(true);
    queueAutoSave();
  }
  renderEnvPanel();
  if (state.aiAssistantOpen) renderAiAssistant();
  // Show feedback
  const btn = elements.envSaveButton;
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = "Saved ✓";
    btn.classList.add("is-saved");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("is-saved");
    }, 1800);
  }
});
elements.addEnvButton?.addEventListener("click", () => {
  const { env, isGlobal } = getEnvTarget();
  const updated = { ...env };
  let nextKey = "MY_API_KEY";
  if (Object.prototype.hasOwnProperty.call(updated, nextKey)) {
    let index = 2;
    while (Object.prototype.hasOwnProperty.call(updated, `${nextKey}_${index}`))
      index += 1;
    nextKey = `${nextKey}_${index}`;
  }
  updated[nextKey] = "";
  if (isGlobal) {
    saveGlobalEnv(updated);
  } else {
    state.notebook.metadata.env = updated;
    setDirty(true);
  }
  state.envPanelOpen = true;
  renderEnvPanel();
  if (state.aiAssistantOpen) renderAiAssistant();
});

// AI assistant
elements.aiCloseButton?.addEventListener("click", closeAiAssistant);
elements.aiModalScrim?.addEventListener("click", closeAiAssistant);
// "Open Environment Variables" shortcut inside the missing-key panel
document.getElementById("ai-open-env-btn")?.addEventListener("click", () => {
  closeAiAssistant();
  state.envPanelOpen = true;
  renderEnvPanel();
});
elements.aiModelSelect?.addEventListener("change", () => {
  state.aiAssistantModel = elements.aiModelSelect.value;
});
elements.aiChatForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendAiAssistantMessage().catch(handleError);
});
// Enter = send, Shift+Enter = newline
elements.aiChatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendAiAssistantMessage().catch(handleError);
  }
});

// Package docs
elements.packageDocsClose?.addEventListener("click", closePackageDocsDrawer);
elements.packageDocsScrim?.addEventListener("click", closePackageDocsDrawer);

// Theme select — event delegation covers all .theme-select elements across pages
document.addEventListener("change", (e) => {
  const sel = e.target.closest(".theme-select");
  if (sel) applyTheme(sel.value);
});

// Global notebook language toggle — recreates Monaco models with correct URI extension
elements.nbLangToggle?.addEventListener("click", () => {
  if (!state.notebook) return;
  const newLang =
    state.notebookLanguage === "javascript" ? "typescript" : "javascript";
  state.notebookLanguage = newLang;
  if (!state.notebook.metadata) state.notebook.metadata = {};
  state.notebook.metadata.language = newLang;

  for (const cell of state.notebook.cells ?? []) {
    if (cell.type !== "code") continue;
    cell.language = newLang;

    if (state.monaco && modelInstances.has(cell.id)) {
      // Save current source, dispose old model (wrong URI ext), recreate with correct URI
      const oldModel = modelInstances.get(cell.id);
      const source = oldModel.getValue();
      // Remove listener before dispose
      modelListeners.get(cell.id)?.dispose();
      modelListeners.delete(cell.id);
      oldModel.dispose();
      modelInstances.delete(cell.id);

      // Recreate with correct extension (`.ts` or `.mjs`)
      const newUri = getNotebookModelUri(cell.id, newLang);
      const newModel = state.monaco.editor.createModel(source, newLang, newUri);
      let debounce = null;
      const listener = newModel.onDidChangeContent(() => {
        const c = state.notebook.cells.find((x) => x.id === cell.id);
        if (!c) return;
        c.source = newModel.getValue();
        setDirty(true);
        clearTimeout(debounce);
        debounce = setTimeout(() => refreshMonacoLibraries(), 800);
      });
      modelInstances.set(cell.id, newModel);
      modelListeners.set(cell.id, listener);

      // Point the live editor at the new model
      const editor = editorInstances.get(cell.id);
      if (editor) editor.setModel(newModel);
    }
  }
  setDirty(true);
  updateHeader();
  // Re-register extra libs so IntelliSense/auto-import works on new model URIs
  refreshMonacoLibraries();
});

// NLP search filter
elements.nlpSearchInput?.addEventListener("input", () => {
  const q = elements.nlpSearchInput.value.toLowerCase();
  document.querySelectorAll(".nlp-item").forEach((item) => {
    item.classList.toggle(
      "hidden",
      !!q && !item.dataset.name?.toLowerCase().includes(q),
    );
  });
});

// Sidebar nav — SPA routing
document.querySelectorAll(".nav-item[data-page]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo(link.dataset.page);
  });
});

// Breadcrumb "Notebooks" link
document
  .querySelector("#breadcrumb-notebooks")
  ?.addEventListener("click", () => navigateTo("notebooks"));

// Dashboard filter tabs
elements.notebookFilterTabs?.addEventListener("click", (e) => {
  const tab = e.target.closest(".filter-tab");
  if (!tab) return;
  elements.notebookFilterTabs
    .querySelectorAll(".filter-tab")
    .forEach((t) => t.classList.remove("is-active"));
  tab.classList.add("is-active");
  renderDashboardNotebooks(tab.dataset.filter ?? "all");
});

// Dashboard view-all
document.querySelector(".view-all-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  navigateTo("notebooks");
});

// Dashboard search
document
  .querySelector("#dashboard-search")
  ?.addEventListener("input", (e) =>
    renderDashboardNotebooks("all", e.target.value),
  );

// Package category tabs
// Package category sidebar removed — categories listener no longer needed

// Package install
elements.pkgInstallBtn?.addEventListener("click", () => {
  const name = (
    elements.pkgSearchInput?.value ??
    elements.pkgCdnInput?.value ??
    ""
  ).trim();
  if (name) installPackage(name).catch(handleError);
});
elements.pkgSearchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim())
    installPackage(e.target.value.trim()).catch(handleError);
});

window.addEventListener("resize", syncPackageDocsDrawer);
window.addEventListener("popstate", () =>
  handlePopState(window.location.pathname || "/"),
);

/* ===== PAGE ROUTER ===== */
const PAGE_IDS = {
  dashboard: "page-dashboard",
  notebooks: "page-notebook",
  notebook: "page-notebook",
  packages: "page-packages",
};

const NAV_IDS = {
  dashboard: "nav-dashboard",
  notebooks: "nav-notebooks",
  notebook: "nav-notebooks",
  packages: "nav-packages",
};

state.currentPage = "dashboard";

function navigateTo(page, opts = {}) {
  const { historyPath, historyMode = "push" } = opts;

  // hide all pages
  document
    .querySelectorAll(".page-view")
    .forEach((p) => p.classList.add("hidden"));
  // show target
  const targetId = PAGE_IDS[page] ?? "page-dashboard";
  document.getElementById(targetId)?.classList.remove("hidden");

  // update nav active state
  document
    .querySelectorAll(".nav-item")
    .forEach((l) => l.classList.remove("is-active"));
  const navId = NAV_IDS[page];
  if (navId) document.getElementById(navId)?.classList.add("is-active");

  state.currentPage = page;

  // update browser URL
  const path = historyPath ?? (page === "dashboard" ? "/" : `/${page}`);
  if (window.location.pathname !== path) {
    window.history[historyMode === "replace" ? "replaceState" : "pushState"](
      { page },
      "",
      path,
    );
  }

  // Sync workspace mode (terminal visibility etc) on every page change
  updateWorkspaceMode();

  // page-specific side effects
  if (page === "dashboard") {
    loadDashboard().catch(handleError);
  } else if (page === "packages") {
    loadPackagesPage().catch(handleError);
  } else if (page === "notebooks") {
    // Render the file explorer panel; do NOT auto-open any notebook.
    // The user should click a notebook from the list to open it.
    renderNotebookListPanel().catch(handleError);
    // If no notebook is loaded yet, show an empty-state prompt in the canvas.
    if (!state.notebook) {
      if (elements.notebookCells) {
        elements.notebookCells.innerHTML = `<div class="notebook-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;margin-bottom:12px">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <p style="opacity:0.5;font-size:14px">Select a notebook from the Explorer to open it</p>
        </div>`;
      }
    }
  }
}

function handlePopState(path) {
  if (path === "/" || path === "/dashboard") {
    navigateTo("dashboard", { historyPath: path, historyMode: "replace" });
  } else if (path === "/packages") {
    navigateTo("packages", { historyPath: path, historyMode: "replace" });
  } else if (path === "/ai") {
    navigateTo("ai", { historyPath: path, historyMode: "replace" });
  } else if (path === "/history") {
    navigateTo("history", { historyPath: path, historyMode: "replace" });
  } else if (path === "/snippets") {
    navigateTo("snippets", { historyPath: path, historyMode: "replace" });
  } else if (path === "/notebooks") {
    // The /notebooks page (file explorer list) — not a file path
    navigateTo("notebooks", { historyPath: path, historyMode: "replace" });
  } else {
    // /notebooks/my_notebook.ijsnb or any other file path
    openResource(path, { historyMode: "replace" }).catch(handleError);
  }
}

/* ===== DASHBOARD ===== */
let dashboardNotebooks = [];

async function loadDashboard() {
  // Set greeting
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  if (elements.dashboardGreeting)
    elements.dashboardGreeting.textContent = `${greeting} 👋`;

  // Load stats (notebook count, executions, AI tokens) and installed packages count.
  // The two fetches are independent so run them in parallel for speed.
  try {
    // Fetch notebook/execution stats AND the actual installed packages list in parallel.
    // We always fetch installedPackages fresh from the suggestions API so the count
    // matches exactly what the Packages page shows — never the inflated number that
    // /api/stats returns (which includes the app's own root package.json).
    const [stats, pkgData] = await Promise.all([
      api("/api/stats"),
      // Only request suggestions when a notebook is actively open — requesting with
      // a null/stale path causes the server to call ensureNotebook() which
      // auto-recreates a deleted notebook.
      state.notebookPath
        ? api(
            `/api/suggestions?path=${encodeURIComponent(state.notebookPath)}&fields=installedPackages`,
          ).catch(() => null)
        : Promise.resolve(null),
    ]);

    // Update installed packages state so any subsequent navigation is consistent.
    if (pkgData?.installedPackages) {
      state.installedPackages = pkgData.installedPackages;
    }

    if (elements.statNotebooks)
      elements.statNotebooks.textContent = stats.notebookCount ?? 0;
    if (elements.statExecutions)
      elements.statExecutions.textContent = stats.totalExecutions ?? 0;
    if (elements.statPackages)
      elements.statPackages.textContent = state.installedPackages.length;
    if (elements.statTokens)
      elements.statTokens.textContent = stats.aiTokensUsed ?? 0;
  } catch {
    /* ignore */
  }

  // Load notebooks
  try {
    const data = await api("/api/notebooks");
    dashboardNotebooks = data.notebooks ?? [];
    renderDashboardNotebooks("all");
    renderActivityFeed();
  } catch {
    if (elements.notebookGrid)
      elements.notebookGrid.innerHTML = `<div class="notebook-grid-empty">Could not load notebooks</div>`;
  }
}

async function resetExecutionStats() {
  const ok = await confirmAction({
    title: "Reset execution counts?",
    message:
      "All cell execution counters across every notebook will be set to 0.",
    confirmLabel: "Reset counts",
    tone: "danger",
  });
  if (!ok) return;
  await api("/api/stats/reset-executions", { method: "POST" });
  if (elements.statExecutions) elements.statExecutions.textContent = "0";
  // Reset the sub-text below the executions card
  const subEl = document.querySelector("#stat-executions-sub");
  if (subEl) subEl.textContent = "across all notebooks";
  // Reset the Success Rate metric card on the dashboard
  if (elements.metricSuccess) elements.metricSuccess.textContent = "—";
  if (state.notebook?.cells?.length) {
    for (const cell of state.notebook.cells) cell.executionCount = 0;
    state.cellTimings.clear();
    renderNotebook();
    setDirty(true);
    queueNotebookSave({ silent: true });
  }
  showToast("Execution counts reset", "success");
}

async function resetAiTokenStats() {
  const ok = await confirmAction({
    title: "Reset AI token totals?",
    message: "Stored AI token usage will be cleared across all notebooks.",
    confirmLabel: "Reset tokens",
    tone: "danger",
  });
  if (!ok) return;
  await api("/api/stats/reset-ai-tokens", { method: "POST" });
  if (elements.statTokens) elements.statTokens.textContent = "0";
  if (state.notebook?.cells?.length) {
    for (const cell of state.notebook.cells) {
      cell.metrics =
        cell.metrics && typeof cell.metrics === "object" ? cell.metrics : {};
      cell.metrics.aiTokensIn = 0;
      cell.metrics.aiTokensOut = 0;
      cell.metrics.aiTokensTotal = 0;
      cell.metrics.aiTokensUpdatedAt = new Date().toISOString();
    }
    renderNotebook();
    setDirty(true);
    queueNotebookSave({ silent: true });
  }
  showToast("AI token totals reset", "success");
}

function renderDashboardNotebooks(filter = "all", search = "") {
  if (!elements.notebookGrid) return;
  let list = dashboardNotebooks;
  if (filter && filter !== "all") {
    list = list.filter((nb) => {
      if (filter === "typescript") return nb.language === "typescript";
      if (filter === "javascript") return nb.language === "javascript";
      if (filter === "prompt") return nb.language === "prompt";
      return true;
    });
  }
  if (search) {
    const q = search.toLowerCase();
    list = list.filter((nb) => nb.title?.toLowerCase().includes(q));
  }
  if (!list.length) {
    elements.notebookGrid.innerHTML = `<div class="notebook-grid-empty">No notebooks found</div>`;
    return;
  }
  elements.notebookGrid.innerHTML = "";
  for (const nb of list.slice(0, 12)) {
    const lang = nb.language ?? "typescript";
    const langClass =
      lang === "javascript" ? "js" : lang === "prompt" ? "ai" : "ts";
    const langLabel =
      lang === "javascript" ? "JS" : lang === "prompt" ? "AI" : "TS";
    const emoji = langClass === "js" ? "🟨" : langClass === "ai" ? "✨" : "🔷";
    const ago = nb.updatedAt ? timeAgo(new Date(nb.updatedAt)) : "";

    const card = document.createElement("div");
    card.className = "notebook-card";
    card.innerHTML = `
      <div class="notebook-card-header">
        <div class="notebook-card-icon ${langClass}">${emoji}</div>
        <div class="notebook-card-badges">
          <span class="lang-badge ${langClass}">${langLabel}</span>
        </div>
        <button type="button" class="notebook-card-delete" title="Delete notebook" aria-label="Delete notebook">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
      <div class="notebook-card-title">${escapeHtml(nb.title ?? "Untitled")}</div>
      <div class="notebook-card-meta">
        <span>${nb.cellCount ?? 0} cells</span>
        ${ago ? `<span class="notebook-card-meta-sep">·</span><span>${ago}</span>` : ""}
      </div>
    `;
    card.addEventListener("click", () =>
      openResource(nb.appPath).catch(handleError),
    );
    const deleteBtn = card.querySelector(".notebook-card-delete");
    deleteBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteNotebook(nb.path, nb.title ?? "Notebook").catch(handleError);
    });
    elements.notebookGrid.appendChild(card);
  }
}

function renderActivityFeed() {
  if (!elements.activityFeed) return;
  if (!dashboardNotebooks.length) {
    elements.activityFeed.innerHTML = `<div class="activity-empty">No recent activity</div>`;
    return;
  }
  elements.activityFeed.innerHTML = "";
  const recent = dashboardNotebooks.slice(0, 5);
  for (const nb of recent) {
    const item = document.createElement("div");
    item.className = "activity-item";
    item.innerHTML = `
      <span class="activity-dot run"></span>
      <span class="activity-text">Edited <strong>${escapeHtml(nb.title ?? "Untitled")}</strong></span>
      <span class="activity-time">${nb.updatedAt ? timeAgo(new Date(nb.updatedAt)) : ""}</span>
    `;
    item.style.cursor = "pointer";
    item.addEventListener("click", () =>
      openResource(nb.appPath).catch(handleError),
    );
    elements.activityFeed.appendChild(item);
  }

  // Metric cards
  if (elements.metricLines) {
    const totalCells = dashboardNotebooks.reduce(
      (s, nb) => s + (nb.cellCount ?? 0),
      0,
    );
    elements.metricLines.textContent = totalCells;
  }
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/* ===== EXPLORER PANEL (workspace file tree) ===== */

/** Render the full workspace file tree into the left Explorer panel */
async function renderNotebookListPanel() {
  if (!elements.nlpList) return;
  elements.nlpList.innerHTML = `<div class="nlp-empty">Loading workspace…</div>`;
  try {
    // Load root directory if not yet cached
    if (!state.workspaceRoot) {
      const data = await api("/api/files?path=");
      state.workspaceRoot = data.rootPath;
      directoryCache.set(data.directoryPath, data.entries ?? []);
      expandedDirectories.add(data.directoryPath);
    } else if (!directoryCache.has(state.workspaceRoot)) {
      const data = await api(
        `/api/files?path=${encodeURIComponent(state.workspaceRoot)}`,
      );
      directoryCache.set(data.directoryPath, data.entries ?? []);
      expandedDirectories.add(data.directoryPath);
    }
    renderExplorerTree();
  } catch {
    elements.nlpList.innerHTML = `<div class="nlp-empty">Failed to load workspace</div>`;
  }
}

function renderExplorerTree() {
  if (!elements.nlpList) return;
  elements.nlpList.innerHTML = "";
  const root = state.workspaceRoot;
  if (!root || !directoryCache.has(root)) {
    elements.nlpList.innerHTML = `<div class="nlp-empty">No workspace</div>`;
    return;
  }
  renderExplorerEntries(elements.nlpList, directoryCache.get(root) ?? [], 0);
}

function renderExplorerEntries(container, entries, depth) {
  for (const entry of entries) {
    const group = document.createElement("div");

    const row = document.createElement("div");
    const isActive = entry.path === state.activePath;
    row.className = "nlp-item" + (isActive ? " is-active" : "");
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.name = entry.name ?? "";
    row.dataset.path = entry.path ?? "";

    // ▶ / ▼ chevron for folders; invisible spacer for files so names align
    const isExpanded = expandedDirectories.has(entry.path);
    const chevron = document.createElement("span");
    chevron.className = "nlp-item-chevron";
    chevron.textContent = entry.expandable
      ? isExpanded
        ? "\u25BC"
        : "\u25B6"
      : "";

    // Folder / file icon (Material Icon Theme SVGs)
    const icon = document.createElement("span");
    icon.className = "explorer-icon";
    icon.innerHTML = getMaterialIcon(
      entry.name ?? "",
      !!entry.expandable,
      isExpanded,
    );

    const name = document.createElement("span");
    name.className = "nlp-item-name";
    name.textContent = entry.name ?? "";

    row.append(chevron, icon, name);

    // Delete button — shown on hover for files and folders
    {
      const entryName = entry.name ?? "";
      const PROTECTED_FILES = new Set([
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
      ]);
      const isNotebook = entryName.endsWith(".ijsnb");
      const shouldShowDelete = entry.expandable
        ? !["node_modules", ".git"].includes(entryName) // allow delete for most folders
        : !PROTECTED_FILES.has(entryName);

      if (shouldShowDelete) {
        const delBtn = document.createElement("button");
        delBtn.className = "nlp-item-delete";
        delBtn.type = "button";
        delBtn.title = entry.expandable
          ? `Delete folder "${entryName}"`
          : `Delete ${isNotebook ? "notebook" : "file"}`;
        delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
        delBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          if (entry.expandable) {
            deleteFolder(entry.path, entryName).catch(handleError);
          } else if (isNotebook) {
            deleteNotebook(
              entry.path,
              entryName.replace(/\.ijsnb$/i, "") || "Notebook",
            ).catch(handleError);
          } else {
            deleteFile(entry.path, entryName).catch(handleError);
          }
        });
        row.appendChild(delBtn);
      }
    }

    // Non-openable, non-expandable files get a disabled appearance and no click action
    if (!entry.openable && !entry.expandable) {
      row.classList.add("nlp-item--disabled");
      row.style.cursor = "default";
      row.style.opacity = "0.5";
    } else {
      row.addEventListener("click", async () => {
        try {
          if (entry.expandable) {
            if (expandedDirectories.has(entry.path)) {
              expandedDirectories.delete(entry.path);
            } else {
              if (!directoryCache.has(entry.path)) {
                const data = await api(
                  `/api/files?path=${encodeURIComponent(entry.path)}`,
                );
                directoryCache.set(data.directoryPath, data.entries ?? []);
              }
              expandedDirectories.add(entry.path);
            }
            renderExplorerTree();
            return;
          }
          if (entry.openable) {
            await openResource(entry.path);
            renderExplorerTree();
            return;
          }
        } catch (err) {
          handleError(err);
        }
      });
    }

    group.appendChild(row);

    // Render children if expanded
    if (entry.expandable && expandedDirectories.has(entry.path)) {
      const children = directoryCache.get(entry.path) ?? [];
      const childWrap = document.createElement("div");
      renderExplorerEntries(childWrap, children, depth + 1);
      group.appendChild(childWrap);
    }

    container.appendChild(group);
  }
}

/* ─── SVG File Icons ─────────────────────────────────────────────────────── */

/**
 * Map a folder name to its icon key (matches the `folder-<key>.svg` filenames
 * available in /public/icons/).
 */
function _folderIconKey(nameLower) {
  const map = {
    // Source / build
    src: "src",
    source: "src",
    lib: "src",
    library: "src",
    dist: "dist",
    build: "dist",
    out: "dist",
    output: "dist",
    target: "target",
    // Version control
    ".git": "git",
    git: "git",
    ".github": "github",
    github: "github",
    // Dependencies / packages
    node_modules: "packages",
    packages: "packages",
    // Public / static
    public: "public",
    static: "public",
    // Testing
    test: "test",
    tests: "test",
    __tests__: "test",
    spec: "test",
    specs: "test",
    e2e: "test",
    // Claude / AI
    ".claude": "claude",
    claude: "claude",
    gemini: "gemini-ai",
    "gemini-ai": "gemini-ai",
    // Cloud / services
    aws: "aws",
    firebase: "firebase",
    firestore: "firestore",
    supabase: "supabase",
    azure: "other",
    // Docs
    docs: "docs",
    doc: "docs",
    documentation: "docs",
    // Assets
    assets: "images",
    images: "images",
    img: "images",
    icons: "icons",
    svg: "svg",
    svgs: "svg",
    font: "font",
    fonts: "font",
    video: "video",
    videos: "video",
    audio: "other",
    pdf: "pdf",
    pdfs: "pdf",
    // Styling
    styles: "css",
    css: "css",
    scss: "sass",
    sass: "sass",
    // Components / UI
    components: "components",
    views: "views",
    pages: "views",
    ui: "ui",
    element: "element",
    elements: "element",
    // API / networking
    api: "api",
    routes: "routes",
    server: "server",
    serverless: "serverless",
    connection: "connection",
    connections: "connection",
    middleware: "middleware",
    controller: "controller",
    controllers: "controller",
    // Config
    config: "config",
    configs: "config",
    ".config": "config",
    configuration: "config",
    environment: "environment",
    environments: "environment",
    env: "environment",
    // Scripts / tools
    scripts: "scripts",
    bin: "scripts",
    tools: "tools",
    tool: "tools",
    commands: "command",
    command: "command",
    // Utils / helpers
    utils: "utils",
    utilities: "utils",
    helpers: "helper",
    helper: "helper",
    shared: "utils",
    hooks: "functions",
    functions: "functions",
    function: "functions",
    fn: "functions",
    // Data
    database: "database",
    db: "database",
    databases: "database",
    store: "store",
    stores: "store",
    storage: "store",
    migrations: "migrations",
    migration: "migrations",
    repository: "repository",
    repositories: "repository",
    repo: "repository",
    repos: "repository",
    // App structure
    admin: "admin",
    app: "app",
    client: "client",
    core: "core",
    features: "features",
    feature: "features",
    home: "home",
    project: "project",
    projects: "project",
    // Languages
    python: "python",
    py: "python",
    java: "java",
    javascript: "javascript",
    js: "javascript",
    typescript: "typescript",
    ts: "typescript",
    // Misc
    archive: "archive",
    archives: "archive",
    attachment: "attachment",
    attachments: "attachment",
    backup: "backup",
    backups: "backup",
    class: "class",
    classes: "class",
    console: "console",
    container: "container",
    containers: "container",
    content: "content",
    context: "context",
    custom: "custom",
    decorators: "decorators",
    desktop: "desktop",
    download: "download",
    downloads: "download",
    dtos: "dtos",
    error: "error",
    errors: "error",
    event: "event",
    events: "event",
    examples: "examples",
    example: "examples",
    expo: "expo",
    export: "export",
    exports: "export",
    filter: "filter",
    filters: "filter",
    interface: "interface",
    interfaces: "interface",
    ios: "ios",
    other: "other",
    plugin: "plugin",
    plugins: "plugin",
    rules: "rules",
    skills: "skills",
    skill: "skills",
    stack: "stack",
    tasks: "tasks",
    task: "tasks",
    temp: "temp",
    tmp: "temp",
    template: "template",
    templates: "template",
    upload: "upload",
    uploads: "upload",
  };
  return map[nameLower] ?? "other";
}

/**
 * Map a filename to the path of the best-matching icon SVG file in /icons/.
 * Returns a path string like "/icons/typescript.svg".
 */
function _fileIconPath(name) {
  const lower = name.toLowerCase();

  // ── Special full filenames ──────────────────────────────────────────────
  const byName = {
    "package.json": "npm.svg",
    "package-lock.json": "npm.svg",
    ".npmrc": "npm.svg",
    "npm-debug.log": "npm.svg",
    "yarn.lock": "npm.svg",
    ".yarnrc": "npm.svg",
    "pnpm-lock.yaml": "npm.svg",
    "bun.lockb": "bun.svg",
    "bun.lock": "bun.svg",
    ".gitignore": "git.svg",
    ".gitattributes": "git.svg",
    ".gitmodules": "git.svg",
    ".gitkeep": "git.svg",
    dockerfile: "docker.svg",
    ".dockerignore": "docker.svg",
    ".babelrc": "babel.svg",
    ".babelrc.json": "babel.svg",
    ".babelrc.js": "babel.svg",
    "babel.config.js": "babel.svg",
    "babel.config.ts": "babel.svg",
    "babel.config.json": "babel.svg",
    ".prettierrc": "prettier.svg",
    ".prettierrc.json": "prettier.svg",
    ".prettierrc.js": "prettier.svg",
    ".prettierrc.cjs": "prettier.svg",
    ".prettierrc.yaml": "prettier.svg",
    ".prettierrc.yml": "prettier.svg",
    "prettier.config.js": "prettier.svg",
    "prettier.config.ts": "prettier.svg",
    "prettier.config.cjs": "prettier.svg",
    "nodemon.json": "nodemon.svg",
    "readme.md": "readme.svg",
    "readme.txt": "readme.svg",
    readme: "readme.svg",
    "favicon.ico": "favicon.svg",
    "favicon.svg": "favicon.svg",
    "favicon.png": "favicon.svg",
    "tailwind.config.js": "tailwindcss.svg",
    "tailwind.config.ts": "tailwindcss.svg",
    "tailwind.config.mjs": "tailwindcss.svg",
    "tailwind.config.cjs": "tailwindcss.svg",
    "jsconfig.json": "jsconfig.svg",
    "firebase.json": "firebase.svg",
    ".firebaserc": "firebase.svg",
    "prisma.schema": "prisma.svg",
    ".env": "document.svg",
    ".env.local": "document.svg",
    ".env.example": "document.svg",
    ".env.production": "document.svg",
    ".env.development": "document.svg",
    "tsconfig.json": "typescript.svg",
    "tsconfig.base.json": "typescript.svg",
    "tsconfig.app.json": "typescript.svg",
    "tsconfig.node.json": "typescript.svg",
    license: "document.svg",
    licence: "document.svg",
    makefile: "document.svg",
    gemfile: "document.svg",
  };
  if (byName[lower]) return `/icons/${byName[lower]}`;

  // ── Compound extensions (check before simple extension) ─────────────────
  if (
    lower.endsWith(".d.ts") ||
    lower.endsWith(".d.mts") ||
    lower.endsWith(".d.cts")
  ) {
    return "/icons/typescript-def.svg";
  }
  if (lower.endsWith(".css.map")) return "/icons/css-map.svg";
  if (
    lower.includes("tailwind") &&
    (lower.endsWith(".js") || lower.endsWith(".ts"))
  ) {
    return "/icons/tailwindcss.svg";
  }
  if (
    (lower.includes("babel") || lower.startsWith(".babel")) &&
    (lower.endsWith(".js") || lower.endsWith(".json"))
  ) {
    return "/icons/babel.svg";
  }
  if (
    lower.includes("prettier") &&
    (lower.endsWith(".js") || lower.endsWith(".cjs"))
  ) {
    return "/icons/prettier.svg";
  }

  // ── Extension-based mapping ─────────────────────────────────────────────
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  const byExt = {
    // JavaScript
    js: "javascript.svg",
    mjs: "javascript.svg",
    cjs: "javascript.svg",
    jsx: "react.svg",
    // TypeScript
    ts: "typescript.svg",
    mts: "typescript.svg",
    cts: "typescript.svg",
    tsx: "react_ts.svg",
    // Web
    html: "html.svg",
    htm: "html.svg",
    css: "css.svg",
    scss: "sass.svg",
    sass: "sass.svg",
    less: "css.svg",
    ejs: "ejs.svg",
    // Data / config
    json: "json.svg",
    yaml: "document.svg",
    yml: "document.svg",
    toml: "document.svg",
    xml: "document.svg",
    csv: "document.svg",
    graphql: "graphql.svg",
    gql: "graphql.svg",
    prisma: "prisma.svg",
    // Markdown / text
    md: "markdown.svg",
    mdx: "markdown.svg",
    txt: "document.svg",
    rst: "document.svg",
    // Images
    svg: "svg.svg",
    png: "image.svg",
    jpg: "image.svg",
    jpeg: "image.svg",
    gif: "image.svg",
    webp: "image.svg",
    avif: "image.svg",
    ico: "image.svg",
    bmp: "image.svg",
    tif: "image.svg",
    tiff: "image.svg",
    // Documents
    pdf: "pdf.svg",
    doc: "document.svg",
    docx: "document.svg",
    xls: "document.svg",
    xlsx: "document.svg",
    ppt: "document.svg",
    pptx: "document.svg",
    // Audio
    mp3: "audio.svg",
    wav: "audio.svg",
    ogg: "audio.svg",
    flac: "audio.svg",
    aac: "audio.svg",
    m4a: "audio.svg",
    // Fonts
    ttf: "font.svg",
    woff: "font.svg",
    woff2: "font.svg",
    otf: "font.svg",
    eot: "font.svg",
    // Archives
    zip: "zip.svg",
    tar: "zip.svg",
    gz: "zip.svg",
    rar: "zip.svg",
    "7z": "zip.svg",
    tgz: "zip.svg",
    // Executables / binaries
    exe: "exe.svg",
    dmg: "exe.svg",
    // Databases
    db: "database.svg",
    sqlite: "database.svg",
    sql: "database.svg",
    // Shell / scripting
    sh: "console.svg",
    bash: "console.svg",
    zsh: "console.svg",
    fish: "console.svg",
    cmd: "console.svg",
    bat: "console.svg",
    ps1: "console.svg",
    // Other languages
    py: "python.svg",
    java: "java.svg",
    class: "javaclass.svg",
    c: "c.svg",
    h: "c.svg",
    cpp: "cpp.svg",
    cc: "cpp.svg",
    cxx: "cpp.svg",
    hpp: "cpp.svg",
    // Notebook
    ijsnb: "typescript.svg",
    // Misc
    map: "css-map.svg",
    log: "document.svg",
    lock: "document.svg",
    remark: "remark.svg",
  };

  if (byExt[ext]) return `/icons/${byExt[ext]}`;
  return "/icons/document.svg";
}

/** Return an <img> HTML string for a workspace entry using the /icons/ SVG files. */
function getMaterialIcon(name, isDirectory, isExpanded) {
  let src;
  if (isDirectory) {
    const key = _folderIconKey(name.toLowerCase());
    src = isExpanded
      ? `/icons/folder-${key}-open.svg`
      : `/icons/folder-${key}.svg`;
  } else {
    src = _fileIconPath(name);
  }
  return `<img src="${src}" width="16" height="16" alt="" draggable="false" style="display:block;flex-shrink:0">`;
}

/* ===== PACKAGES PAGE ===== */
let pkgBrowseResults = [];

async function loadPackagesPage() {
  // The packages page only needs the list of installed packages and available
  // modules — typeLibraries and packageExports are only used by Monaco in the
  // notebook editor, so we skip them here to keep the request fast and small.
  try {
    const data = await api(
      `/api/suggestions?path=${encodeURIComponent(state.notebookPath)}&fields=modules,installedPackages`,
    );
    state.installedPackages = data.installedPackages ?? data.modules ?? [];
    state.modules = data.modules ?? state.modules;
    // Intentionally do NOT overwrite state.typeLibraries / state.packageExports —
    // the notebook editor may already have those loaded and we don't want to wipe them.
  } catch (e) {
    // fallback to cached state if the request fails
  }

  // Show installed packages by default
  if (elements.pkgCountInstalled)
    elements.pkgCountInstalled.textContent = state.installedPackages.length;
  const aiPkgs = state.installedPackages.filter((p) =>
    [
      "openai",
      "langchain",
      "@langchain",
      "groq",
      "anthropic",
      "cohere",
      "huggingface",
      "transformers",
      "llamaindex",
    ].some((k) => p.includes(k)),
  );
  if (elements.pkgCountAi) elements.pkgCountAi.textContent = aiPkgs.length;
  if (elements.pkgCatCount)
    elements.pkgCatCount.textContent = state.installedPackages.length;
  renderPackageList("installed");
  renderPackageSuggestions();
}

function renderPackageList(cat = "installed") {
  if (!elements.pkgList) return;
  if (elements.pkgListTitle) {
    const titles = {
      installed: "Installed Packages",
      browse: "Browse npm",
      ai: "AI / ML Libraries",
      types: "@types Packages",
      utils: "Utilities",
    };
    elements.pkgListTitle.textContent = titles[cat] ?? "Packages";
  }

  const descFor = (name) => {
    if (name.includes("openai")) return "OpenAI API client";
    if (name.includes("langchain")) return "LLM orchestration framework";
    if (name.includes("groq")) return "Groq LLM API client";
    if (name.includes("anthropic")) return "Anthropic Claude API";
    if (name.includes("cohere")) return "Cohere AI SDK";
    if (name.includes("llamaindex")) return "LlamaIndex framework";
    if (name.startsWith("@types/"))
      return `TypeScript types for ${name.slice(7)}`;
    if (name === "lodash") return "Utility library for JS";
    if (name === "dayjs") return "Lightweight date library";
    if (name === "zod") return "TypeScript-first schema validation";
    if (name === "axios") return "Promise-based HTTP client";
    if (name === "uuid") return "UUID generation library";
    return "Installed in this notebook";
  };

  const badgeFor = (name) => {
    if (
      ["openai", "langchain", "groq", "anthropic", "cohere", "llamaindex", "langgraph"].some(
        (k) => name.includes(k),
      )
    )
      return { label: "AI", cls: "badge-ai" };
    if (name.startsWith("@types/"))
      return { label: "Types", cls: "badge-types" };
    if (
      ["lodash", "dayjs", "zod", "axios", "uuid"].some((k) => name.includes(k))
    )
      return { label: "Utils", cls: "badge-utils" };
    return { label: "npm", cls: "badge-default" };
  };

  const pkgs = cat === "installed" ? state.installedPackages : [];

  if (!pkgs.length) {
    elements.pkgList.innerHTML = `<div class="pkg-loading">${cat === "installed" ? "No packages installed yet. Search above to add one." : "Browse functionality coming soon"}</div>`;
    return;
  }

  elements.pkgList.innerHTML = "";
  for (const name of pkgs) {
    const badge = badgeFor(name);
    const card = document.createElement("div");
    card.className = "pkg-installed-card";
    card.innerHTML = `
      <div class="pkg-installed-card-top">
        <span class="pkg-installed-name">${escapeHtml(name)}</span>
        <span class="pkg-installed-badge ${badge.cls}">${badge.label}</span>
      </div>
      <div class="pkg-installed-desc">${escapeHtml(descFor(name))}</div>
      <div class="pkg-installed-actions">
        <button class="pkg-installed-docs" type="button">Docs</button>
        <button class="pkg-installed-remove" type="button">Remove</button>
      </div>
    `;
    card
      .querySelector(".pkg-installed-docs")
      .addEventListener("click", () =>
        openPackageDocs(name).catch(handleError),
      );
    card
      .querySelector(".pkg-installed-remove")
      .addEventListener("click", function () {
        const btn = this;
        btn.disabled = true;
        btn.textContent = "Removing…";
        uninstallPackage(name).catch((err) => {
          btn.disabled = false;
          btn.textContent = "Remove";
          handleError(err);
        });
      });
    elements.pkgList.appendChild(card);
  }
}

function renderPackageSuggestions() {
  if (!elements.pkgSuggestionsGrid) return;
  const suggestions = genAIPackages.filter((s) => !state.installedPackages.includes(s.name));

  elements.pkgSuggestionsGrid.innerHTML = "";
  for (const s of suggestions) {
    const card = document.createElement("div");
    card.className = "pkg-suggestion-card";
    card.innerHTML = `
      <div class="pkg-suggestion-name">${escapeHtml(s.name)}</div>
      <div class="pkg-suggestion-desc">${escapeHtml(s.desc)}</div>
      <button class="pkg-suggestion-add" type="button">+ Add to notebook</button>
    `;
    card
      .querySelector(".pkg-suggestion-add")
      .addEventListener("click", () =>
        installPackage(s.name).catch(handleError),
      );
    elements.pkgSuggestionsGrid.appendChild(card);
  }
}

async function installPackage(name) {
  // Always install using the current (or default) notebook path — no need to
  // have a notebook explicitly open; packages land in the workspace root dir.
  showToast(`Installing ${name}…`, "info");
  const cmd = `npm install ${name} --force`;
  const result = await api("/api/shell", {
    method: "POST",
    body: JSON.stringify({ command: cmd, path: state.notebookPath }),
  });
  if (result.ok) {
    // Incremental update: only fetch types for the newly installed package
    // (plus its direct deps, which the server expands automatically).
    // This is O(1 package) instead of O(all packages), so even 100 installed
    // packages won't slow down the post-install type refresh.
    try {
      const data = await api(
        `/api/suggestions?path=${encodeURIComponent(state.notebookPath)}` +
          `&fields=modules,installedPackages,typeLibraries,packageExports` +
          `&packages=${encodeURIComponent(name)}`,
      );
      mergeSuggestionsIntoState(data);
      refreshMonacoLibraries();
    } catch {
      // Fallback: full reload if incremental fetch fails
      await loadSuggestions();
    }
    showToast(`${name} installed`, "success");
    if (state.currentPage === "packages") loadPackagesPage().catch(() => {});
  } else {
    showToast(`Failed to install ${name}`, "error");
  }
}

async function uninstallPackage(name) {
  const result = await api("/api/shell", {
    method: "POST",
    body: JSON.stringify({
      command: `npm uninstall ${name} --force`,
      path: state.notebookPath,
    }),
  });
  if (result.ok) {
    // Remove the uninstalled package's types from state locally — no round-trip needed.
    state.typeLibraries = state.typeLibraries.filter(
      (l) => l.moduleName !== name,
    );
    state.packageExports = state.packageExports.filter(
      (e) => e.moduleName !== name,
    );
    // Refresh installed packages list (cheap call, no types)
    try {
      const data = await api(
        `/api/suggestions?path=${encodeURIComponent(state.notebookPath)}&fields=modules,installedPackages`,
      );
      state.modules = data.modules ?? state.modules;
      state.installedPackages =
        data.installedPackages ?? state.installedPackages;
    } catch {
      /* ignore */
    }
    refreshMonacoLibraries();
    showToast(`${name} removed`, "success");
    if (state.currentPage === "packages") loadPackagesPage().catch(() => {});
  }
}

/* ===== BOOTSTRAP ===== */
async function bootstrap() {
  const _saved = localStorage.getItem("nodebook-theme");
  applyTheme(THEMES[_saved] ? _saved : "antariksha");
  document.querySelectorAll(".theme-select").forEach((sel) => {
    sel.value = state.theme;
  });
  await loadMonaco();
  updateWorkspaceMode();

  const path = window.location.pathname || "/";
  // Determine initial page from URL
  if (path === "/" || path === "/dashboard") {
    // Auto-restore last opened notebook (or open startup.ijsnb on first launch)
    const lastPath = localStorage.getItem("marsbook-last-notebook");
    const restorePath = lastPath || "/notebooks/startup.ijsnb";
    try {
      await openResource(restorePath, { historyMode: "replace" });
    } catch {
      if (lastPath) localStorage.removeItem("marsbook-last-notebook");
      navigateTo("dashboard", { historyPath: "/dashboard", historyMode: "replace" });
    }
  } else if (path === "/packages") {
    navigateTo("packages", { historyPath: path, historyMode: "replace" });
    await loadSuggestions();
  } else if (path === "/ai" || path === "/history" || path === "/snippets") {
    navigateTo(path.slice(1), { historyPath: path, historyMode: "replace" });
  } else if (path === "/notebooks") {
    // The /notebooks page shows the file explorer — not a file to open
    navigateTo("notebooks", { historyPath: path, historyMode: "replace" });
  } else {
    // /notebooks/my_notebook.ijsnb or any other workspace file path
    await openResource(path, { historyMode: "replace" });
  }
}

bootstrap().catch(handleError);
