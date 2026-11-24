/** Reintentos seguidos desde el último turno que terminó bien. */
export type ConsecutiveRetries = number

/**
 * Lo que muestra la banda sobre el prompt mientras el mod espera algo real:
 * un reenvío dentro del turno o el `go` programado.
 */
export type RetryBanner =
  | { kind: 'resending'; attempt: number; maxAttempts: number }
  | { kind: 'waiting'; attempt: number; maxAttempts: number; dueAtMs: number }

declare module 'claude-code' {
  interface PluginState {
    'network-auto-resume-cc-mod': {
      /** Si el mod reanuda solo los turnos que terminan en error. */
      isEnabled: boolean
      consecutiveRetries: ConsecutiveRetries
      /** La banda visible; null sin espera en curso. */
      banner: RetryBanner | null
      /** Cuadro actual del spinner de la banda. */
      spinnerFrame: number
    }
  }
}
