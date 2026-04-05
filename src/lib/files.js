import path from "node:path";

import { NOTEBOOK_EXTENSION } from "./notebook.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".js", ".ts"]);
const PDF_EXTENSION = ".pdf";

// The URL prefix used in the browser for all workspace files.
// e.g. workspaceRoot/my_notebook.ijsnb  →  /notebooks/my_notebook.ijsnb
//      workspaceRoot/any_folder/basic.ijsnb  →  /notebooks/any_folder/basic.ijsnb
export const NOTEBOOKS_URL_PREFIX = "notebooks";

export function getOpenableFileKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === NOTEBOOK_EXTENSION) {
    return "notebook";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }

  if (extension === PDF_EXTENSION) {
    return "pdf";
  }

  return null;
}

export function isOpenableFile(filePath) {
  return getOpenableFileKind(filePath) !== null;
}

export function sanitizeNotebookTitle(title) {
  const normalized = String(title ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "untitled";
}

export function deriveNotebookPathFromTitle(notebookPath, title) {
  const directory = path.dirname(notebookPath);
  const fileName = `${sanitizeNotebookTitle(title)}${NOTEBOOK_EXTENSION}`;
  return path.join(directory, fileName);
}

/**
 * Convert an absolute workspace file path to the browser URL path.
 *
 * All workspace files are mounted under the /notebooks/ URL prefix so the
 * browser always shows a clean, predictable path regardless of where the
 * physical file lives:
 *
 *   workspaceRoot/my_notebook.ijsnb          →  /notebooks/my_notebook.ijsnb
 *   workspaceRoot/any_folder/basic.ijsnb     →  /notebooks/any_folder/basic.ijsnb
 *   workspaceRoot/demo.jpg                   →  /notebooks/demo.jpg
 */
export function getAppPathFromWorkspacePath(projectRoot, notebooksDir, absolutePath) {
  const relativePath = path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
  return `/${NOTEBOOKS_URL_PREFIX}/${relativePath}`;
}

/**
 * Resolve a client-supplied path (which may be a browser URL path like
 * "/notebooks/any_folder/basic.ijsnb" or an absolute filesystem path) to an
 * absolute path on disk inside the workspace.
 *
 * The /notebooks/ URL prefix is stripped before resolution so that URL paths
 * map cleanly onto workspace-root-relative file paths.
 */
export function resolveWorkspaceOpenPath(projectRoot, notebooksDir, requestedPath, options = {}) {
  const { allowNotebookCreate = false } = options;
  const existsSync = options.existsSync ?? (() => false);

  if (!requestedPath) {
    return null;
  }

  const requestedStr = String(requestedPath).trim();

  // Absolute filesystem path that lives inside the workspace — return as-is.
  // We check startsWith(projectRoot) first so that real OS paths are handled
  // before the URL-prefix stripping logic below.
  if (path.isAbsolute(requestedStr) && requestedStr.startsWith(projectRoot)) {
    return requestedStr;
  }

  // Strip leading slashes, then strip the /notebooks/ URL prefix if present.
  // This lets the frontend pass browser URL paths like "/notebooks/my_notebook.ijsnb"
  // and have them resolve correctly to workspaceRoot-relative file paths.
  let normalized = requestedStr.replace(/^\/+/, "");

  // Strip the URL prefix "notebooks/" → remainder is workspace-root-relative
  if (normalized.startsWith(`${NOTEBOOKS_URL_PREFIX}/`)) {
    normalized = normalized.slice(`${NOTEBOOKS_URL_PREFIX}/`.length);
  }

  if (!normalized) {
    return null;
  }

  // Resolve the path relative to the workspace root.
  const candidate = path.resolve(projectRoot, normalized);

  if (!candidate.startsWith(projectRoot)) {
    return null;
  }

  if (existsSync(candidate)) {
    return candidate;
  }

  // Try appending the notebook extension if it is missing.
  const notebookWithExtension = candidate.endsWith(NOTEBOOK_EXTENSION)
    ? candidate
    : `${candidate}${NOTEBOOK_EXTENSION}`;

  if (existsSync(notebookWithExtension)) {
    return notebookWithExtension;
  }

  if (allowNotebookCreate) {
    const withExtension = candidate.endsWith(NOTEBOOK_EXTENSION)
      ? candidate
      : `${candidate}${NOTEBOOK_EXTENSION}`;

    if (withExtension.startsWith(projectRoot)) {
      return withExtension;
    }
  }

  return null;
}
