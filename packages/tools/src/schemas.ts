/**
 * Standard JSON Schemas for Tool Layer v1.
 */

export const fsReadSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Relative or absolute path of the file to read.",
    },
    startLine: {
      type: "integer",
      minimum: 1,
      description: "Optional 1-based start line number.",
    },
    endLine: {
      type: "integer",
      minimum: 1,
      description: "Optional 1-based end line number.",
    },
    maxBytes: {
      type: "integer",
      minimum: 1,
      description: "Optional maximum number of bytes to read.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export const fsListSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Path of the directory to list (defaults to workspace root '.').",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

export const fsGlobSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern to filter files (e.g. '**/*.ts' or '*.json').",
    },
    path: {
      type: "string",
      description:
        "Directory to search from (defaults to workspace root '.').",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      description: "Maximum number of files to return (defaults to 500).",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

export const fsPatchSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path of the file to patch.",
    },
    diff: {
      type: "string",
      description:
        "Unified diff to apply (must contain valid @@ hunks with exact context lines).",
    },
    rationale: {
      type: "string",
      description: "Explanation of why this patch is being made.",
    },
  },
  required: ["path", "diff", "rationale"],
  additionalProperties: false,
} as const;

export const searchGrepSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The regex or literal pattern to search for.",
    },
    path: {
      type: "string",
      description:
        "Directory or file to search in (defaults to workspace root '.').",
    },
    isRegex: {
      type: "boolean",
      description:
        "Whether to treat query as a regular expression (defaults to true).",
    },
    caseSensitive: {
      type: "boolean",
      description:
        "Whether the search should be case sensitive (defaults to false).",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      description:
        "Maximum number of matching lines to return (defaults to 100).",
    },
    filePattern: {
      type: "string",
      description:
        "Glob pattern to limit searched file names (e.g. '*.ts').",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const terminalExecSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The shell command to execute.",
    },
    rationale: {
      type: "string",
      description: "Explanation of why this command is being executed.",
    },
    cwd: {
      type: "string",
      description:
        "Working directory inside workspace (defaults to workspace root '.').",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description: "Timeout in milliseconds (defaults to 120,000ms).",
    },
  },
  required: ["command", "rationale"],
  additionalProperties: false,
} as const;

export const toolSchemas = {
  "fs.read": fsReadSchema,
  "fs.list": fsListSchema,
  "fs.glob": fsGlobSchema,
  "fs.patch": fsPatchSchema,
  "search.grep": searchGrepSchema,
  "terminal.exec": terminalExecSchema,
} as const;
