import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { builtinModules } from "node:module";

import { parse } from "acorn";
import ts from "typescript";

function formatValue(value) {
  return util.inspect(value, {
    depth: 6,
    colors: false,
    compact: false,
    breakLength: 100
  });
}

function sanitizeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? String(error)
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function looksLikeImageSource(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  return (
    trimmed.startsWith("data:image/") ||
    /^https?:\/\/.+\.(png|jpe?g|gif|svg|webp|avif)(\?.*)?$/i.test(trimmed)
  );
}

function normalizeTableRows(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  if (value.every((item) => isPlainObject(item))) {
    return value;
  }

  if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
    return value.map((item, index) => ({ index, value: item }));
  }

  return null;
}

function isNodeTimeout(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value._idleTimeout === "number" &&
    typeof value._onTimeout === "function"
  );
}

function createTimeoutHooks(ctx, outputs) {
  const original = {
    setTimeout: ctx.setTimeout,
    clearTimeout: ctx.clearTimeout
  };

  const pendingTasks = new Set();
  const pendingTimeouts = new Map();

  const registerTask = () => {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    pendingTasks.add(promise);
    promise.finally(() => pendingTasks.delete(promise));
    return resolve;
  };

  ctx.setTimeout = (fn, delay = 0, ...args) => {
    let handle;
    const settle = registerTask();
    const wrapped = (...cbArgs) => {
      try {
        return fn?.apply(ctx, cbArgs);
      } finally {
        settle();
        pendingTimeouts.delete(handle);
      }
    };
    handle = original.setTimeout(wrapped, delay, ...args);
    pendingTimeouts.set(handle, settle);
    return handle;
  };

  ctx.clearTimeout = (handle) => {
    const settle = pendingTimeouts.get(handle);
    if (settle) {
      settle();
      pendingTimeouts.delete(handle);
    }
    return original.clearTimeout(handle);
  };

  const flush = async (maxMs = 10_000) => {
    const start = Date.now();
    let forcedCleanup = false;

    while (pendingTasks.size > 0 && Date.now() - start < maxMs) {
      // Wait for any pending timeout callback to settle
      await Promise.race([
        Promise.allSettled([...pendingTasks]),
        new Promise((resolve) => setTimeout(resolve, 10))
      ]);
    }

    if (pendingTasks.size > 0 || pendingTimeouts.size > 0) {
      forcedCleanup = true;
      for (const handle of pendingTimeouts.keys()) {
        try {
          original.clearTimeout(handle);
        } catch (_e) { /* ignore */ }
      }
      pendingTimeouts.clear();
      pendingTasks.clear();
    }

    if (forcedCleanup) {
      outputs.push({
        type: "warn",
        text: "setTimeout callbacks were auto-cleared after 10s to finish the cell. Use clearTimeout inside the cell to cancel long waits.",
        dataType: "text"
      });
    }
  };

  const restore = () => {
    ctx.setTimeout = original.setTimeout;
    ctx.clearTimeout = original.clearTimeout;
  };

  // Expose to cancelExecution heuristics
  ctx.__nodebookPendingTimeouts = pendingTimeouts;

  return { flush, restore };
}

function createIntervalHooks(ctx, outputs) {
  const original = {
    setInterval: ctx.setInterval,
    clearInterval: ctx.clearInterval
  };

  const activeIntervals = new Set();

  ctx.setInterval = (fn, delay = 0, ...args) => {
    const wrapped = (...cbArgs) => {
      return fn?.apply(ctx, cbArgs);
    };
    const handle = original.setInterval(wrapped, delay, ...args);
    activeIntervals.add(handle);
    return handle;
  };

  ctx.clearInterval = (handle) => {
    activeIntervals.delete(handle);
    return original.clearInterval(handle);
  };

  const waitForDrain = async (cancelPromise) => {
    let cancelled = false;
    const cancelWait = cancelPromise ? cancelPromise.then(() => { cancelled = true; }) : null;
    while (activeIntervals.size > 0 && !cancelled) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 50)),
        cancelWait ?? new Promise(() => {})
      ]);
    }
  };

  const restore = () => {
    ctx.setInterval = original.setInterval;
    ctx.clearInterval = original.clearInterval;
  };

  ctx.__nodebookActiveIntervals = activeIntervals;

  return { waitForDrain, restore, activeIntervals };
}

