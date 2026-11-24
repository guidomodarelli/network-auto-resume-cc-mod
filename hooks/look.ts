import type { Color } from 'claude-code'

/**
 * Carácter visual del mod, en un solo lugar.
 *
 * El naranja de Claude es la marca (es un mod de Claude Code) y el resto son
 * los colores de estado del tema, así se adapta solo a modo claro, oscuro y
 * daltónico. Un color por papel. Cada estado lleva ícono y palabra: el color
 * solo refuerza, y todo se entiende igual sin él.
 */
export const PALETTE = {
  brand: 'claude',
  label: 'subtle',
  command: 'suggestion',
  healthy: 'success',
  attention: 'warning',
  failure: 'error',
  idle: 'inactive',
} as const satisfies Record<string, Color>

/** Glifos de un ancho, para filas que alinean en columnas. */
export const GLYPHS = {
  enabled: '●',
  disabled: '○',
  retries: '↻',
  pending: '◷',
  noError: '✔',
  error: '⚠',
  meterFull: '●',
  meterEmpty: '○',
} as const

/** Emoji para títulos y avisos, donde no hace falta alinear. */
export const EMOJI = {
  brand: '📡',
  resending: '🔁',
  waiting: '⏳',
  recovered: '✅',
  gaveUp: '🛑',
  skipped: '⛔',
} as const

/** Cuadros del spinner de la banda: un solo carácter que gira. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
/** Cada cuánto avanza el spinner mientras hay una espera real. */
export const SPINNER_INTERVAL_MS = 120

/** Ancho de la columna de etiquetas de la tarjeta, en celdas. */
export const LABEL_COLUMN_WIDTH = 18
export const CARD_BORDER_STYLE = 'round'
