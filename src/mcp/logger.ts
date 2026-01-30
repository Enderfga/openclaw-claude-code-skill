/**
 * MCP Client Logger with ANSI color support
 */

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

export class MCPClientLogger {
  private readonly prefix: string;
  private readonly debugMode: boolean;

  constructor(
    prefix: string = "OpenClaw MCP Client",
    debugMode: boolean = false,
  ) {
    this.prefix = prefix;
    this.debugMode = debugMode;
  }

  info(message: any) {
    this.print(colors.blue, message);
  }

  success(message: any) {
    this.print(colors.green, message);
  }

  error(message: any) {
    this.print(colors.red, message);
  }

  warn(message: any) {
    this.print(colors.yellow, message);
  }

  debug(message: any) {
    if (this.debugMode) {
      this.print(colors.dim, message);
    }
  }

  private formatMessage(message: any): string {
    return typeof message === "object"
      ? JSON.stringify(message, null, 2)
      : message;
  }

  private print(color: string, message: any) {
    const formattedMessage = this.formatMessage(message);
    const logMessage = `${color}${colors.bright}[${this.prefix}]${colors.reset} ${formattedMessage}`;
    console.log(logMessage);
  }
}