function serializeOutputValue(value, type = "result") {
  if (value && typeof value === "object" && value.__nodebookDisplay) {
    return {
      type,
      text: value.text ?? formatValue(value.payload),
      dataType: value.__nodebookDisplay,
      data: value.payload ?? null
    };
  }

  if (typeof value === "string") {
    if (looksLikeImageSource(value)) {
      return {
        type,
        text: value,
        dataType: "image",
        data: { src: value, alt: "" }
      };
    }

    return {
      type,
      text: value,
      dataType: "text"
    };
  }

  const tableRows = normalizeTableRows(value);
  if (tableRows) {
    return {
      type,
      text: formatValue(value),
      dataType: "array",
      data: value,
      tableData: tableRows
    };
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    return {
      type,
      text: formatValue(value),
      dataType: "json",
      data: value
    };
  }

  return {
    type,
    text: formatValue(value),
    dataType: "text"
  };
}

function getVariableKind(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  return typeof value;
}

function getBoundIdentifiers(pattern, identifiers = []) {
  if (!pattern) {
    return identifiers;
  }

  switch (pattern.type) {
    case "Identifier":
      identifiers.push(pattern.name);
      break;
    case "RestElement":
      getBoundIdentifiers(pattern.argument, identifiers);
      break;
    case "AssignmentPattern":
      getBoundIdentifiers(pattern.left, identifiers);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        getBoundIdentifiers(element, identifiers);
      }
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          getBoundIdentifiers(property.argument, identifiers);
          continue;
        }

        getBoundIdentifiers(property.value, identifiers);
      }
      break;
    default:
      break;
  }

  return identifiers;
}

function transformImportDeclaration(node, importIndex) {
  const referenceName = `__nodebook_import_${importIndex}`;
  const lines = [`const ${referenceName} = await globalThis.__nodebookImport(${JSON.stringify(node.source.value)});`];

  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportDefaultSpecifier") {
      lines.push(`globalThis.__nodebookSet(${JSON.stringify(specifier.local.name)}, ${referenceName}.default ?? ${referenceName});`);
      continue;
    }

    if (specifier.type === "ImportNamespaceSpecifier") {
      lines.push(`globalThis.__nodebookSet(${JSON.stringify(specifier.local.name)}, ${referenceName}.__nodebook_namespace ?? ${referenceName});`);
      continue;
    }

    const importedName =
      specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
    lines.push(`globalThis.__nodebookSet(${JSON.stringify(specifier.local.name)}, ${referenceName}[${JSON.stringify(importedName)}]);`);
  }

  return lines.join("\n");
}

function transformHoistedStatement(node, source, cellId = null) {
  const names =
    node.type === "VariableDeclaration"
      ? node.declarations.flatMap((declaration) => getBoundIdentifiers(declaration.id))
      : node.id?.name
        ? [node.id.name]
        : [];
  const statement = source.slice(node.start, node.end);

  if (names.length === 0) {
    return statement;
  }

  const setLines = names.map((name) => `globalThis.__nodebookSet(${JSON.stringify(name)}, ${name});`);

  // For const declarations: register protection so that bare `name = value` assignments
  // in later cells throw. Re-declarations via `const name = ...` are always allowed
  // (they reset the old const) so notebooks remain freely re-runnable.
  if (
    node.type === "VariableDeclaration" &&
    node.kind === "const" &&
    cellId !== null
  ) {
    const cellIdStr = JSON.stringify(cellId);
    const registerLines = names.map(
      (name) => `if (globalThis.__nodebookRegisterConst) globalThis.__nodebookRegisterConst(${JSON.stringify(name)}, ${cellIdStr});`
    );
    return `{\n${statement}\n${setLines.join("\n")}\n${registerLines.join("\n")}\n}`;
  }

  return `{\n${statement}\n${setLines.join("\n")}\n}`;
}

