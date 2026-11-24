/** Reintentos seguidos desde el último turno que terminó bien. */
export type ConsecutiveRetries = number

declare module 'claude-code' {
  interface PluginState {
    'network-auto-resume-cc-mod': {
      /** Si el mod reanuda solo los turnos que terminan en error. */
      isEnabled: boolean
      consecutiveRetries: ConsecutiveRetries
    }
  }
}
