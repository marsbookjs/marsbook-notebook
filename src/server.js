import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import prettier from "prettier";
import * as prettierPluginBabel from "prettier/plugins/babel";
import * as prettierPluginEstree from "prettier/plugins/estree";
import * as prettierPluginMarkdown from "prettier/plugins/markdown";
import * as prettierPluginTypeScript from "prettier/plugins/typescript";

import {
  deriveNotebookPathFromTitle,
  getAppPathFromWorkspacePath,
  getOpenableFileKind,
  isOpenableFile,
  resolveWorkspaceOpenPath
} from "./lib/files.js";
import { createNotebook, normalizeNotebook, NOTEBOOK_EXTENSION } from "./lib/notebook.js";
import { collectDeclaredPackageExports } from "./lib/package-exports.js";
import { KernelSession } from "./lib/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const publicDir = path.join(packageRoot, "public");

// Resolve monaco-editor using Node's module resolution so it works whether
// the package is nested (local install) or hoisted (npx / global install).
const _require = createRequire(import.meta.url);
let monacoDir;
try {
  monacoDir = path.join(path.dirname(_require.resolve("monaco-editor/package.json")), "min");
} catch {
  // Fallback to the expected local path if resolution somehow fails
  monacoDir = path.join(packageRoot, "node_modules", "monaco-editor", "min");
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf"
};

const GROQ_MODELS_FALLBACK = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b"
];

/**
 * Fetch the live model list from Groq, filter to llama/openai models only,
 * return at most 5. Falls back to GROQ_MODELS_FALLBACK if the call fails or
 * no API key is available.
 */
async function fetchGroqModels(apiKey) {
  if (!apiKey) return GROQ_MODELS_FALLBACK;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return GROQ_MODELS_FALLBACK;
    const json = await res.json();
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id) => typeof id === "string" && (id.startsWith("llama") || id.startsWith("openai/")))
      .slice(0, 5);
    return ids.length ? ids : GROQ_MODELS_FALLBACK;
  } catch {
    return GROQ_MODELS_FALLBACK;
  }
}

function estimateTokens(text = "") {
  return Math.max(0, Math.ceil(String(text ?? "").length / 4));
}

function json(response, statusCode, body, compact = false) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  // Use compact JSON for large machine-to-machine payloads (e.g. type libraries)
  response.end(compact ? JSON.stringify(body) : JSON.stringify(body, null, 2));
}

function notFound(response) {
  json(response, 404, { error: "Not found" });
}

function resolveNotebookPath(workspaceRoot, notebooksDir, requestedPath) {
  if (!requestedPath) {
    // Default: create untitled.ijsnb directly in the workspace root
    return path.join(workspaceRoot, `untitled${NOTEBOOK_EXTENSION}`);
  }

  // Strip the /notebooks/ URL prefix if the frontend passed a browser URL path.
  // e.g. "/notebooks/my_notebook.ijsnb" → "my_notebook.ijsnb"
  //      "/notebooks/any_folder/basic.ijsnb" → "any_folder/basic.ijsnb"
  let cleanPath = requestedPath;
  if (!path.isAbsolute(cleanPath)) {
    cleanPath = cleanPath.replace(/^\/+/, "");
    if (cleanPath.startsWith("notebooks/")) {
      cleanPath = cleanPath.slice("notebooks/".length);
    }
  }

  const absolute = path.isAbsolute(cleanPath)
    ? cleanPath
    : path.resolve(workspaceRoot, cleanPath);

  const withExtension = absolute.endsWith(NOTEBOOK_EXTENSION) ? absolute : `${absolute}${NOTEBOOK_EXTENSION}`;

  // Security: ensure the resolved path is inside the workspace
  if (!withExtension.startsWith(workspaceRoot)) {
    return path.join(workspaceRoot, path.basename(withExtension));
  }

  return withExtension;
}

function resolveWorkspacePath(workspaceRoot, requestedPath) {
  const absolute = requestedPath
    ? path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(workspaceRoot, requestedPath)
    : workspaceRoot;

  if (!absolute.startsWith(workspaceRoot)) {
    throw new Error("Path is outside the workspace");
  }

  return absolute;
}

// Folders that should never appear in the workspace file explorer.
const HIDDEN_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".nodebook-cache",
  ".git",
  "env",
  "dist",
  "build",
  ".next",
  ".nuxt"
]);

// Files that should never appear in the workspace file explorer.
const HIDDEN_FILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml"
]);

async function listDirectoryEntries(workspaceRoot, directoryPath) {
  const directoryEntries = await fs.promises.readdir(directoryPath, {
    withFileTypes: true
  });

  return directoryEntries
    .filter((entry) => {
      if (entry.name.startsWith(".")) return false;
      if (entry.isDirectory() && HIDDEN_DIRECTORY_NAMES.has(entry.name)) return false;
      if (!entry.isDirectory() && HIDDEN_FILE_NAMES.has(entry.name)) return false;
      return true;
    })
    .map((entry) => {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(workspaceRoot, absolutePath) || ".";
      const isDirectory = entry.isDirectory();

      return {
        name: entry.name,
        path: absolutePath,
        relativePath,
        type: isDirectory ? "directory" : "file",
        openable: !isDirectory && isOpenableFile(absolutePath),
        fileKind: !isDirectory ? getOpenableFileKind(absolutePath) : null,
        expandable: isDirectory
      };
    })
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ensureNotebook(notebookPath) {
  await fs.promises.mkdir(path.dirname(notebookPath), { recursive: true });

  if (!fs.existsSync(notebookPath)) {
    const notebook = createNotebook(path.basename(notebookPath, NOTEBOOK_EXTENSION));
    await fs.promises.writeFile(notebookPath, JSON.stringify(notebook, null, 2));
    return notebook;
  }

  const raw = await fs.promises.readFile(notebookPath, "utf8");

  // Handle blank or malformed .ijsnb files created externally (e.g. `touch notebook.ijsnb`).
  // Rather than crashing with "Unexpected end of JSON input", we initialise a fresh
  // notebook with a single empty code cell and write it back so the file is valid.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const notebook = createNotebook(path.basename(notebookPath, NOTEBOOK_EXTENSION));
    await fs.promises.writeFile(notebookPath, JSON.stringify(notebook, null, 2));
    return notebook;
  }

  return normalizeNotebook(parsed);
}

async function saveNotebook(notebookPath, notebook) {
  const normalized = normalizeNotebook(notebook);
  await fs.promises.mkdir(path.dirname(notebookPath), { recursive: true });
  await fs.promises.writeFile(notebookPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

async function saveNotebookAtPath(currentPath, notebook, nextPath = currentPath) {
  const normalized = normalizeNotebook(notebook);
  const targetPath = nextPath || currentPath;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, JSON.stringify(normalized, null, 2));

  if (currentPath !== targetPath && fs.existsSync(currentPath)) {
    await fs.promises.unlink(currentPath);
  }

  return {
    notebook: normalized,
    notebookPath: targetPath
  };
}

function createNotebookRequire(notebookPath) {
  return createRequire(path.join(path.dirname(notebookPath), "__nodebook__.cjs"));
}

/**
 * Find the root directory of an @types/ package by walking up the directory tree.
 *
 * `@types/*` packages contain ONLY `.d.ts` declaration files — they have no
 * JavaScript entry point.  This means `require.resolve('@types/express')` always
 * throws MODULE_NOT_FOUND, so we cannot use resolvePackageRoot() for them.
 * Instead we look for the package directory directly in every node_modules/@types/
 * folder on the path from the notebook directory up to the filesystem root.
 *
 * @param {string} notebookPath   – absolute path to the .ijsnb file
 * @param {string} atTypesName    – full scoped name, e.g. "@types/express" or "@types/scope__pkg"
 * @returns {string|null}  absolute path to the @types/<name> root, or null if not found
 */
function findAtTypesRoot(notebookPath, atTypesName) {
  // Strip the "@types/" prefix to get the directory name inside @types/
  const suffix = atTypesName.startsWith("@types/")
    ? atTypesName.slice("@types/".length)
    : atTypesName;

  let dir = path.dirname(notebookPath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, "node_modules", "@types", suffix);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
    dir = path.dirname(dir);
  }

  return null;
}

function findPackageRootFromEntry(entryPath) {
  let currentPath = fs.statSync(entryPath).isDirectory() ? entryPath : path.dirname(entryPath);

  while (currentPath !== path.dirname(currentPath)) {
    if (fs.existsSync(path.join(currentPath, "package.json"))) {
      return currentPath;
    }

    currentPath = path.dirname(currentPath);
  }

  return null;
}

