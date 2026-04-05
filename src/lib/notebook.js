import { randomUUID } from "node:crypto";

export const NOTEBOOK_VERSION = 1;
export const NOTEBOOK_EXTENSION = ".ijsnb";

function createPromptConfig(prompt = {}) {
  return {
    provider: typeof prompt.provider === "string" && prompt.provider.trim() ? prompt.provider : "groq",
    model: typeof prompt.model === "string" && prompt.model.trim() ? prompt.model : "llama-3.3-70b-versatile",
    system: typeof prompt.system === "string" ? prompt.system : "",
    temperature: Number.isFinite(prompt.temperature) ? Number(prompt.temperature) : 0.2
  };
}

export function createCell(type = "code", source = "", options = {}) {
  const cell = {
    id: randomUUID(),
    type,
    source,
    executionCount: null,
    outputs: [],
    collapsed: false,
    outputCollapsed: false,
    metrics: {
      aiTokensIn: 0,
      aiTokensOut: 0,
      aiTokensTotal: 0,
      aiTokensUpdatedAt: null
    }
  };

  if (type === "code") {
    cell.language = options.language === "javascript" ? "javascript" : "typescript";
  }

  if (type === "prompt") {
    cell.prompt = createPromptConfig(options.prompt);
  }

  return cell;
}

export function createNotebook(title = "Untitled Nodebook") {
  return {
    format: "ijsnb",
    version: NOTEBOOK_VERSION,
    metadata: {
      title,
      createdAt: new Date().toISOString(),
      env: {}
    },
    cells: [
      createCell(
        "markdown",
        "# Welcome to Mars Book\n\nRun JavaScript and Node.js code with persistent notebook state."
      ),
      createCell(
        "code",
        [
          "console.log('Welcome to Mars Book')",
        ].join("\n"),
        { language: "typescript" }
      )
    ]
  };
}

export function normalizeNotebook(rawNotebook) {
  const notebook = rawNotebook && typeof rawNotebook === "object" ? rawNotebook : {};
  const metadata = notebook.metadata && typeof notebook.metadata === "object" ? notebook.metadata : {};
  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];

  return {
    format: "ijsnb",
    version: NOTEBOOK_VERSION,
    metadata: {
      title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : "Untitled Nodebook",
      createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ai:
        metadata.ai && typeof metadata.ai === "object"
          ? {
              provider:
                typeof metadata.ai.provider === "string" && metadata.ai.provider.trim()
                  ? metadata.ai.provider
                  : "groq",
              model:
                typeof metadata.ai.model === "string" && metadata.ai.model.trim()
                  ? metadata.ai.model
                  : "llama-3.3-70b-versatile"
            }
          : {
              provider: "groq",
              model: "llama-3.3-70b-versatile"
            },
      env:
        metadata.env && typeof metadata.env === "object"
          ? Object.fromEntries(
              Object.entries(metadata.env)
                .map(([key, value]) => [String(key).trim(), typeof value === "string" ? value : String(value ?? "")])
                .filter(([key]) => key)
            )
          : {}
    },
    cells: cells.length
      ? cells.map((cell) => {
          const cellType = cell.type === "markdown" ? "markdown" : cell.type === "prompt" ? "prompt" : "code";
          const metrics = cell.metrics && typeof cell.metrics === "object" ? cell.metrics : {};
          const normalizedCell = {
            id: typeof cell.id === "string" && cell.id ? cell.id : randomUUID(),
            type: cellType,
            source: typeof cell.source === "string" ? cell.source : "",
            executionCount: Number.isInteger(cell.executionCount) ? cell.executionCount : null,
            outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
            collapsed: Boolean(cell.collapsed),
            outputCollapsed: Boolean(cell.outputCollapsed),
            metrics: {
              aiTokensIn: Number.isFinite(metrics.aiTokensIn) ? metrics.aiTokensIn : 0,
              aiTokensOut: Number.isFinite(metrics.aiTokensOut) ? metrics.aiTokensOut : 0,
              aiTokensTotal: Number.isFinite(metrics.aiTokensTotal)
                ? metrics.aiTokensTotal
                : (Number.isFinite(metrics.aiTokensIn) || Number.isFinite(metrics.aiTokensOut)
                    ? (Number(metrics.aiTokensIn) || 0) + (Number(metrics.aiTokensOut) || 0)
                    : 0),
              aiTokensUpdatedAt: typeof metrics.aiTokensUpdatedAt === "string" ? metrics.aiTokensUpdatedAt : null
            }
          };

          if (cellType === "code") {
            normalizedCell.language = cell.language === "javascript" ? "javascript" : "typescript";
          }

          if (cellType === "prompt") {
            normalizedCell.prompt = createPromptConfig(cell.prompt);
          }

          return normalizedCell;
        })
      : [createCell("code", "console.log('Nodebook is ready');", { language: "typescript" })]
  };
}
