import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function createNotebookRequire(notebookPath) {
  const anchor = path.join(path.dirname(notebookPath), "__nodebook__.mjs");
  return createRequire(anchor);
}

function findPackageRootFromEntry(entryPath) {
  let currentPath = path.dirname(entryPath);

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

/**
 * Find the root directory of an @types/ package by walking up the directory tree.
 *
 * `@types/*` packages contain ONLY `.d.ts` declaration files — they have no
 * JavaScript entry point, so `require.resolve('@types/express')` always throws
 * MODULE_NOT_FOUND.  We locate them by scanning the filesystem directly instead.
 *
 * @param {string} notebookPath  – absolute path to the .ijsnb file
 * @param {string} atTypesName   – full scoped name, e.g. "@types/express"
 * @returns {string|null} absolute path to the @types/<name> root, or null
 */
function findAtTypesRoot(notebookPath, atTypesName) {
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

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveDeclarationFile(fromFile, specifier) {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.d.ts`,
    `${basePath}.d.cts`,
    `${basePath}.d.mts`,
    path.join(basePath, "index.d.ts"),
    path.join(basePath, "index.d.cts"),
    path.join(basePath, "index.d.mts")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function classifyNode(node) {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableStatement(node)) return "variable";
  return "symbol";
}

function deriveDefaultImportName(moduleName) {
  const baseName = moduleName.includes("/")
    ? moduleName.split("/").at(-1)
    : moduleName;

  const normalized = String(baseName ?? "pkg")
    .replace(/[^a-zA-Z0-9_$]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");

  return normalized || "pkg";
}

function addExportSymbol(store, moduleName, name, kind, options = {}) {
  if (!name || name === "default" || name === "__esModule") {
    return;
  }

  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return;
  }

  const key = `${moduleName}:${name}`;
  if (store.has(key)) {
    return;
  }

  store.set(key, {
    moduleName,
    exportName: name,
    importName: name,
    kind,
    isDefault: Boolean(options.isDefault)
  });
}

function collectPackageSymbols(moduleName, entryFile) {
  const visitedFiles = new Set();
  const exportsMap = new Map();

  function visit(filePath) {
    if (!filePath || visitedFiles.has(filePath) || !fs.existsSync(filePath)) {
      return;
    }

    visitedFiles.add(filePath);

    let sourceText = "";
    try {
      sourceText = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }

    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement)) {
        const localName = deriveDefaultImportName(moduleName);
        addExportSymbol(exportsMap, moduleName, localName, "default", { isDefault: true });
        continue;
      }

      if (ts.isExportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;

        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const exportName = element.name.text;
            addExportSymbol(exportsMap, moduleName, exportName, "symbol");
          }
        } else if (!statement.exportClause && moduleSpecifier && isRelativeSpecifier(moduleSpecifier)) {
          visit(resolveDeclarationFile(filePath, moduleSpecifier));
        }

        continue;
      }

      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        continue;
      }

      const kind = classifyNode(statement);
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addExportSymbol(exportsMap, moduleName, declaration.name.text, kind);
          }
        }

        continue;
      }

      if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) {
        addExportSymbol(exportsMap, moduleName, statement.name.text, kind);
      } else if (isDefault) {
        addExportSymbol(exportsMap, moduleName, deriveDefaultImportName(moduleName), "default", { isDefault: true });
      }
    }
  }

  visit(entryFile);

  return Array.from(exportsMap.values())
    .sort((left, right) => left.exportName.localeCompare(right.exportName));
}

export async function collectDeclaredPackageExports(notebookPath, moduleNames) {
  const exportEntries = [];

  for (const moduleName of moduleNames) {
    // Skip @types/ packages themselves — they are type companions, not importable modules.
    // Their symbols are collected via the @types fallback path below when the main
    // package (e.g. "express") has no bundled declarations.
    if (moduleName.startsWith("@types/")) continue;

    const packageRoot = resolvePackageRoot(notebookPath, moduleName);
    if (!packageRoot) {
      continue;
    }

    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    let packageJson = {};
    try {
      packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf8"));
    } catch {
      continue;
    }

    let declarationEntry = resolveDeclarationEntry(packageRoot, packageJson);

    // Many popular packages (express, axios, lodash, etc.) ship NO bundled .d.ts
    // files and rely on a companion "@types/<name>" package from DefinitelyTyped.
    // When the package itself has no declaration entry, try that companion package
    // so we still get named-export auto-complete for the original module name.
    //
    // IMPORTANT: we use findAtTypesRoot() NOT resolvePackageRoot() here because
    // @types/* packages have no JavaScript entry point, so require.resolve() always
    // throws MODULE_NOT_FOUND for them.
    if (!declarationEntry) {
      const atTypesName = moduleName.startsWith("@")
        ? `@types/${moduleName.slice(1).replace("/", "__")}` // @scope/pkg → @types/scope__pkg
        : `@types/${moduleName}`;

      const atTypesRoot = findAtTypesRoot(notebookPath, atTypesName);
      if (atTypesRoot) {
        try {
          const atTypesPkgJsonPath = path.join(atTypesRoot, "package.json");
          const atTypesPkgJson = JSON.parse(
            await fs.promises.readFile(atTypesPkgJsonPath, "utf8")
          );
          declarationEntry = resolveDeclarationEntry(atTypesRoot, atTypesPkgJson);
        } catch {
          // ignore — fall through to the next module
        }
      }
    }

    if (!declarationEntry) {
      continue;
    }

    exportEntries.push(...collectPackageSymbols(moduleName, declarationEntry));
  }

  return exportEntries;
}