function resolvePackageRoot(notebookPath, moduleName) {
  try {
    const notebookRequire = createNotebookRequire(notebookPath);
    const entryPath = notebookRequire.resolve(moduleName);
    return findPackageRootFromEntry(entryPath);
  } catch {
    return null;
  }
}

function getNotebookNodeModulesRoot(notebookPath) {
  return path.join(path.dirname(notebookPath), "node_modules");
}

function toVirtualModuleFile(notebookPath, absolutePath) {
  const nodeModulesRoot = getNotebookNodeModulesRoot(notebookPath);

  if (absolutePath.startsWith(nodeModulesRoot)) {
    const relativePart = absolutePath.slice(nodeModulesRoot.length);
    return `file:///node_modules${relativePart.replaceAll(path.sep, "/")}`;
  }

  return pathToFileURL(absolutePath).href;
}

function getDeclarationImportSpecifier(declarationPath, packageRoot) {
  const relativePath = path.relative(packageRoot, declarationPath).replaceAll(path.sep, "/");

  return `./${relativePath.replace(/\.d\.(cts|mts|ts)$/, "")}`;
}

function resolveDeclarationEntry(packageRoot, packageJson) {
  const candidates = [];
  const rootExport = packageJson.exports?.["."];

  if (typeof rootExport === "object" && rootExport !== null) {
    if (typeof rootExport.types === "string") {
      candidates.push(rootExport.types);
    }

    if (typeof rootExport.import === "object" && rootExport.import !== null && typeof rootExport.import.types === "string") {
      candidates.push(rootExport.import.types);
    }

    if (typeof rootExport.require === "object" && rootExport.require !== null && typeof rootExport.require.types === "string") {
      candidates.push(rootExport.require.types);
    }
  }

  if (typeof packageJson.types === "string") {
    candidates.push(packageJson.types);
  }

  if (typeof packageJson.typings === "string") {
    candidates.push(packageJson.typings);
  }

  if (typeof packageJson.module === "string") {
    candidates.push(packageJson.module.replace(/\.js$/, ".d.ts"));
  }

  if (typeof packageJson.main === "string") {
    candidates.push(packageJson.main.replace(/\.cjs$/, ".d.cts").replace(/\.js$/, ".d.ts"));
  }

  candidates.push("index.d.ts", "index.d.cts", "index.d.mts");

  for (const candidate of candidates) {
    const absolutePath = path.resolve(packageRoot, candidate);

    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }

  return null;
}

