import type { Color, ElementTable } from 'claude-code'

import { CARD_BORDER_STYLE, EMOJI, GLYPHS, LABEL_COLUMN_WIDTH, PALETTE } from './look'
import { STATUS_TITLE } from './status'
import type { StatusSnapshot, ToggleResult } from './status'

type StatusRow = {
  key: string
  glyph: string
  label: string
  value: string
  color: Color
}

/**
 * El medidor de reintentos: ●●○○○ para 2 de 5.
 */
export function retryMeter(used: number, total: number): string {
  const filled = Math.min(Math.max(used, 0), total)

  return GLYPHS.meterFull.repeat(filled) + GLYPHS.meterEmpty.repeat(total - filled)
}

function retriesColor(snapshot: StatusSnapshot): Color {
  if (snapshot.consecutiveRetries === 0) return PALETTE.healthy
  if (snapshot.consecutiveRetries >= snapshot.maxRetries) return PALETTE.failure

  return PALETTE.attention
}

function errorRow(snapshot: StatusSnapshot): StatusRow {
  if (snapshot.lastErrorKind === null) {
    return { key: 'error', glyph: GLYPHS.noError, label: 'Último error', value: 'ninguno', color: PALETTE.healthy }
  }

  return {
    key: 'error',
    glyph: GLYPHS.error,
    label: 'Último error',
    value: `${snapshot.lastErrorKind} · ${snapshot.isLastErrorRetryable ? 'se reintenta' : 'no se reintenta'}`,
    color: snapshot.isLastErrorRetryable ? PALETTE.attention : PALETTE.failure,
  }
}

function statusRows(snapshot: StatusSnapshot): StatusRow[] {
  return [
    {
      key: 'enabled',
      glyph: snapshot.isEnabled ? GLYPHS.enabled : GLYPHS.disabled,
      label: 'Reanudación',
      value: snapshot.isEnabled ? 'activada' : 'desactivada',
      color: snapshot.isEnabled ? PALETTE.healthy : PALETTE.idle,
    },
    {
      key: 'retries',
      glyph: GLYPHS.retries,
      label: '"go" seguidos',
      value: `${retryMeter(snapshot.consecutiveRetries, snapshot.maxRetries)}  ${snapshot.consecutiveRetries}/${snapshot.maxRetries}`,
      color: retriesColor(snapshot),
    },
    {
      key: 'pending',
      glyph: GLYPHS.pending,
      label: '"go" pendiente',
      value: snapshot.pendingRetryInSeconds === null ? 'no' : `sí, en ${snapshot.pendingRetryInSeconds} s`,
      color: snapshot.pendingRetryInSeconds === null ? PALETTE.idle : PALETTE.attention,
    },
    errorRow(snapshot),
  ]
}

/**
 * La tarjeta de `/network-retry status`: caja redondeada con el nombre del
 * mod, una fila por dato y el atajo para prenderlo o apagarlo.
 */
export function StatusCard({ elements, snapshot }: { elements: ElementTable; snapshot: StatusSnapshot }) {
  const { Box, Text } = elements
  const toggleArgument = snapshot.isEnabled ? 'off' : 'on'

  return (
    <Box flexDirection="column" borderStyle={CARD_BORDER_STYLE} borderColor={PALETTE.brand} paddingX={1}>
      <Text color={PALETTE.brand} bold>
        {EMOJI.brand} {STATUS_TITLE}
      </Text>
      {statusRows(snapshot).map(row => (
        <Box key={row.key} flexDirection="row">
          <Box width={LABEL_COLUMN_WIDTH}>
            <Text color={PALETTE.label}>
              {row.glyph} {row.label}
            </Text>
          </Box>
          <Text color={row.color} bold>
            {row.value}
          </Text>
        </Box>
      ))}
      <Text color={PALETTE.label}>
        <Text color={PALETTE.command}>/network-retry {toggleArgument}</Text>
        {snapshot.isEnabled ? ' para apagarlo' : ' para prenderlo'}
      </Text>
    </Box>
  )
}

/**
 * La línea de `/network-retry on` u `off`.
 */
export function ToggleLine({ elements, result }: { elements: ElementTable; result: ToggleResult }) {
  const { Text } = elements

  return (
    <Text color={result.isEnabled ? PALETTE.healthy : PALETTE.idle} bold>
      {result.isEnabled ? GLYPHS.enabled : GLYPHS.disabled} Reanudación automática{' '}
      {result.isEnabled ? 'activada' : 'desactivada'}
    </Text>
  )
}