function transformTopLevelStatement(node, source, importIndex, cellId = null) {
  if (node.type === "ImportDeclaration") {
    return transformImportDeclaration(node, importIndex);
  }

  if (node.type === "VariableDeclaration" || node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return transformHoistedStatement(node, source, cellId);
  }

  if (node.type === "ExportNamedDeclaration") {
    // Skip bare `export {}` — TypeScript module sentinel, has no runtime effect
    if (!node.declaration && node.specifiers.length === 0 && !node.source) {
      return "";
    }
    if (node.declaration) {
      return transformTopLevelStatement(node.declaration, source, importIndex, cellId);
    }
  }

  // Skip `export default` / `export * from` at top level — not needed in notebook context
  if (node.type === "ExportDefaultDeclaration") {
    return source.slice(node.declaration.start, node.declaration.end);
  }

  if (node.type === "ExportAllDeclaration") {
    return "";
  }

  return source.slice(node.start, node.end);
}

function stripTypeScriptTypes(source) {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      // Preserve runtime imports even when a cell only imports a symbol for later cells.
      // Type-only imports are still erased or reduced to `import {}` by TypeScript.
      verbatimModuleSyntax: true,
      removeComments: false,
      sourceMap: false
    },
    reportDiagnostics: false
  });

  // TypeScript appends `export {};` to mark transpiled output as an ES module.
  // This is a no-op sentinel that is invalid inside a vm.Script async IIFE wrapper,
  // so we strip it before handing the code to Acorn / our AST transformer.
  return result.outputText.replace(/\nexport\s*\{\s*\};\s*\n?$/, "\n");
}

/**
 * Walk an AST and collect start offsets of every prompt()/input() CallExpression
 * that is NOT already wrapped in an AwaitExpression. Inserting `await ` at those
 * offsets lets users write `const name = prompt("Name: ")` without an explicit
 * `await` and still have the execution pause until the user provides input.
 */
function collectInputCallOffsets(ast) {
  const offsets = [];

  function walk(node, parentIsAwait) {
    if (!node || typeof node !== "object" || !node.type) return;

    if (node.type === "AwaitExpression") {
      // The direct argument is already awaited — mark it so we don't double-wrap.
      if (node.argument) walk(node.argument, true);
      return;
    }

    if (
      node.type === "CallExpression" &&
      !parentIsAwait &&
      node.callee?.type === "Identifier" &&
      (node.callee.name === "prompt" || node.callee.name === "input")
    ) {
      offsets.push(node.start);
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && item.type) walk(item, false);
        }
      } else if (child && typeof child === "object" && child.type) {
        walk(child, false);
      }
    }
  }

  walk(ast, false);
  return offsets.sort((a, b) => a - b);
}

function compileNotebookCode(source, language = "typescript", cellId = null) {
  const jsSource = language === "typescript" ? stripTypeScriptTypes(source) : source;
  const ast = parse(jsSource, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true
  });

  // Automatically insert `await` before bare prompt()/input() calls so that
  // `const name = prompt("Name: ")` blocks until the user provides input,
  // matching the synchronous-feeling browser prompt() API.
  const promptOffsets = collectInputCallOffsets(ast);
  let finalSource = jsSource;
  let finalAst = ast;

  if (promptOffsets.length > 0) {
    // Insert `await ` from right to left so earlier offsets stay valid.
    for (let i = promptOffsets.length - 1; i >= 0; i--) {
      const offset = promptOffsets[i];
      finalSource = finalSource.slice(0, offset) + "await " + finalSource.slice(offset);
    }
    // Re-parse so node offsets align with the new source for slicing below.
    finalAst = parse(finalSource, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true
    });
  }

  const statements = [];
  let importIndex = 0;

  for (let index = 0; index < finalAst.body.length; index += 1) {
    const node = finalAst.body[index];
    const isLast = index === finalAst.body.length - 1;

    if (isLast && node.type === "ExpressionStatement") {
      statements.push(`return (${finalSource.slice(node.expression.start, node.expression.end)});`);
      continue;
    }

    statements.push(transformTopLevelStatement(node, finalSource, importIndex, cellId));

    if (node.type === "ImportDeclaration") {
      importIndex += 1;
    }
  }

  return `(async () => {\n${statements.join("\n\n")}\n})()`;
}