async function collectDeclarationFiles(packageRoot, maxFiles = 660) {
  const results = [];
  const queue = [packageRoot];

  while (queue.length > 0 && results.length < maxFiles) {
    const currentDirectory = queue.shift();
    const directoryEntries = await fs.promises.readdir(currentDirectory, {
      withFileTypes: true
    });

    for (const entry of directoryEntries) {
      if (results.length >= maxFiles) {
        break;
      }

      if (entry.name === "node_modules") {
        continue;
      }

      const absolutePath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (entry.isFile() && (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.cts") || entry.name.endsWith(".d.mts"))) {
        results.push(absolutePath);
      }
    }
  }

  return results;
}

async function discoverAtTypesPackages(notebookPath) {
  const nodeModulesRoot = getNotebookNodeModulesRoot(notebookPath);
  const atTypesDir = path.join(nodeModulesRoot, "@types");
  const results = [];

  if (!fs.existsSync(atTypesDir)) {
    return results;
  }

  const entries = await fs.promises.readdir(atTypesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const scopedName = `@types/${entry.name}`;
    const packageRoot = path.join(atTypesDir, entry.name);
    results.push({ moduleName: entry.name, scopedName, packageRoot });
  }

  return results;
}

/**
 * Rewrite `.js` / `.cjs` / `.mjs` extension imports inside a `.d.ts` file to their
 * declaration-file equivalents so TypeScript can resolve them inside the virtual FS.
 * e.g. `from "./chat_models.js"` → `from "./chat_models"`
 */
function rewriteDeclarationImports(content) {
  return content.replace(
    /(from\s+["'])(\.{1,2}\/[^"']*?)\.(js|cjs|mjs)(["'])/g,
    "$1$2$4"
  );
}

// Maximum bytes for a single declaration file.  Giant auto-generated rollup
// files (e.g. @google/genai ships three ~480 KB .d.ts files that are identical
// copies of the full API) provide no extra IntelliSense value and burn through
// the shared size budget before smaller, more important packages are loaded.
const MAX_BYTES_PER_FILE = 1000_000; // 1 MB per file

// Total byte budget for all declaration content.  10 MB is enough for the
// packages a typical notebook actually imports; the client now requests only
// used packages so the budget is rarely approached.
const MAX_TOTAL_BYTES = 10_000_000; // 10 MB total

// ─── Per-package type-library cache ────────────────────────────────────────
// Keyed by `${packageRoot}:${mtimeMs}` of the package's package.json.
// Value: Array of { seenKey, file, moduleName, content, contentBytes }
//   seenKey  – the key put into `seenFiles` (abs path for .d.ts, virtual path for pkg.json)
//   file     – virtual monaco path ("file:///node_modules/…")
// The cache is per-packageRoot so adding/removing one package only invalidates
// that package's entry; all others remain warm.
const packageTypeLibsCache = new Map();

// ─── Per-package exports cache ──────────────────────────────────────────────
// Keyed by `${packageRoot}:${mtimeMs}`.  Value: ExportEntry[]
const packageExportsCache = new Map();

async function addPackageTypeLibraries(notebookPath, moduleName, packageRoot, typeLibraries, seenFiles, stats) {
  const pkgJsonPath = path.join(packageRoot, "package.json");

  // ── Cache lookup ──────────────────────────────────────────────────────────
  let mtimeMs = 0;
  try {
    if (fs.existsSync(pkgJsonPath)) {
      mtimeMs = (await fs.promises.stat(pkgJsonPath)).mtimeMs;
    }
  } catch { /* ignore stat errors */ }

  const cacheKey = `${packageRoot}:${mtimeMs}`;

  if (packageTypeLibsCache.has(cacheKey)) {
    // Apply cached entries, respecting the shared byte budget and seenFiles.
    const cachedEntries = packageTypeLibsCache.get(cacheKey);
    for (const entry of cachedEntries) {
      if (seenFiles.has(entry.seenKey)) continue;
      if (stats.totalBytes + entry.contentBytes > MAX_TOTAL_BYTES) return false;
      stats.totalBytes += entry.contentBytes;
      seenFiles.add(entry.seenKey);
      typeLibraries.push({ moduleName: entry.moduleName, file: entry.file, content: entry.content });
    }
    return true;
  }

  // ── Cache miss — collect fresh and store ──────────────────────────────────
  const freshEntries = []; // will be stored in cache

  const pkgJson = fs.existsSync(pkgJsonPath)
    ? JSON.parse(await fs.promises.readFile(pkgJsonPath, "utf8"))
    : {};
  const declarationEntry = resolveDeclarationEntry(packageRoot, pkgJson);
  const declarationFiles = await collectDeclarationFiles(packageRoot);

  if (declarationFiles.length === 0 && !declarationEntry) {
    // Package has no type declarations at all — cache the empty result and skip.
    packageTypeLibsCache.set(cacheKey, freshEntries);
    return true;
  }

  // Add a virtual package.json so Monaco's TypeScript service can read the `types` field
  // and resolve the correct entry declaration without guessing.
  if (declarationEntry && pkgJsonPath) {
    const relativeTypes = path.relative(packageRoot, declarationEntry).replaceAll(path.sep, "/");
    const virtualPkgJson = JSON.stringify({ name: moduleName, types: `./${relativeTypes}`, version: pkgJson.version ?? "0.0.0" });
    const virtualPkgJsonPath = toVirtualModuleFile(notebookPath, pkgJsonPath);
    freshEntries.push({
      seenKey: virtualPkgJsonPath,
      moduleName,
      file: virtualPkgJsonPath,
      content: virtualPkgJson,
      contentBytes: Buffer.byteLength(virtualPkgJson)
    });
  }

  for (const declarationFile of declarationFiles) {
    let content = await fs.promises.readFile(declarationFile, "utf8");

    // Rewrite `.js` extension imports so they resolve correctly in the virtual FS
    content = rewriteDeclarationImports(content);

    const contentBytes = Buffer.byteLength(content);
    freshEntries.push({
      seenKey: declarationFile,          // absolute path — matches original seenFiles key
      moduleName,
      file: toVirtualModuleFile(notebookPath, declarationFile),
      content,
      contentBytes
    });
  }

  // Ensure there is an index.d.ts at the package root so TypeScript's standard
  // node_modules resolution finds the package without needing to read package.json.
  const rootIndexPath = path.join(packageRoot, "index.d.ts");
  if (!fs.existsSync(rootIndexPath)) {
    const entrySpecifier = declarationEntry
      ? getDeclarationImportSpecifier(declarationEntry, packageRoot)
      : null;

    if (entrySpecifier) {
      const aliasSource = `export * from ${JSON.stringify(entrySpecifier)};\nexport { } from ${JSON.stringify(entrySpecifier)};\n`;
      const virtualIndexPath = toVirtualModuleFile(notebookPath, rootIndexPath);
      freshEntries.push({
        seenKey: virtualIndexPath,
        moduleName,
        file: virtualIndexPath,
        content: aliasSource,
        contentBytes: Buffer.byteLength(aliasSource)
      });
    }
  }

  // Store in cache before applying (so a budget-exceeded early return still caches)
  packageTypeLibsCache.set(cacheKey, freshEntries);

  // Apply to output arrays, respecting budget and seenFiles.
  for (const entry of freshEntries) {
    if (seenFiles.has(entry.seenKey)) continue;
    if (stats.totalBytes + entry.contentBytes > MAX_TOTAL_BYTES) return false;
    stats.totalBytes += entry.contentBytes;
    seenFiles.add(entry.seenKey);
    typeLibraries.push({ moduleName: entry.moduleName, file: entry.file, content: entry.content });
  }

  return true;
}

/**
 * Enumerate every package in node_modules (depth-1 + scoped-depth-2).
 * Returns [{moduleName, packageRoot}] for packages that actually have declaration files.
 */
async function discoverAllNodeModulesPackages(notebookPath) {
  const nodeModulesRoot = getNotebookNodeModulesRoot(notebookPath);

  if (!fs.existsSync(nodeModulesRoot)) {
    return [];
  }

  const results = [];
  const entries = await fs.promises.readdir(nodeModulesRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Scoped package directory (e.g. @langchain)
    if (entry.name.startsWith("@")) {
      const scopedDir = path.join(nodeModulesRoot, entry.name);

      try {
        const scopedEntries = await fs.promises.readdir(scopedDir, { withFileTypes: true });

        for (const scopedEntry of scopedEntries) {
          if (!scopedEntry.isDirectory()) continue;
          const moduleName = `${entry.name}/${scopedEntry.name}`;
          const packageRoot = path.join(scopedDir, scopedEntry.name);
          results.push({ moduleName, packageRoot });
        }
      } catch {
        // Ignore unreadable scoped directories
      }

      continue;
    }

    // Skip hidden/internal directories
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const packageRoot = path.join(nodeModulesRoot, entry.name);
    results.push({ moduleName: entry.name, packageRoot });
  }

  return results;
}

/**
 * Collect TypeScript declaration libraries for Monaco IntelliSense.
 *
 * @param {string}   notebookPath
 * @param {Set<string>|null} filterPackages
 *   When non-null, only load type libraries for packages whose moduleName is
 *   in this set (plus their direct npm dependencies, expanded automatically).
 *   Pass null to load types for every package in node_modules (full mode).
 */
async function collectTypeLibraries(notebookPath, filterPackages = null) {
  const nodeModulesRoot = getNotebookNodeModulesRoot(notebookPath);

  // When no filter is active we need a local node_modules to enumerate packages.
  // When a filter IS active we can resolve packages via Node's full module resolution
  // chain (which traverses parent directories), so a local node_modules is not required.
  if (!filterPackages && !fs.existsSync(nodeModulesRoot)) {
    return [];
  }

  const typeLibraries = [];
  const seenFiles = new Set();
  const seenModules = new Set();
  const stats = { totalBytes: 0 };

  // Discover packages that live directly in the workspace node_modules.
  const allPackages = await discoverAllNodeModulesPackages(notebookPath);

  let effectiveFilter = null;
  if (filterPackages && filterPackages.size > 0) {
    effectiveFilter = new Set(filterPackages);

    // Also pull in @types/<name> companions for each explicitly-requested package.
    // Many packages (e.g. express, mocha) ship no bundled declarations and rely on
    // DefinitelyTyped (@types/express, etc.) for IntelliSense.
    for (const pkgName of filterPackages) {
      if (pkgName.startsWith("@types/")) continue; // already a @types package
      if (pkgName.startsWith("@")) {
        // @scope/name → @types/scope__name  (DefinitelyTyped convention)
        effectiveFilter.add(`@types/${pkgName.slice(1).replace("/", "__")}`);
      } else {
        effectiveFilter.add(`@types/${pkgName}`);
      }
    }

    // Expand filter: include direct dependencies of each requested package.
    for (const pkgName of filterPackages) {
      const pkgRoot = resolvePackageRoot(notebookPath, pkgName);
      if (!pkgRoot) continue;
      try {
        const pkgJsonPath = path.join(pkgRoot, "package.json");
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(await fs.promises.readFile(pkgJsonPath, "utf8"));
          for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
            effectiveFilter.add(dep);
          }
          for (const dep of Object.keys(pkgJson.peerDependencies ?? {})) {
            effectiveFilter.add(dep);
          }
        }
      } catch { /* ignore */ }
    }

    // For every package in the effective filter, fall back to Node's full module
    // resolution (require.resolve traverses parent directories) to find packages
    // that are accessible but not in the workspace's own node_modules.
    // This handles: packages in the marsbook server's own node_modules, globally
    // installed packages, and monorepo hoisted packages.
    const localModuleNames = new Set(allPackages.map(p => p.moduleName));
    for (const pkgName of effectiveFilter) {
      if (localModuleNames.has(pkgName)) continue;

      let pkgRoot = null;

      if (pkgName.startsWith("@types/")) {
        // @types/* packages contain only .d.ts files — no JavaScript entry point.
        // require.resolve() always throws MODULE_NOT_FOUND for them, so we must
        // locate them via a direct filesystem walk instead.
        pkgRoot = findAtTypesRoot(notebookPath, pkgName);
      } else {
        pkgRoot = resolvePackageRoot(notebookPath, pkgName);
      }

      if (pkgRoot) {
        allPackages.push({ moduleName: pkgName, packageRoot: pkgRoot });
        localModuleNames.add(pkgName);
      }
    }
  }

  // Sort packages so that smaller packages come first — this maximises the number
  // of packages that fit within the total byte budget before it is exhausted.
  // We approximate package "size" by the number of declaration files it ships.
  const packageSizes = new Map();
  await Promise.all(
    allPackages.map(async ({ moduleName, packageRoot }) => {
      // Skip size-estimation for packages outside the filter (no need to sort them)
      if (effectiveFilter && !effectiveFilter.has(moduleName)) return;
      try {
        const files = await collectDeclarationFiles(packageRoot);
        packageSizes.set(moduleName, files.length);
      } catch {
        packageSizes.set(moduleName, 0);
      }
    })
  );

  const priorityPackages = [
    "@langchain/core",
    "@langchain/groq",
    "groq-sdk"
  ];

  allPackages.sort((a, b) => {
    const aPriority = priorityPackages.some(p => a.moduleName.startsWith(p)) ? -1 : 0;
    const bPriority = priorityPackages.some(p => b.moduleName.startsWith(p)) ? -1 : 0;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    const sizeA = packageSizes.get(a.moduleName) ?? 0;
    const sizeB = packageSizes.get(b.moduleName) ?? 0;

    return sizeA - sizeB;
  });

  for (const { moduleName, packageRoot } of allPackages) {
    // Skip packages outside the effective filter when one is active.
    if (effectiveFilter && !effectiveFilter.has(moduleName)) continue;

    if (seenModules.has(moduleName)) continue;
    seenModules.add(moduleName);

    const ok = await addPackageTypeLibraries(notebookPath, moduleName, packageRoot, typeLibraries, seenFiles, stats);

    if (!ok) {
      // Size budget exhausted — return what we have
      return typeLibraries;
    }
  }

  return typeLibraries;
}

/**
 * Like collectDeclaredPackageExports but with per-package mtime-based caching
 * so repeated calls (e.g. each time /api/suggestions fires) hit memory instead
 * of parsing TypeScript AST from disk every time.
 */
