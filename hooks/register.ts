import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnStepResult } from 'claude-code'

import type { ConsecutiveRetries } from '../types'

/**
 * network-auto-resume-cc-mod: recupera solo las respuestas que fallan por la red o la
 * API (CLI Proxy API cortando a mitad del stream, "Waiting for Network" que se
 * rinde, 5xx/529). Dos capas:
 *
 * 1. Dentro del turno (`turn.step`): si la petición al modelo falla antes de
 *    que llegue cualquier pedazo de respuesta, la reenvía en el acto, sin
 *    mensaje nuevo. Si ya llegó algo, no la reenvía: el texto o la tool call
 *    parcial quedarían duplicados.
 * 2. Al terminar el turno en error (`turn.complete`): manda `go` casi al
 *    instante (1s, luego 2s, 4s… con tope) para que el modelo siga.
 *
 * Un turno que termina bien reinicia el contador; Esc o un prompt del usuario
 * cancelan el reintento pendiente. `/network-retry off` lo apaga.
 */

const PLUGIN_NAME = 'network-auto-resume-cc-mod'
const COMMAND_NAME = 'network-retry'

/** Reenvíos de una misma petición dentro del turno antes de dejarla fallar. */
const MAX_IN_TURN_RESENDS = 2
/** Pausa antes de cada reenvío dentro del turno (cuenta en el presupuesto del hook). */
const IN_TURN_RESEND_DELAY_MS = 750

/** Mensajes `go` seguidos antes de rendirse y avisar. */
const MAX_CONSECUTIVE_RETRIES = 5
/** Espera antes del primer `go`; se duplica en cada intento seguido. */
const BASE_RETRY_DELAY_MS = 1_000
/** Tope de la espera entre mensajes `go`. */
const MAX_RETRY_DELAY_MS = 20_000
const GIVE_UP_TOAST_TIMEOUT_MS = 15_000
const MS_PER_SECOND = 1000

const RESUME_PROMPT = 'go'

const isEnabledAtom = atom({ plugin: 'network-auto-resume-cc-mod', key: 'isEnabled' } as const, true)
const initialRetries: ConsecutiveRetries = 0
const consecutiveRetriesAtom = atom(
  { plugin: 'network-auto-resume-cc-mod', key: 'consecutiveRetries' } as const,
  initialRetries,
)

/**
 * Calcula la espera antes del `go` número `attemptNumber` (desde 1).
 */
export function retryDelayMs(attemptNumber: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attemptNumber - 1), MAX_RETRY_DELAY_MS)
}

/**
 * Una respuesta que no llegó: sin motivo de parada y sin texto ni tool calls.
 */
function isMissingResponse(result: TurnStepResult): boolean {
  return result.stopReason === null && result.answer === '' && result.toolUses.length === 0
}

/** `go` programado; se pierde al recargar el mod, a propósito. */
let pendingRetry: Timer | undefined

function cancelPendingRetry($: EngineInterface) {
  if (pendingRetry === undefined) return
  pendingRetry.cancel()
  pendingRetry = undefined
  $.ui.status(undefined)
}

async function resetRetries($: EngineInterface) {
  cancelPendingRetry($)
  await update($, consecutiveRetriesAtom, () => 0)
}

async function scheduleRetry($: EngineInterface) {
  const previousRetries = await read($, consecutiveRetriesAtom)

  if (previousRetries >= MAX_CONSECUTIVE_RETRIES) {
    $.ui.status(undefined)
    $.ui.toast(
      `${PLUGIN_NAME}: ${MAX_CONSECUTIVE_RETRIES} reintentos seguidos fallaron; revisá la red o CLI Proxy API y escribí "go" a mano.`,
      { timeoutMs: GIVE_UP_TOAST_TIMEOUT_MS },
    )
    await update($, consecutiveRetriesAtom, () => 0)
    return
  }

  const attemptNumber = previousRetries + 1
  const delayMs = retryDelayMs(attemptNumber)
  await update($, consecutiveRetriesAtom, () => attemptNumber)

  $.ui.status(
    `⟳ Respuesta cortada: "go" ${attemptNumber}/${MAX_CONSECUTIVE_RETRIES} en ${Math.round(delayMs / MS_PER_SECOND)}s (/${COMMAND_NAME} off para frenar)`,
  )

  pendingRetry = $.clock.after(delayMs, () => {
    pendingRetry = undefined
    $.ui.status(undefined)
    void $.prompt.submit({ text: RESUME_PROMPT })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND_NAME,
      description: 'Reanudar solo tras errores de red/API: on, off o status',
      argumentHint: 'on | off | status',
    })

    return next(e)
  })

  on('command.run', { command: COMMAND_NAME }, async ($, e) => {
    const argument = e.args.trim().toLowerCase()

    if (argument === 'on' || argument === 'off') {
      const isEnabled = argument === 'on'
      await update($, isEnabledAtom, () => isEnabled)
      if (!isEnabled) await resetRetries($)

      return { text: `Reanudación automática ${isEnabled ? 'activada' : 'desactivada'}.` }
    }

    const isEnabled = await read($, isEnabledAtom)
    const retries = await read($, consecutiveRetriesAtom)

    return {
      text:
        `Reanudación automática: ${isEnabled ? 'activada' : 'desactivada'}. ` +
        `"go" seguidos: ${retries}/${MAX_CONSECUTIVE_RETRIES}. ` +
        `"go" pendiente: ${pendingRetry === undefined ? 'no' : 'sí'}.`,
    }
  })

  // Capa 1: reenviar la petición dentro del mismo turno si falló sin mandar nada.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await read($, isEnabledAtom))) {
      return yield* next(e)
    }

    for (let resendNumber = 0; ; resendNumber += 1) {
      const isLastAttempt = resendNumber >= MAX_IN_TURN_RESENDS
      let hasYieldedChunk = false
      let result: TurnStepResult

      try {
        const stream = next(e)
        let step = await stream.next()
        while (step.done !== true) {
          hasYieldedChunk = true
          yield step.value
          step = await stream.next()
        }
        result = step.value
      } catch (streamError) {
        if (hasYieldedChunk || isLastAttempt || next.signal.aborted) throw streamError
        await $.clock.sleep(IN_TURN_RESEND_DELAY_MS, { signal: next.signal })
        continue
      }

      const canResend =
        !hasYieldedChunk && !isLastAttempt && !next.signal.aborted && isMissingResponse(result)
      if (!canResend) return result

      $.ui.status(`⟳ Petición fallida: reenviando (${resendNumber + 1}/${MAX_IN_TURN_RESENDS})…`)
      await $.clock.sleep(IN_TURN_RESEND_DELAY_MS, { signal: next.signal })
      $.ui.status(undefined)
    }
  })

  // Un prompt que no manda este mod (el usuario, el bridge, otro plugin)
  // reemplaza el `go` pendiente.
  on('prompt.submit', async ($, e, next) => {
    const isOwnPrompt = e.origin.kind === 'plugin' && e.origin.name === PLUGIN_NAME
    if (!isOwnPrompt) await resetRetries($)

    return next(e)
  })

  // Capa 2: el turno murió en error igual; mandar `go`.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Solo el loop principal: un subagente que falla lo maneja su llamador.
    if (e.agentId !== undefined) return result

    if (e.reason === 'answer' || e.reason === 'aborted') {
      await resetRetries($)
    } else if (e.reason === 'error' && (await read($, isEnabledAtom))) {
      cancelPendingRetry($)
      await scheduleRetry($)
    }

    return result
  })
}
