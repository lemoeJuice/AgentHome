import { nowIso } from "./ids.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly component: string;
  private readonly minimum: LogLevel;

  constructor(component: string, minimum: LogLevel = "info") {
    this.component = component;
    this.minimum = minimum;
  }

  child(component: string): Logger {
    return new Logger(`${this.component}.${component}`, this.minimum);
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.write("debug", message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.write("info", message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.write("warn", message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.write("error", message, fields); }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (weights[level] < weights[this.minimum]) return;
    const entry = { timestamp: nowIso(), level, component: this.component, message, ...fields };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

export function rootLogger(level = (process.env.AGENT_HOME_LOG_LEVEL as LogLevel | undefined) ?? "info"): Logger {
  return new Logger("agent-home", level);
}