async function collectDeclaredPackageExportsCached(notebookPath, moduleNames) {
  const exportEntries = [];

  for (const moduleName of moduleNames) {
    // @types/ packages are not directly imported by users; skip them here.
    // The fallback inside collectDeclaredPackageExports already handles them.
    if (moduleName.startsWith("@types/")) continue;

    const packageRoot = resolvePackageRoot(notebookPath, moduleName);

    // Some packages (e.g. "express") have no bundled declarations but DO have a
    // companion "@types/express" package.  When the package's own root is missing
    // or lacks a package.json, we still want to attempt the @types fallback, so we
    // use the @types package root for the cache key instead.
    //
    // IMPORTANT: @types/* packages have no JavaScript entry, so require.resolve()
    // fails for them. Use findAtTypesRoot() (filesystem walk) instead.
    const atTypesName = moduleName.startsWith("@")
      ? `@types/${moduleName.slice(1).replace("/", "__")}`
      : `@types/${moduleName}`;
    const atTypesRoot = !packageRoot ? findAtTypesRoot(notebookPath, atTypesName) : null;

    // If neither the package nor its @types companion can be found, skip.
    const effectiveRoot = packageRoot ?? atTypesRoot;
    if (!effectiveRoot) continue;

    const pkgJsonPath = path.join(effectiveRoot, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    let mtimeMs = 0;
    try { mtimeMs = (await fs.promises.stat(pkgJsonPath)).mtimeMs; } catch { /* ignore */ }

    const cacheKey = `${effectiveRoot}:${mtimeMs}`;

    if (packageExportsCache.has(cacheKey)) {
      exportEntries.push(...packageExportsCache.get(cacheKey));
      continue;
    }

    // Cache miss — parse this single package (with @types fallback) and store result.
    const entries = await collectDeclaredPackageExports(notebookPath, [moduleName]);
    packageExportsCache.set(cacheKey, entries);
    exportEntries.push(...entries);
  }

  return exportEntries;
}

async function ensurePackageJson(directoryPath) {
  const packageJsonPath = path.join(directoryPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    const packageJson = {
      name: path.basename(directoryPath).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "nodebook-project",
      private: true,
      type: "module"
    };

    await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
  }
}

async function installPackages(notebookPath, packages) {
  const workingDirectory = path.dirname(notebookPath);
  await fs.promises.mkdir(workingDirectory, { recursive: true });
  await ensurePackageJson(workingDirectory);

  return new Promise((resolve) => {
    const child = spawn("npm", ["install", ...packages], {
      cwd: workingDirectory,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr
      });
    });
  });
}

async function runShellCommand(command, cwd) {
  // Ensure a package.json exists so npm commands work correctly in the directory
  await ensurePackageJson(cwd);

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      // Disable npm's interactive progress bar so it doesn't hang on non-TTY pipes.
      // Also ensure PATH is inherited so nvm/volta-managed npm binaries are found.
      env: { ...process.env, NPM_CONFIG_PROGRESS: "false", NPM_CONFIG_FUND: "false" },
      shell: true,
      // Explicitly close stdin — prevents npm (and other tools) from blocking
      // waiting for input that will never arrive.
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr
      });
    });

    child.on("error", (err) => {
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: stderr + err.message
      });
    });
  });
}

function normalizeRepositoryUrl(repository) {
  const rawValue =
    typeof repository === "string"
      ? repository
      : repository && typeof repository === "object" && typeof repository.url === "string"
        ? repository.url
        : null;

  if (!rawValue) {
    return null;
  }

  return rawValue
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

async function fetchPackageDocs(packageName) {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const response = await fetch(registryUrl, {
    headers: {
      accept: "application/json"
    },
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch docs for ${packageName}`);
  }

  const metadata = await response.json();
  const latestVersion = metadata["dist-tags"]?.latest ?? null;
  const latestManifest =
    latestVersion && metadata.versions && typeof metadata.versions === "object"
      ? metadata.versions[latestVersion]
      : null;

  return {
    name: metadata.name ?? packageName,
    version: latestVersion ?? latestManifest?.version ?? null,
    description: latestManifest?.description ?? metadata.description ?? "",
    homepage: latestManifest?.homepage ?? metadata.homepage ?? null,
    repositoryUrl: normalizeRepositoryUrl(latestManifest?.repository ?? metadata.repository),
    npmUrl: `https://www.npmjs.com/package/${packageName}`,
    readme: metadata.readme ?? latestManifest?.readme ?? ""
  };
}

async function formatNotebookForSave(notebook) {
  const normalized = normalizeNotebook(notebook);
  const formattedCells = await Promise.all(
    normalized.cells.map(async (cell) => {
      if (cell.type === "prompt") {
        return cell;
      }

      let parser = null;
      let plugins = [];

      if (cell.type === "markdown") {
        parser = "markdown";
        plugins = [prettierPluginMarkdown];
      } else if ((cell.language ?? "typescript") === "javascript") {
        parser = "babel";
        plugins = [prettierPluginBabel, prettierPluginEstree];
      } else {
        parser = "typescript";
        plugins = [prettierPluginTypeScript, prettierPluginEstree];
      }

      try {
        const source = await prettier.format(cell.source ?? "", {
          parser,
          plugins,
          printWidth: 100,
          tabWidth: 2,
          semi: false,
          singleQuote: false
        });

        return {
          ...cell,
          source
        };
      } catch {
        return cell;
      }
    })
  );

  return {
    ...normalized,
    cells: formattedCells
  };
}

function resolveAiConfig(env = {}, notebookMeta = {}, promptConfig = {}) {
  const provider = promptConfig.provider ?? notebookMeta.provider ?? "groq";
  const requestedModel = promptConfig.model ?? notebookMeta.model ?? env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  const model = GROQ_MODELS_FALLBACK.includes(requestedModel) ? requestedModel : requestedModel || "llama-3.3-70b-versatile";
  const temperature = Number.isFinite(promptConfig.temperature) ? Number(promptConfig.temperature) : 0.2;

  if (provider !== "groq") {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  const apiKey = env.GROQ_API_KEY || process.env.GROQ_API_KEY;
  const baseUrl = (env.GROQ_BASE_URL || process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");

  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY");
  }

  return {
    provider,
    model,
    temperature,
    apiKey,
    baseUrl
  };
}

async function requestAiCompletion(config, messages) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "AI completion failed");
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function streamAiCompletion(config, messages, response) {
  const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      stream: true,
      stream_options: { include_usage: true },
      messages
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    throw new Error(text || "AI stream failed");
  }

  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let usageData = null;

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      try {
        const data = JSON.parse(payload);
        const content = data.choices?.[0]?.delta?.content;
        if (content) {
          response.write(content);
        }
        // Capture usage data from any chunk that has it
        if (data.usage && typeof data.usage.prompt_tokens === "number") {
          usageData = data.usage;
        }
      } catch {
        // Ignore malformed SSE chunks from upstream
      }
    }
  }

  // Send token usage as a special sentinel line so the client can read real counts
  if (usageData) {
    response.write(`\n\x02TOKEN_USAGE:${JSON.stringify({ in: usageData.prompt_tokens, out: usageData.completion_tokens })}\n`);
  }

  response.end();
}

function resolveOpenablePath(workspaceRoot, notebooksDir, requestedPath, options = {}) {
  const absolutePath = resolveWorkspaceOpenPath(workspaceRoot, notebooksDir, requestedPath, {
    allowNotebookCreate: options.allowNotebookCreate ?? false,
    existsSync: fs.existsSync
  });

  if (!absolutePath || !absolutePath.startsWith(workspaceRoot)) {
    throw new Error("Path is outside the workspace");
  }

  return absolutePath;
}

async function readOpenableFile(workspaceRoot, notebooksDir, filePath) {
  const kind = getOpenableFileKind(filePath);

  if (!kind) {
    throw new Error("File type is not supported");
  }

  if (kind === "notebook") {
    return {
      kind,
      path: filePath,
      appPath: getAppPathFromWorkspacePath(workspaceRoot, notebooksDir, filePath),
      notebook: await ensureNotebook(filePath)
    };
  }

  if (kind === "text") {
    return {
      kind,
      path: filePath,
      appPath: getAppPathFromWorkspacePath(workspaceRoot, notebooksDir, filePath),
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      content: await fs.promises.readFile(filePath, "utf8")
    };
  }

  return {
    kind,
    path: filePath,
    appPath: getAppPathFromWorkspacePath(workspaceRoot, notebooksDir, filePath),
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    contentUrl: `/api/file/content?path=${encodeURIComponent(filePath)}`
  };
}

async function serveFile(rootDirectory, requestPath, response) {
  const absolutePath = path.join(rootDirectory, requestPath);

  if (!absolutePath.startsWith(rootDirectory) || !fs.existsSync(absolutePath)) {
    notFound(response);
    return;
  }

  const extension = path.extname(absolutePath);
  response.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream"
  });
  fs.createReadStream(absolutePath).pipe(response);
}

