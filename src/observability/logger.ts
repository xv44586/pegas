export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

export interface StructuredLogRecord {
  ts: string
  level: LogLevel
  service: string
  event: string
  message?: string
  error?: { name: string; message: string; stack?: string }
  fields?: LogFields
}

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, error?: unknown, fields?: LogFields): void
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  service: string
  level?: LogLevel
  fields?: LogFields
  sink?: (record: StructuredLogRecord) => void
  now?: () => Date
}

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export function parseLogLevel(value: string | undefined): LogLevel {
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  )
    return value
  return 'info'
}

/**
 * Emits one JSON object per line. User-authored text (message bodies, prompt
 * content, credentials) must never be passed as fields; callers log durable
 * identifiers and outcomes only.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? parseLogLevel(process.env.PEGAS_LOG_LEVEL)
  const sink =
    options.sink ??
    (record => {
      process.stdout.write(`${JSON.stringify(record)}\n`)
    })
  const baseFields = options.fields ?? {}
  const now = options.now ?? (() => new Date())

  function emit(
    recordLevel: LogLevel,
    event: string,
    fields?: LogFields,
    error?: unknown,
  ): void {
    if (levelOrder[recordLevel] < levelOrder[level]) return
    const { message, ...rest } = { ...baseFields, ...fields }
    const record: StructuredLogRecord = {
      ts: now().toISOString(),
      level: recordLevel,
      service: options.service,
      event,
      ...(typeof message === 'string' ? { message } : {}),
      ...(Object.keys(rest).length > 0 ? { fields: rest } : {}),
      ...(error !== undefined ? { error: serializeError(error) } : {}),
    }
    sink(record)
  }

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, error, fields) => emit('error', event, fields, error),
    child: fields =>
      createLogger({
        ...options,
        level,
        sink,
        now,
        fields: { ...baseFields, ...fields },
      }),
  }
}

function serializeError(error: unknown): {
  name: string
  message: string
  stack?: string
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return { name: 'UnknownError', message: String(error) }
}
