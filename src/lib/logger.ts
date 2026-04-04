// Structured JSON logger for Cloudflare Workers.
// Outputs newline-delimited JSON — compatible with Cloudflare Logpush.
// Always use logger.child() to attach request context before passing to handlers.

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogContext = Record<string, unknown>

export interface Logger {
  debug(msg: string, ctx?: LogContext): void
  info(msg: string, ctx?: LogContext): void
  warn(msg: string, ctx?: LogContext): void
  error(msg: string, ctx?: LogContext): void
  /** Returns a new logger with additional context fields merged in */
  child(ctx: LogContext): Logger
}

function emit(level: LogLevel, msg: string, context: LogContext): void {
  const entry = JSON.stringify({ level, msg, t: Date.now(), ...context })
  if (level === 'error') console.error(entry)
  else if (level === 'warn') console.warn(entry)
  else console.log(entry)
}

export function createLogger(baseCtx: LogContext = {}): Logger {
  return {
    debug: (msg, ctx) => emit('debug', msg, { ...baseCtx, ...ctx }),
    info:  (msg, ctx) => emit('info',  msg, { ...baseCtx, ...ctx }),
    warn:  (msg, ctx) => emit('warn',  msg, { ...baseCtx, ...ctx }),
    error: (msg, ctx) => emit('error', msg, { ...baseCtx, ...ctx }),
    child: (ctx) => createLogger({ ...baseCtx, ...ctx }),
  }
}
