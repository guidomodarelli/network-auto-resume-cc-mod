import type { ElementTable } from 'claude-code'

import type { RetryBanner } from '../types'
import { EMOJI, PALETTE, SPINNER_FRAMES } from './look'

const MS_PER_SECOND = 1000

/**
 * Segundos que faltan, redondeados hacia arriba y nunca negativos.
 */
export function secondsUntil(dueAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((dueAtMs - nowMs) / MS_PER_SECOND))
}

/**
 * La banda sobre el prompt mientras el mod espera algo real: el spinner gira,
 * la cuenta baja y el atajo para frenarlo queda a mano.
 */
export function RetryBand({
  elements,
  banner,
  spinnerFrame,
  nowMs,
}: {
  elements: ElementTable
  banner: RetryBanner
  spinnerFrame: number
  nowMs: number
}) {
  const { Box, Text } = elements
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
  const progress = `${banner.attempt}/${banner.maxAttempts}`
  const message =
    banner.kind === 'resending'
      ? `${EMOJI.resending} Petición fallida: reenviando ${progress}`
      : `${EMOJI.waiting} Respuesta cortada: "go" ${progress} en ${secondsUntil(banner.dueAtMs, nowMs)} s`

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={PALETTE.attention} bold>
        {spinner}
      </Text>
      <Text color={PALETTE.attention}>{message}</Text>
      {banner.kind === 'waiting' ? (
        <Text color={PALETTE.label}>
          · <Text color={PALETTE.command}>/network-retry off</Text> para frenarlo
        </Text>
      ) : null}
    </Box>
  )
}