export class KernelSession {
  constructor(notebookPath) {
    this.notebookPath = notebookPath;
    this.workingDirectory = path.dirname(notebookPath);
    this.importBridgeDirectory = path.join(this.workingDirectory, ".nodebook-cache");
    this.executionCount = 0;
    this.context = this.createContext();

    // Counter used to give each bridge file a unique URL so Node.js's ESM loader
    // never reuses a cached (possibly failed) module resolution across attempts.
    this._importBridgeCounter = 0;

    // Maps a specifier to the bridge URL that was last successfully imported.
    // Once an import succeeds we reuse the same URL so Node.js can serve it
    // from its own module cache without re-reading the bridge file.
    this._resolvedBridges = new Map();
  }

  createContext() {
    const importModule = (specifier) => this.importModule(specifier);
    // CommonJS require() is intentionally disabled — notebooks use ES Modules only.
    // Calling require() at runtime throws a clear error pointing users to ESM syntax.
    const require = (id) => {
      throw new Error(
        `CommonJS (CJS) is not supported in this notebook.\n` +
        `Use ES Modules (ESM) instead:\n\n` +
        `  import ... from "${id}"`
      );
    };
    const sandbox = {
      globalThis: null,
      __nodebookImport: importModule,
      __nodebookSet: null,
      require,
      process: this.createProcessObject({}),
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      fetch,
      structuredClone,
      module: { exports: {} },
      exports: {},
      display: this.createDisplayApi([]),
      __dirname: this.workingDirectory,
      __filename: path.join(this.workingDirectory, "__cell__.js")
    };

    sandbox.globalThis = sandbox;
    sandbox.console = this.createConsole([]);

    const ctx = vm.createContext(sandbox, {
      name: `Nodebook:${path.basename(this.notebookPath)}`
    });

    // Define __nodebookSet AFTER contextification so it closes over ctx
    // (the contextified object) and sets properties on it from outside the vm.
    // Always bypasses any existing setter/getter so initial declarations in a cell
    // always succeed — even if a previous run left a const accessor on the property.
    ctx.__nodebookSet = (name, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(ctx, name);
      if (descriptor && (descriptor.get || descriptor.set)) {
        // Property is an accessor (const-protected). Update the backing store directly
        // so the getter returns the new value, and then re-protect as const.
        if (ctx.__nodebookConstStorage) {
          ctx.__nodebookConstStorage[name] = value;
        }
        return;
      }
      ctx[name] = value;
    };

    // Const protection tracking: prevents bare `x = value` assignments to const variables.
    // Re-declarations via `const x = ...` are always allowed (notebooks must be re-runnable).
    ctx.__nodebookConsts = new Set();        // names currently protected as const
    ctx.__nodebookCellConsts = new Map();    // cellId → Set<name> for cleanup on cell re-run
    ctx.__nodebookConstStorage = Object.create(null); // backing store for const getter/setters

    ctx.__nodebookRegisterConst = (name, cellId) => {
      ctx.__nodebookConsts.add(name);
      if (!ctx.__nodebookCellConsts.has(cellId)) ctx.__nodebookCellConsts.set(cellId, new Set());
      ctx.__nodebookCellConsts.get(cellId).add(name);
      // Snapshot the current value and install a throwing setter so bare `name = value`
      // assignments in any subsequent code throw TypeError, while __nodebookSet bypasses it.
      ctx.__nodebookConstStorage[name] = ctx[name];
      try {
        Object.defineProperty(ctx, name, {
          get() { return ctx.__nodebookConstStorage[name]; },
          set(_v) { throw new TypeError(`Assignment to constant variable '${name}'.`); },
          configurable: true,
          enumerable: true
        });
      } catch (_err) { /* ignore */ }
    };

    return ctx;
  }

  createProcessObject(envOverrides) {
    return {
      ...process,
      env: {
        ...process.env,
        ...envOverrides
      }
    };
  }

