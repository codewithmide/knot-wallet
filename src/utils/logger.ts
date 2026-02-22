type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

const formatLog = (entry: LogEntry): string => {
  const base = `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`;
  if (entry.data) {
    return `${base} ${JSON.stringify(entry.data)}`;
  }
  return base;
};

const createLogger = () => {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      data,
    };

    const formatted = formatLog(entry);

    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "debug":
        if (process.env.NODE_ENV === "development") {
          console.debug(formatted);
        }
        break;
      default:
        console.log(formatted);
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => log("debug", message, data),
    info: (message: string, data?: Record<string, unknown>) => log("info", message, data),
    warn: (message: string, data?: Record<string, unknown>) => log("warn", message, data),
    error: (message: string, data?: Record<string, unknown>) => log("error", message, data),
  };
};

export const logger = createLogger();
