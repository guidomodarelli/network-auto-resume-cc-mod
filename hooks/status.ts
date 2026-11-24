/**
 * El estado de `/network-retry` como texto y de vuelta.
 *
 * El texto es lo que queda guardado en el transcript y lo que muestra una
 * superficie que no dibuja la tarjeta; la tarjeta de `status-card.tsx` lo
 * vuelve a leer con `parseStatusText`, así cada fila muestra el estado del
 * momento en que se corrió el comando y no el actual.
 */

/** Lo que muestra `/network-retry status`. */
export type StatusSnapshot = {
  isEnabled: boolean
  consecutiveRetries: number
  maxRetries: number
  /** Segundos hasta el reintento programado; null sin reintento pendiente. */
  pendingRetryInSeconds: number | null
  /** Tipo del último error del turno principal; null si no hubo. */
  lastErrorKind: string | null
  /** Si ese error se reintenta; sin error, true. */
  isLastErrorRetryable: boolean
}

/** Lo que responde `/network-retry on` o `off`. */
export type ToggleResult = { isEnabled: boolean }

export const STATUS_TITLE = 'network-auto-resume-cc-mod'

const ENABLED_WORD = 'activada'
const DISABLED_WORD = 'desactivada'
const NO_ERROR_WORD = 'ninguno'
const NO_PENDING_WORD = 'no'
const RETRYABLE_NOTE = 'se reintenta'
const NON_RETRYABLE_NOTE = 'no se reintenta'

const ENABLED_LINE = /^- Reanudación automática: (activada|desactivada)$/m
const RETRIES_LINE = /^- Reintentos seguidos: (\d+)\/(\d+)$/m
const PENDING_LINE = /^- Reintento pendiente: (?:no|en (\d+) s)$/m
const ERROR_LINE = /^- Último error: (?:ninguno|([a-z_]+) \((se reintenta|no se reintenta)\))$/m
const TOGGLE_LINE = /^Reanudación automática (activada|desactivada)\.$/

/**
 * Escribe el estado como markdown: una lista de pares etiqueta: valor.
 */
export function formatStatusText(snapshot: StatusSnapshot): string {
  const pendingText =
    snapshot.pendingRetryInSeconds === null
      ? NO_PENDING_WORD
      : `en ${snapshot.pendingRetryInSeconds} s`
  const errorText =
    snapshot.lastErrorKind === null
      ? NO_ERROR_WORD
      : `${snapshot.lastErrorKind} (${snapshot.isLastErrorRetryable ? RETRYABLE_NOTE : NON_RETRYABLE_NOTE})`

  return [
    `**${STATUS_TITLE}**`,
    `- Reanudación automática: ${snapshot.isEnabled ? ENABLED_WORD : DISABLED_WORD}`,
    `- Reintentos seguidos: ${snapshot.consecutiveRetries}/${snapshot.maxRetries}`,
    `- Reintento pendiente: ${pendingText}`,
    `- Último error: ${errorText}`,
  ].join('\n')
}

/**
 * Lee un texto de `formatStatusText`; undefined si no tiene esa forma.
 */
export function parseStatusText(text: string): StatusSnapshot | undefined {
  const enabledMatch = ENABLED_LINE.exec(text)
  const retriesMatch = RETRIES_LINE.exec(text)
  const pendingMatch = PENDING_LINE.exec(text)
  const errorMatch = ERROR_LINE.exec(text)
  if (!enabledMatch || !retriesMatch || !pendingMatch || !errorMatch) return undefined

  return {
    isEnabled: enabledMatch[1] === ENABLED_WORD,
    consecutiveRetries: Number(retriesMatch[1]),
    maxRetries: Number(retriesMatch[2]),
    pendingRetryInSeconds: pendingMatch[1] === undefined ? null : Number(pendingMatch[1]),
    lastErrorKind: errorMatch[1] ?? null,
    isLastErrorRetryable: errorMatch[2] !== NON_RETRYABLE_NOTE,
  }
}

/**
 * Escribe la respuesta de `on` u `off`.
 */
export function formatToggleText(result: ToggleResult): string {
  return `Reanudación automática ${result.isEnabled ? ENABLED_WORD : DISABLED_WORD}.`
}

/**
 * Lee un texto de `formatToggleText`; undefined si no tiene esa forma.
 */
export function parseToggleText(text: string): ToggleResult | undefined {
  const match = TOGGLE_LINE.exec(text.trim())
  if (!match) return undefined

  return { isEnabled: match[1] === ENABLED_WORD }
}