  createConsole(outputs) {
    const push = (kind, values) => {
      if (values.length === 1) {
        const entry = serializeOutputValue(values[0], kind);
        outputs.push(entry);
        this.onOutput?.(entry);
        return;
      }

      const entry = {
        type: kind,
        text: values.map((value) => formatValue(value)).join(" "),
        dataType: "text"
      };
      outputs.push(entry);
      this.onOutput?.(entry);
    };

    return {
      log: (...values) => push("log", values),
      info: (...values) => push("info", values),
      warn: (...values) => push("warn", values),
      error: (...values) => push("error", values),
      dir: (value) => push("log", [value]),
      table: (value) => {
        const rows = normalizeTableRows(value) ?? [{ value: formatValue(value) }];
        const entry = {
          type: "log",
          text: formatValue(value),
          dataType: "table",
          data: rows
        };
        outputs.push(entry);
        this.onOutput?.(entry);
      }
    };
  }

  createDisplayApi(outputs) {
    const push = (dataType, payload, text = formatValue(payload), outputType = "result") => {
      const entry = {
        type: outputType,
        text,
        dataType,
        data: payload
      };
      outputs.push(entry);
      this.onOutput?.(entry);
    };

    // Individual named methods
    const methods = {
      text:     (value)       => push("text",     { value: String(value ?? "") },                      String(value ?? "")),
      markdown: (value)       => push("markdown",  { markdown: String(value ?? "") },                  String(value ?? "")),
      html:     (value)       => push("html",      { html: String(value ?? "") },                      String(value ?? "")),
      image:    (src, alt="") => push("image",     { src: String(src ?? ""), alt: String(alt ?? "") }, String(src ?? "")),
      table:    (rows)        => push("table",     normalizeTableRows(rows) ?? rows,                   formatValue(rows)),
      chart:    (spec)        => push("chart",     spec,                                               formatValue(spec)),
    };

    // Also callable as display({ type, ... }) so both styles work:
    //   display({ type: 'html', html: '...' })   ← object style
    //   display.html('...')                       ← method style
    const displayFn = (arg) => {
      if (arg && typeof arg === "object" && typeof arg.type === "string") {
        const { type, ...rest } = arg;
        switch (type) {
          case "text":     return methods.text(rest.text ?? rest.value ?? "");
          case "markdown": return methods.markdown(rest.markdown ?? rest.value ?? "");
          case "html":     return methods.html(rest.html ?? rest.value ?? "");
          case "image":    return methods.image(rest.src ?? rest.url ?? "", rest.alt ?? "");
          case "table":    return methods.table(rest.data ?? rest.rows ?? []);
          case "chart":    return methods.chart(rest);
          default:         return methods.text(formatValue(arg));
        }
      }
      // Plain value fallback — format and show as text
      return methods.text(formatValue(arg));
    };

    // Attach named methods so display.html() etc. still work
    Object.assign(displayFn, methods);
    return displayFn;
  }

  resolveDynamicImport(specifier) {
    if (specifier.startsWith("node:")) {
      return specifier;
    }

    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const absolutePath = specifier.startsWith("/")
        ? specifier
        : path.resolve(this.workingDirectory, specifier);

      return pathToFileURL(absolutePath).href;
    }