async function serveStaticAsset(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const absolutePath = path.join(publicDir, safePath);

  if (absolutePath.startsWith(publicDir) && fs.existsSync(absolutePath)) {
    await serveFile(publicDir, safePath, response);
    return;
  }

  await serveFile(publicDir, "/index.html", response);
}

export async function createServer(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  // The workspace root IS the notebooks directory — users place .ijsnb files
  // directly in their project folder (or any subfolder), not in a separate
  // "notebooks/" subdirectory.  The /notebooks/ segment only appears in the
  // browser URL as a cosmetic prefix.
  const notebooksDir = workspaceRoot;
  const sessions = new Map();
  const pendingInputResolvers = new Map(); // runId -> Array<resolve>

  // Ensure the workspace root exists (in case the user pointed to a new dir)
  await fs.promises.mkdir(workspaceRoot, { recursive: true });

  function getSession(notebookPath) {
    if (!sessions.has(notebookPath)) {
      sessions.set(notebookPath, new KernelSession(notebookPath));
    }

    return sessions.get(notebookPath);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && requestUrl.pathname === "/api/notebook") {
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, requestUrl.searchParams.get("path"));
        const notebook = await ensureNotebook(notebookPath);

        json(response, 200, {
          notebookPath,
          notebook
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/open") {
        const requestedPath = requestUrl.searchParams.get("path");
        const absolutePath = requestedPath
          ? resolveOpenablePath(workspaceRoot, notebooksDir, requestedPath, {
              allowNotebookCreate: String(requestedPath).endsWith(NOTEBOOK_EXTENSION)
            })
          : path.join(workspaceRoot, "startup.ijsnb");
        const resource = await readOpenableFile(workspaceRoot, notebooksDir, absolutePath);

        json(response, 200, resource);
        return;
      }

      // Check whether a workspace file exists WITHOUT creating it.
      // Returns { exists: true|false }
      if (request.method === "GET" && requestUrl.pathname === "/api/stat") {
        const rawPath = requestUrl.searchParams.get("path") ?? "";
        let filePath;
        try {
          filePath = resolveNotebookPath(workspaceRoot, notebooksDir, rawPath);
        } catch {
          json(response, 200, { exists: false });
          return;
        }
        json(response, 200, { exists: fs.existsSync(filePath) });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/files") {
        const directoryPath = resolveWorkspacePath(workspaceRoot, requestUrl.searchParams.get("path"));
        const entries = await listDirectoryEntries(workspaceRoot, directoryPath);

        json(response, 200, {
          rootPath: workspaceRoot,
          directoryPath,
          entries
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/notebook/save") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        const formattedNotebook = await formatNotebookForSave(body.notebook);
        const requestedNextPath = typeof body.nextPath === "string" && body.nextPath.trim() ? body.nextPath : null;
        const nextPath = requestedNextPath
          ? resolveOpenablePath(workspaceRoot, notebooksDir, requestedNextPath, { allowNotebookCreate: true })
          : deriveNotebookPathFromTitle(notebookPath, formattedNotebook?.metadata?.title);
        const saved = await saveNotebookAtPath(notebookPath, formattedNotebook, nextPath);

        if (notebookPath !== saved.notebookPath && sessions.has(notebookPath)) {
          const session = sessions.get(notebookPath);
          sessions.delete(notebookPath);
          session.notebookPath = saved.notebookPath;
          sessions.set(saved.notebookPath, session);
        }

        json(response, 200, {
          ok: true,
          notebookPath: saved.notebookPath,
          appPath: getAppPathFromWorkspacePath(workspaceRoot, notebooksDir, saved.notebookPath),
          notebook: saved.notebook
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/format") {
        const body = await readRequestBody(request);
        const notebook = await formatNotebookForSave(body.notebook);
        json(response, 200, { notebook });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/file/content") {
        const filePath = resolveOpenablePath(workspaceRoot, notebooksDir, requestUrl.searchParams.get("path"));
        const fileKind = getOpenableFileKind(filePath);

        if (fileKind !== "image" && fileKind !== "pdf") {
          json(response, 400, { error: "Binary content is only available for images and PDFs" });
          return;
        }

        response.writeHead(200, {
          "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
        });
        fs.createReadStream(filePath).pipe(response);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/suggestions") {
        const rawPath = requestUrl.searchParams.get("path");
        if (!rawPath) {
          // No path → nothing to suggest, and we must NOT auto-create a notebook
          json(response, 200, { modules: [], installedPackages: [], typeLibraries: [], packageExports: [] });
          return;
        }
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, rawPath);

        // Guard: do NOT create a .ijsnb file when suggestions are requested for a
        // standalone text file (e.g. data_flow.js opened directly in the editor).
        // resolveNotebookPath always appends NOTEBOOK_EXTENSION, so without this
        // check we would spuriously create "data_flow.js.ijsnb" next to the JS file.
        const rawExt = path.extname(String(rawPath)).toLowerCase();
        const isNonNotebookFile = rawExt !== "" && rawExt !== NOTEBOOK_EXTENSION;
        if (!isNonNotebookFile) {
          await ensureNotebook(notebookPath);
        }
        const session = getSession(notebookPath);

        // ── Field selection ────────────────────────────────────────────────
        // ?fields=modules,installedPackages          → fast, no type work
        // ?fields=modules,installedPackages,typeLibraries,packageExports  → full (default)
        const fieldsParam = requestUrl.searchParams.get("fields");
        const fields = fieldsParam
          ? new Set(fieldsParam.split(",").map(f => f.trim()))
          : new Set(["modules", "installedPackages", "typeLibraries", "packageExports"]);

        // ── Package filter ─────────────────────────────────────────────────
        // ?packages=pkg1,pkg2  → only compute type data for these packages
        // Omit the param entirely → compute for all installed packages (full mode)
        // ?packages=  (empty value) → treat same as omitted (safety net)
        const packagesParamRaw = requestUrl.searchParams.get("packages");
        // `has` distinguishes "param present but empty" from "param absent".
        const packagesParamPresent = requestUrl.searchParams.has("packages");
        const filterPackages = (packagesParamPresent && packagesParamRaw)
          ? new Set(packagesParamRaw.split(",").map(p => p.trim()).filter(Boolean))
          : null;

        const result = {};

        // modules + installedPackages are always cheap — compute only when requested
        let installedPackages = null;
        if (fields.has("modules")) {
          result.modules = await session.listInstalledModules();
        }
        if (fields.has("installedPackages")) {
          installedPackages = await session.listDeclaredPackages();
          result.installedPackages = installedPackages;
        }

        // typeLibraries — expensive disk scan, support filtering + caching
        if (fields.has("typeLibraries")) {
          result.typeLibraries = await collectTypeLibraries(notebookPath, filterPackages);
        }

        // packageExports — TypeScript AST parsing, support filtering + caching
        if (fields.has("packageExports")) {
          // Determine which packages to extract exports for.
          // When a package filter is given, use it (only explicitly-imported pkgs
          // need auto-complete export lists).  Otherwise fall back to all installed packages.
          let exportPackages;
          if (filterPackages && filterPackages.size > 0) {
            exportPackages = [...filterPackages];
          } else {
            exportPackages = installedPackages ?? await session.listDeclaredPackages();
          }
          result.packageExports = await collectDeclaredPackageExportsCached(notebookPath, exportPackages);
        }

        // Use compact JSON — typeLibraries can be many MB and pretty-printing
        // adds 15-20% overhead on a payload that's purely machine-to-machine.
        json(response, 200, result, /* compact= */ true);
        return;
      }

      // ── /api/local-files — list .js/.ts files reachable from the notebook ───
      // Returns files with their relative import paths so Monaco can resolve both
      // `import { x } from "./controller/app"` (subdirectory) and
      // `import { y } from "../utils"` (parent directory).
      // Response shape: { files: [{ name: "controller/app.js", content: "..." }, ...] }
      //   name is the import-ready relative path (without leading "./")
      //   parent-dir files use "../<filename>" as the name.
      if (request.method === "GET" && requestUrl.pathname === "/api/local-files") {
        const rawPath = requestUrl.searchParams.get("path");
        if (!rawPath) {
          json(response, 200, { files: [] });
          return;
        }

        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, rawPath);
        const notebookDir = path.dirname(notebookPath);
        const files = [];

        // Directories to never descend into
        const SKIP_DIRS = new Set([
          "node_modules", ".git", ".nodebook-cache", ".cache",
          "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
          "coverage", ".turbo", ".vercel"
        ]);
        const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
        const MAX_FILES = 300;
        const MAX_DEPTH = 5;
        const MAX_FILE_BYTES = 256_000; // 256 KB per file

        // Read a single file and push it if it's within size limits
        const pushFile = async (absPath, relName) => {
          if (files.length >= MAX_FILES) return;
          try {
            const stat = await fs.promises.stat(absPath);
            if (stat.size > MAX_FILE_BYTES) return;
            const content = await fs.promises.readFile(absPath, "utf8");
            files.push({ name: relName, content });
          } catch {
            // skip unreadable / binary files
          }
        };

        // Recursively scan a directory. relPrefix is the path relative to notebookDir
        // (empty string for the root, "controller" for a subdirectory, etc.).
        const scanDir = async (absDir, relPrefix, depth) => {
          if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
          let entries;
          try {
            entries = await fs.promises.readdir(absDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (files.length >= MAX_FILES) break;
            if (entry.isDirectory()) {
              if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
              const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
              await scanDir(path.join(absDir, entry.name), childRel, depth + 1);
            } else if (entry.isFile()) {
              if (!JS_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
              const relName = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
              await pushFile(path.join(absDir, entry.name), relName);
            }
          }
        };

        // Scan the notebook's own directory (and all subdirectories)
        await scanDir(notebookDir, "", 0);

        // Also scan the immediate parent directory (flat, not recursive) so that
        // `import { x } from "../utils"` works when the notebook is in a subdirectory.
        // Only do this if the parent is still inside the workspace root.
        const parentDir = path.dirname(notebookDir);
        if (parentDir !== notebookDir && parentDir.startsWith(workspaceRoot)) {
          let parentEntries = [];
          try { parentEntries = await fs.promises.readdir(parentDir, { withFileTypes: true }); } catch { /* ignore */ }
          for (const entry of parentEntries) {
            if (files.length >= MAX_FILES) break;
            if (!entry.isFile()) continue;
            if (!JS_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
            await pushFile(path.join(parentDir, entry.name), `../${entry.name}`);
          }
        }

        json(response, 200, { files }, /* compact= */ true);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/ai/config") {
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, requestUrl.searchParams.get("path"));
        const notebook = await ensureNotebook(notebookPath);
        const env = notebook.metadata?.env ?? {};
        const apiKey = env.GROQ_API_KEY || process.env.GROQ_API_KEY;
        const models = await fetchGroqModels(apiKey);
        const savedModel = notebook.metadata?.ai?.model;

        json(response, 200, {
          hasGroqKey: Boolean(apiKey),
          models,
          defaultModel: savedModel && models.includes(savedModel) ? savedModel : models[0]
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/package-docs") {
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, requestUrl.searchParams.get("path"));
        const packageName = String(requestUrl.searchParams.get("package") ?? "").trim();

        if (!packageName) {
          json(response, 400, { error: "No package provided" });
          return;
        }

        await ensureNotebook(notebookPath);
        const docs = await fetchPackageDocs(packageName);
        json(response, 200, docs);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/execute") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        await ensureNotebook(notebookPath);
        const session = getSession(notebookPath);
        // Ensure any stray timers from a previous run are cleared before starting a new one
        session.cancelExecution();
        const stream = Boolean(body.stream);

        if (stream) {
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
          const runId = randomUUID();
          let cleanedUp = false;
          const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            pendingInputResolvers.delete(runId);
          };
          const cancel = () => {
            session.cancelExecution();
            cleanup();
          };
          request.on("aborted", cancel);
          response.on("close", cancel);
          pendingInputResolvers.set(runId, []);
          const requestInput = (promptText) => {
            return new Promise((resolve) => {
              const queue = pendingInputResolvers.get(runId) ?? [];
              queue.push(resolve);
              pendingInputResolvers.set(runId, queue);
              // Guard: do not write if the response has already been closed (e.g. client
              // disconnected mid-execution) to avoid ERR_HTTP_HEADERS_SENT.
              if (!response.writableEnded) {
                response.write(JSON.stringify({ kind: "input_request", runId, prompt: promptText ?? "" }) + "\n");
              }
            });
          };
          const result = await session.execute(
            body.code ?? "",
            body.cellId,
            body.env ?? {},
            body.language ?? "typescript",
            (output) => {
              // Guard: side-effect async callbacks (e.g. from .then() chains) may fire
              // after the execution stream has ended and response.end() was called.
              // Writing to an ended response throws ERR_HTTP_HEADERS_SENT and crashes
              // the server, so we skip the write if the stream is already closed.
              if (response.writableEnded) return;
              try {
                response.write(JSON.stringify({ kind: "output", output }) + "\n");
              } catch {
                // JSON.stringify failed (most likely a circular reference that slipped
                // through serializeOutputValue — e.g. a non-plain-object value).
                // Write a safe text-only fallback so the stream keeps going.
                try {
                  const safe = {
                    kind: "output",
                    output: { type: output.type ?? "log", text: String(output.text ?? ""), dataType: "text" }
                  };
                  if (!response.writableEnded) response.write(JSON.stringify(safe) + "\n");
                } catch { /* ignore — nothing more we can do */ }
              }
            },
            requestInput
          );
          if (!response.writableEnded) {
            response.write(JSON.stringify({ kind: "result", result }) + "\n");
          }
          cleanup();
          if (!response.writableEnded) {
            response.end();
          }
          return;
        }

        const result = await session.execute(
          body.code ?? "",
          body.cellId,
          body.env ?? {},
          body.language ?? "typescript",
          null,
          async () => ""
        );

        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/execute/input") {
        const body = await readRequestBody(request);
        const runId = String(body.runId ?? "");
        const value = body.value ?? "";
        const queue = pendingInputResolvers.get(runId);
        if (!queue || queue.length === 0) {
          json(response, 404, { ok: false, error: "No pending input for this run" });
          return;
        }
        const resolver = queue.shift();
        resolver(String(value));
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/execute/cancel") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        const session = getSession(notebookPath);
        session?.cancelExecution();
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/ai/assist") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        const notebook = await ensureNotebook(notebookPath);
        const env = body.env && typeof body.env === "object" ? body.env : notebook.metadata?.env ?? {};
        const aiConfig = resolveAiConfig(env, notebook.metadata?.ai, body.ai ?? {});
        const instruction = String(body.instruction ?? "").trim() || "Explain this code and suggest an improved version.";
        const source = String(body.source ?? "");
        const responseText = await requestAiCompletion(aiConfig, [
          {
            role: "system",
            content:
              "You are a JavaScript and TypeScript notebook assistant. Be concise, preserve intent, and return actionable guidance."
          },
          {
            role: "user",
            content: `Instruction:\n${instruction}\n\nSource:\n${source}`
          }
        ]);

        json(response, 200, { text: responseText });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/ai/chat") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        const notebook = await ensureNotebook(notebookPath);
        const env = body.env && typeof body.env === "object" ? body.env : notebook.metadata?.env ?? {};
        const aiConfig = resolveAiConfig(env, notebook.metadata?.ai, { model: body.model, provider: "groq" });
        const messages = Array.isArray(body.messages)
          ? body.messages
              .map((message) => ({
                role: message?.role === "assistant" ? "assistant" : "user",
                content: String(message?.content ?? "")
              }))
              .filter((message) => message.content.trim())
          : [];
        const source = String(body.source ?? "");
        const cellType = String(body.cellType ?? "code");

        await streamAiCompletion(aiConfig, [
          {
            role: "system",
            content:
              "You are a concise JavaScript and TypeScript notebook assistant. Use the current cell as context, answer directly, and provide code when useful."
          },
          {
            role: "system",
            content: `Current cell type: ${cellType}\n\nCurrent cell source:\n${source}`
          },
          ...messages
        ], response);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/prompt/execute") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        const notebook = await ensureNotebook(notebookPath);
        const env = body.env && typeof body.env === "object" ? body.env : notebook.metadata?.env ?? {};
        const aiConfig = resolveAiConfig(env, notebook.metadata?.ai, body.prompt ?? {});
        const userPrompt = String(body.source ?? "");
        const systemPrompt = String(body.prompt?.system ?? "");
        const messages = [];

        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }

        messages.push({ role: "user", content: userPrompt });
        await streamAiCompletion(aiConfig, messages, response);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/install") {
        const body = await readRequestBody(request);
        const notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        const packages = Array.isArray(body.packages)
          ? body.packages.map((value) => String(value).trim()).filter(Boolean)
          : [];

        if (packages.length === 0) {
          json(response, 400, { ok: false, error: "No packages provided" });
          return;
        }

        const result = await installPackages(notebookPath, packages);

        if (result.ok) {
          const session = getSession(notebookPath);
          // Invalidate the bridge cache so the newly installed packages are
          // immediately importable without a server restart.
          session.invalidateImportCache();
          const modules = await session.listInstalledModules();
          const installedPackages = await session.listDeclaredPackages();
          json(response, 200, { ...result, modules, installedPackages });
          return;
        }

        json(response, 500, result);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/shell") {
        const body = await readRequestBody(request);
        const command = String(body.command ?? "").trim();

        if (!command) {
          json(response, 400, { ok: false, error: "No command provided" });
          return;
        }

        // ── Determine the working directory ──────────────────────────────────
        // Prefer the client's persisted CWD (set by previous cd/commands).
        // Fall back to the workspace root — never to the active notebook's
        // subdirectory, so creating a notebook inside a folder doesn't
        // silently change where shell commands and npm install run.
        let cwd;
        const clientCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
        if (clientCwd && path.isAbsolute(clientCwd) && fs.existsSync(clientCwd)) {
          cwd = clientCwd;
        } else {
          cwd = workspaceRoot;
        }
        await fs.promises.mkdir(cwd, { recursive: true });

        // ── Handle `cd` specially — track CWD across commands ────────────────
        // Each shell invocation is a new process, so `cd` can't persist through
        // runShellCommand.  We intercept it here, resolve the target directory,
        // and return the new cwd without spawning a shell.
        const cdMatch = command.match(/^cd(?:\s+(.+?))?$/);
        if (cdMatch) {
          const target = (cdMatch[1] ?? "~").trim();
          let newCwd;
          if (target === "~" || target === "") {
            newCwd = process.env.HOME ?? workspaceRoot;
          } else if (target === "-") {
            // "cd -" is unsupported in stateless mode; stay in current dir
            newCwd = cwd;
          } else if (path.isAbsolute(target)) {
            newCwd = path.normalize(target);
          } else {
            newCwd = path.resolve(cwd, target);
          }

          if (!fs.existsSync(newCwd) || !fs.statSync(newCwd).isDirectory()) {
            json(response, 200, { ok: false, stdout: "", stderr: `cd: ${target}: No such file or directory`, cwd });
            return;
          }

          json(response, 200, { ok: true, stdout: "", stderr: "", cwd: newCwd });
          return;
        }

        // ── Run the command in the resolved CWD ───────────────────────────────
        const result = await runShellCommand(command, cwd);

        // Detect CWD change from commands that emit "PWD=…" as last line,
        // or simply keep the same cwd after execution.
        const resultCwd = result.newCwd ?? cwd;

        const activePath = resolveOpenablePath(workspaceRoot, notebooksDir, body.path, { allowNotebookCreate: true })
          ?? path.join(cwd, "dummy.ijsnb");
        const activeKind = getOpenableFileKind(activePath);

        if (activeKind === "notebook") {
          const session = getSession(activePath);

          // Any shell command can change the installed package set (npm install,
          // npm uninstall, npm update, yarn add/remove, etc.).  Clearing the
          // import bridge cache ensures the next import() creates a fresh bridge
          // file with a new URL, so Node.js resolves the module from disk
          // instead of serving a stale entry from its own ESM module cache.
          // This makes both install (new package usable) and uninstall (removed
          // package no longer usable) take effect immediately without a restart.
          session.invalidateImportCache();

          const modules = await session.listInstalledModules();
          const installedPackages = await session.listDeclaredPackages();
          json(response, 200, { ...result, cwd: resultCwd, modules, installedPackages });
          return;
        }

        json(response, 200, { ...result, cwd: resultCwd });
        return;
      }

      // ── /api/notebooks — list every .ijsnb file in the workspace ──────────
      if (request.method === "GET" && requestUrl.pathname === "/api/notebooks") {
        const results = [];

        async function scanDir(dir) {
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return; }
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { await scanDir(abs); continue; }
            if (!entry.name.endsWith(NOTEBOOK_EXTENSION)) continue;
            try {
              const stat = await fs.promises.stat(abs);
              const raw = await fs.promises.readFile(abs, "utf8");
              const nb = JSON.parse(raw);
              const codeCells = (nb.cells ?? []).filter(c => c.type === "code");
              const langs = [...new Set(codeCells.map(c => c.language ?? "typescript"))];
              results.push({
                path: abs,
                relativePath: path.relative(workspaceRoot, abs),
                appPath: getAppPathFromWorkspacePath(workspaceRoot, notebooksDir, abs),
                title: nb.metadata?.title ?? path.basename(abs, NOTEBOOK_EXTENSION),
                cellCount: (nb.cells ?? []).length,
                language: langs[0] ?? "typescript",
                updatedAt: nb.metadata?.updatedAt ?? stat.mtime.toISOString(),
                createdAt: nb.metadata?.createdAt ?? stat.birthtime.toISOString()
              });
            } catch { /* skip malformed */ }
          }
        }

        await scanDir(workspaceRoot);
        results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        json(response, 200, { notebooks: results });
        return;
      }

      // ── /api/stats — aggregate workspace statistics ──────────────────────
      if (request.method === "GET" && requestUrl.pathname === "/api/stats") {
        const allPackages = new Set();
        let notebookCount = 0;
        let totalExecutions = 0;
        let aiTokensUsed = 0;
        const tokenUsageForCell = (cell) => {
          const metrics = cell && typeof cell.metrics === "object" ? cell.metrics : null;
          if (metrics && (Number.isFinite(metrics.aiTokensTotal) || Number.isFinite(metrics.aiTokensOut) || Number.isFinite(metrics.aiTokensIn))) {
            const total = Number.isFinite(metrics.aiTokensTotal)
              ? metrics.aiTokensTotal
              : (Number(metrics.aiTokensIn) || 0) + (Number(metrics.aiTokensOut) || 0);
            return Math.max(0, total);
          }
          if (cell?.type === "prompt" && Array.isArray(cell.outputs)) {
            return cell.outputs.reduce((sum, out) => {
              const text = out?.data?.markdown ?? out?.text ?? "";
              return sum + estimateTokens(text);
            }, 0);
          }
          return 0;
        };

        async function scanStats(dir) {
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return; }
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { await scanStats(abs); continue; }
            if (!entry.name.endsWith(NOTEBOOK_EXTENSION)) continue;
            notebookCount++;
            try {
              const raw = await fs.promises.readFile(abs, "utf8");
              const nb = JSON.parse(raw);
              for (const cell of nb.cells ?? []) {
                if (typeof cell.executionCount === "number" && cell.executionCount > 0) {
                  totalExecutions += cell.executionCount;
                }
                aiTokensUsed += tokenUsageForCell(cell);
              }
              const pkgPath = path.join(path.dirname(abs), "package.json");
              if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(await fs.promises.readFile(pkgPath, "utf8"));
                for (const dep of Object.keys(pkg.dependencies ?? {})) allPackages.add(dep);
              }
            } catch { /* skip malformed */ }
          }
        }

        await scanStats(workspaceRoot);

        // Also count root-level package.json packages
        const rootPkgPath = path.join(workspaceRoot, "package.json");
        if (fs.existsSync(rootPkgPath)) {
          try {
            const pkg = JSON.parse(await fs.promises.readFile(rootPkgPath, "utf8"));
            for (const dep of Object.keys(pkg.dependencies ?? {})) allPackages.add(dep);
          } catch { /* skip */ }
        }

        json(response, 200, {
          notebookCount,
          packageCount: allPackages.size,
          totalExecutions,
          aiTokensUsed,
          packages: [...allPackages]
        });
        return;
      }

      // ── /api/notebook/delete — permanently remove a notebook file ────────
      if (request.method === "POST" && requestUrl.pathname === "/api/notebook/delete") {
        const body = await readRequestBody(request);

        // If the client sends an absolute path (e.g. from the explorer), use it
        // directly after a workspace safety check — don't flatten nested paths.
        let notebookPath;
        if (body.path && path.isAbsolute(body.path)) {
          const resolved = body.path.endsWith(NOTEBOOK_EXTENSION) ? body.path : `${body.path}${NOTEBOOK_EXTENSION}`;
          const rel = path.relative(workspaceRoot, resolved);
          if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            json(response, 403, { error: "Path is outside workspace" });
            return;
          }
          notebookPath = resolved;
        } else {
          notebookPath = resolveNotebookPath(workspaceRoot, notebooksDir, body.path);
        }

        if (!fs.existsSync(notebookPath)) {
          json(response, 404, { error: "Notebook not found" });
          return;
        }

        await fs.promises.unlink(notebookPath);
        json(response, 200, { ok: true });
        return;
      }

      // ── /api/file/save — write or create a text workspace file ─────────────
      if (request.method === "POST" && requestUrl.pathname === "/api/file/save") {
        const body = await readRequestBody(request);
        if (!body.path) {
          json(response, 400, { error: "Missing path" });
          return;
        }

        // Resolve path — support both:
        //   • Real absolute filesystem paths (e.g. "/Users/foo/workspace/test.js")
        //     sent by saveCurrentFile() via state.filePreview.path
        //   • URL-style paths (e.g. "/notebooks/data.js")
        //     sent by createNewNotebook() via the appPath variable
        //
        // The key distinction: a real absolute path starts with the workspace root.
        // URL-style paths like "/notebooks/…" also start with "/" but are NOT real
        // filesystem paths — path.isAbsolute() returns true for both, so we must
        // check startsWith(workspaceRoot) instead.
        const rawStr = String(body.path);
        let candidate;
        if (path.isAbsolute(rawStr) && rawStr.startsWith(workspaceRoot)) {
          // Real absolute filesystem path — normalise and use directly.
          candidate = path.normalize(rawStr);
        } else {
          // URL-style path: strip leading slashes and the /notebooks/ prefix,
          // then resolve relative to the workspace root.
          const stripped = rawStr.replace(/^\/+/, "").replace(/^notebooks\//, "");
          candidate = path.resolve(workspaceRoot, stripped);
        }

        // Security: must remain inside workspace
        const relToWs = path.relative(workspaceRoot, candidate);
        if (!relToWs || relToWs.startsWith("..") || path.isAbsolute(relToWs)) {
          json(response, 403, { error: "Path is outside the workspace" });
          return;
        }

        const fileKind = getOpenableFileKind(candidate);
        if (fileKind !== "text") {
          json(response, 400, { error: "Only text files (.js, .ts, .md, .txt) can be saved via this endpoint" });
          return;
        }

        const ext = path.extname(candidate).toLowerCase();
        let rawContent = String(body.content ?? "");
        let formattedContent = null;

        // Auto-format .js and .ts files with Prettier (same settings as notebooks).
        if (ext === ".js" || ext === ".ts") {
          try {
            const parser = ext === ".ts" ? "typescript" : "babel";
            const plugins = ext === ".ts"
              ? [prettierPluginTypeScript, prettierPluginEstree]
              : [prettierPluginBabel, prettierPluginEstree];

            formattedContent = await prettier.format(rawContent, {
              parser,
              plugins,
              printWidth: 100,
              tabWidth: 2,
              semi: false,
              singleQuote: false
            });
          } catch {
            // Formatting failed (e.g. syntax error) — save the raw content as-is
            formattedContent = null;
          }
        }

        const contentToWrite = formattedContent ?? rawContent;

        // Create parent directories if needed (supports new files in sub-folders)
        await fs.promises.mkdir(path.dirname(candidate), { recursive: true });
        await fs.promises.writeFile(candidate, contentToWrite, "utf8");
        json(response, 200, { ok: true, path: candidate, formattedContent });
        return;
      }

      // ── /api/folder/delete — recursively remove a workspace directory ────
      if (request.method === "POST" && requestUrl.pathname === "/api/folder/delete") {
        const body = await readRequestBody(request);
        if (!body.path) {
          json(response, 400, { error: "Missing path" });
          return;
        }

        const folderPath = path.isAbsolute(body.path)
          ? path.normalize(body.path)
          : path.resolve(workspaceRoot, body.path);

        const relToWorkspace = path.relative(workspaceRoot, folderPath);
        if (!relToWorkspace || relToWorkspace.startsWith("..") || path.isAbsolute(relToWorkspace)) {
          json(response, 403, { error: "Path is outside workspace" });
          return;
        }

        // Safety: never delete the workspace root itself
        if (folderPath === workspaceRoot) {
          json(response, 403, { error: "Cannot delete workspace root" });
          return;
        }

        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
          json(response, 404, { error: "Folder not found" });
          return;
        }

        await fs.promises.rm(folderPath, { recursive: true, force: true });
        json(response, 200, { ok: true });
        return;
      }

      // ── /api/file/delete — permanently remove any workspace file ─────────
      if (request.method === "POST" && requestUrl.pathname === "/api/file/delete") {
        const body = await readRequestBody(request);
        if (!body.path) {
          json(response, 400, { error: "Missing path" });
          return;
        }

        const filePath = path.isAbsolute(body.path)
          ? path.normalize(body.path)
          : path.resolve(workspaceRoot, body.path);

        // Security: use path.relative to verify the file is inside the workspace
        const relToWorkspace = path.relative(workspaceRoot, filePath);
        if (!relToWorkspace || relToWorkspace.startsWith("..") || path.isAbsolute(relToWorkspace)) {
          json(response, 403, { error: "Path is outside workspace" });
          return;
        }

        // Block notebook files from this endpoint — use /api/notebook/delete instead
        if (filePath.endsWith(NOTEBOOK_EXTENSION)) {
          json(response, 400, { error: "Use /api/notebook/delete for notebooks" });
          return;
        }

        if (!fs.existsSync(filePath)) {
          json(response, 404, { error: "File not found" });
          return;
        }

        await fs.promises.unlink(filePath);
        json(response, 200, { ok: true });
        return;
      }

      // ── /api/stats/reset-executions — zero out all cell execution counts ──
      if (request.method === "POST" && requestUrl.pathname === "/api/stats/reset-executions") {
        async function resetExecutionsInDir(dir) {
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return; }
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { await resetExecutionsInDir(abs); continue; }
            if (!entry.name.endsWith(NOTEBOOK_EXTENSION)) continue;
            try {
              const raw = await fs.promises.readFile(abs, "utf8");
              const nb = JSON.parse(raw);
              let changed = false;
              for (const cell of nb.cells ?? []) {
                if (typeof cell.executionCount === "number" && cell.executionCount !== 0) {
                  cell.executionCount = 0;
                  changed = true;
                }
              }
              if (changed) {
                await fs.promises.writeFile(abs, JSON.stringify(nb, null, 2));
              }
            } catch { /* skip malformed */ }
          }
        }
        await resetExecutionsInDir(workspaceRoot);
        json(response, 200, { ok: true });
        return;
      }

      // ── /api/stats/reset-ai-tokens — zero out stored AI token usage ───────
      if (request.method === "POST" && requestUrl.pathname === "/api/stats/reset-ai-tokens") {
        async function resetTokensInDir(dir) {
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return; }
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { await resetTokensInDir(abs); continue; }
            if (!entry.name.endsWith(NOTEBOOK_EXTENSION)) continue;
            try {
              const raw = await fs.promises.readFile(abs, "utf8");
              const nb = JSON.parse(raw);
              let changed = false;
              for (const cell of nb.cells ?? []) {
                if (cell.type !== "prompt") continue;
                const metrics = cell.metrics && typeof cell.metrics === "object" ? cell.metrics : {};
                const nextMetrics = {
                  aiTokensIn: 0,
                  aiTokensOut: 0,
                  aiTokensTotal: 0,
                  aiTokensUpdatedAt: new Date().toISOString()
                };
                const merged = { ...metrics, ...nextMetrics };
                if (JSON.stringify(merged) !== JSON.stringify(metrics)) {
                  cell.metrics = merged;
                  changed = true;
                } else if (!cell.metrics) {
                  cell.metrics = nextMetrics;
                  changed = true;
                }
              }
              if (changed) {
                await fs.promises.writeFile(abs, JSON.stringify(nb, null, 2));
              }
            } catch { /* skip malformed */ }
          }
        }
        await resetTokensInDir(workspaceRoot);
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/vendor/monaco/")) {
        const vendorPath = requestUrl.pathname.replace("/vendor/monaco", "");
        await serveFile(monacoDir, vendorPath, response);
        return;
      }

      if (request.method === "GET") {
        await serveStaticAsset(requestUrl.pathname, response);
        return;
      }

      notFound(response);
    } catch (error) {
      // If the streaming execute handler already sent headers (e.g. for NDJSON),
      // calling json() would invoke response.writeHead() a second time and throw
      // ERR_HTTP_HEADERS_SENT, crashing the server.  Skip the error response when
      // headers have already been flushed — the client will detect the stream close.
      if (!response.headersSent) {
        json(response, 500, {
          error: error?.message ?? String(error),
          stack: error?.stack ?? null
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });

  server.timeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  return {
    server,
    workspaceRoot,
    notebooksDir
  };
}

export async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3113);
  const host = String(options.host ?? process.env.HOST ?? "127.0.0.1");
  const { server, workspaceRoot } = await createServer(options);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    port,
    host,
    workspaceRoot
  };
}
