export interface Logger {
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: "info" | "warn" | "error", message: string, extra?: unknown): void => {
    const suffix = extra === undefined ? "" : ` ${safeJson(extra)}`;
    console[level](`[DuckGraph:${scope}] ${message}${suffix}`);
  };

  return {
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra)
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