    return specifier;
  }

  /**
   * Create a brand-new bridge .mjs file for the given specifier.
   *
   * Each call produces a file with a unique, counter-suffixed name so that
   * successive import attempts always get a URL that Node.js has never seen
   * before.  This is the key mechanism that defeats the ESM loader's
   * per-URL failure cache: a previously failed URL is simply abandoned and a
   * fresh URL is used instead.
   */
  async _createFreshImportBridge(specifier) {
    await fs.promises.mkdir(this.importBridgeDirectory, { recursive: true });

    this._importBridgeCounter += 1;
    const fileHash = createHash("sha1").update(specifier).digest("hex");
    const bridgePath = path.join(
      this.importBridgeDirectory,
      `${fileHash}_${this._importBridgeCounter}.mjs`
    );

    const bridgeSource = [
      `export * from ${JSON.stringify(specifier)};`,
      `import * as __nodebook_namespace from ${JSON.stringify(specifier)};`,
      "export { __nodebook_namespace };",
      "export default ('default' in __nodebook_namespace ? __nodebook_namespace.default : __nodebook_namespace);"
    ].join("\n");

    await fs.promises.writeFile(bridgePath, bridgeSource);
    return pathToFileURL(bridgePath).href;
  }

  async importModule(specifier) {
    if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) {
      return import(this.resolveDynamicImport(specifier));
    }

    // If we already have a bridge URL that was successfully imported in this
    // session, reuse it — Node.js will serve the result from its own cache.
    const cachedUrl = this._resolvedBridges.get(specifier);
    if (cachedUrl) {
      return import(cachedUrl);
    }

    // No successful import yet (either first attempt, or a previous attempt
    // failed because the package wasn't installed at that point).
    // Always create a FRESH bridge file with a new unique URL so we bypass any
    // failure that Node.js's ESM loader may have cached for an earlier URL.
    const bridgeUrl = await this._createFreshImportBridge(specifier);

    try {
      const result = await import(bridgeUrl);
      // Mark this URL as the canonical bridge for this specifier so that
      // subsequent cells reuse it without creating yet another file.
      this._resolvedBridges.set(specifier, bridgeUrl);
      return result;
    } catch (error) {
      // Import failed (e.g. package not yet installed).  The bridge URL is
      // abandoned — the next call will create a new one and try again.
      throw error;
    }
  }

  applyEnvOverrides(envOverrides) {
    const previousValues = new Map();

    for (const [key, value] of Object.entries(envOverrides)) {
      previousValues.set(key, process.env[key]);
      process.env[key] = value;
    }

    return () => {
      for (const [key, previousValue] of previousValues.entries()) {
        if (previousValue === undefined) {
          delete process.env[key];
          continue;
        }

        process.env[key] = previousValue;
      }
    };
  }

  async execute(code, cellId, envOverrides = {}, language = "typescript", onOutput = null, inputProvider = async () => "") {
    const outputs = [];
    const ctx = this.context;
    this.executionCount += 1;
    this.onOutput = onOutput;
    ctx.console = this.createConsole(outputs);
    ctx.display = this.createDisplayApi(outputs);
    ctx.process = this.createProcessObject(envOverrides);
    const provideInput = typeof inputProvider === "function" ? inputProvider : async () => "";
    // Expose async input helpers for browser-driven prompts; also mirror on window for familiarity.
    ctx.input = provideInput;
    ctx.prompt = provideInput;
    ctx.window = ctx.window ?? ctx;
    ctx.window.input = provideInput;
    ctx.window.prompt = provideInput;
    const timeouts = createTimeoutHooks(ctx, outputs);
    const intervals = createIntervalHooks(ctx, outputs);
    const cancelPromise = new Promise((resolve) => {
      this.cancelResolver = () => resolve();
    });
    const restoreEnv = this.applyEnvOverrides(envOverrides);

    // Clear previous const declarations for this cell to allow re-running the same cell.
    // Also clears consts from OTHER cells for any variable name that this cell will re-declare
    // (cell IDs can change on notebook reload — notebooks must always be re-runnable).
    if (cellId) {
      const prevConsts = ctx.__nodebookCellConsts?.get(cellId);
      if (prevConsts) {
        for (const name of prevConsts) {
          ctx.__nodebookConsts?.delete(name);
          // Reset accessor property back to a plain writable data property
          try {
            Object.defineProperty(ctx, name, {
              value: ctx.__nodebookConstStorage?.[name],
              writable: true,
              configurable: true,
              enumerable: true
            });
          } catch (_e) { /* ignore */ }
        }
        ctx.__nodebookCellConsts.delete(cellId);
      }
    }

    try {
      const compiledCode = compileNotebookCode(code, language, cellId);
      const script = new vm.Script(compiledCode, {
        filename: cellId ? `${cellId}.mjs` : "__cell__.mjs"
      });

      ctx.__nodebookImport = (specifier) => this.importModule(specifier);

      let value = script.runInContext(ctx, {
        timeout: 10_000
      });

      if (value && typeof value.then === "function") {
        value = await value;
      }

      await timeouts.flush();

      // Suppress raw Node.js Timeout objects returned by setInterval/setTimeout
      if (value !== undefined && isNodeTimeout(value)) {
        value = undefined;
      }

      if (intervals.activeIntervals.size > 0) {
        await intervals.waitForDrain(cancelPromise);
      }

      if (value !== undefined) {
        const entry = serializeOutputValue(value, "result");
        outputs.push(entry);
        this.onOutput?.(entry);
      }

      return {
        ok: true,
        executionCount: this.executionCount,
        outputs
      };
    } catch (error) {
      await timeouts.flush();

      const entry = {
        type: "error",
        text: sanitizeError(error).stack
      };
      outputs.push(entry);
      this.onOutput?.(entry);

      return {
        ok: false,
        executionCount: this.executionCount,
        outputs,
        error: sanitizeError(error)
      };
    } finally {
      this.onOutput = null;
      timeouts.restore();
      intervals.restore();
      restoreEnv();
    }
  }

  async listInstalledModules() {
    const packages = new Set(
      builtinModules
        .filter((moduleName) => !moduleName.startsWith("_"))
        .map((moduleName) => moduleName.replace(/^node:/, ""))
    );

    for (const dep of await this.listDeclaredPackages()) {
      packages.add(dep);
    }

    return Array.from(packages).sort((left, right) => left.localeCompare(right));
  }

  async listDeclaredPackages() {
    const packageJsonPath = path.join(this.workingDirectory, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      return [];
    }

    const raw = await fs.promises.readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(raw);
    const deps = Object.keys(packageJson.dependencies ?? {});
    const devDeps = Object.keys(packageJson.devDependencies ?? {});

    return Array.from(new Set([...deps, ...devDeps])).sort((left, right) => left.localeCompare(right));
  }

  /**
   * Invalidate the import bridge cache for one specific package or for ALL
   * packages (when no specifier is given).
   *
   * Call this after any npm install / uninstall / update operation so that the
   * next import() creates a fresh bridge file with a new URL, bypassing
   * Node.js's ESM module cache.  This ensures:
   *   - Newly installed packages become importable immediately.
   *   - Uninstalled packages stop being importable immediately (no stale cache).
   */
  invalidateImportCache(specifier = null) {
    if (specifier) {
      this._resolvedBridges.delete(specifier);
    } else {
      this._resolvedBridges.clear();
    }
  }

  cancelExecution() {
    const ctx = this.context;
    try {
      // Find all Timeout-like entries on the context (limited heuristic)
      for (const key of Object.keys(ctx)) {
        const val = ctx[key];
        if (val !== null && typeof val === "object" && typeof val._idleTimeout === "number") {
          clearTimeout(val);
          clearInterval(val);
        }
      }
      if (ctx.__nodebookActiveIntervals) {
        for (const handle of ctx.__nodebookActiveIntervals) {
          try { clearInterval(handle); } catch (_e) { /* ignore */ }
        }
        ctx.__nodebookActiveIntervals.clear();
      }
      if (ctx.__nodebookPendingTimeouts) {
        for (const handle of ctx.__nodebookPendingTimeouts.keys()) {
          try { clearTimeout(handle); } catch (_e) { /* ignore */ }
        }
        ctx.__nodebookPendingTimeouts.clear();
      }
    } catch (_e) { /* ignore */ }
  }

  listVariables() {
    const internalNames = new Set([
      "globalThis", "__nodebookImport", "require", "process", "Buffer", "URL", "URLSearchParams",
      "TextEncoder", "TextDecoder", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
      "setImmediate", "clearImmediate", "fetch", "structuredClone", "module", "exports",
      "__dirname", "__filename", "console", "display"
    ]);

    return Object.keys(this.context)
      .filter((name) => !internalNames.has(name) && !name.startsWith("__nodebook"))
      .map((name) => {
        const value = this.context[name];
        return {
          name,
          kind: getVariableKind(value),
          preview: formatValue(value),
          dataType: serializeOutputValue(value).dataType ?? "text"
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
