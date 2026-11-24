import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelApiError,
  Register,
  Timer,
  TurnStepResult,
} from 'claude-code'

import type { ConsecutiveRetries, RetryBanner } from '../types'
import { EMOJI, SPINNER_INTERVAL_MS } from './look'
import { RetryBand, secondsUntil } from './retry-band'
import { StatusCard, ToggleLine } from './status-card'
import { formatStatusText, formatToggleText, parseStatusText, parseToggleText } from './status'

/**
 * network-auto-resume-cc-mod: recupera solo las respuestas que fallan por la
 * red o la API (CLI Proxy API cortando a mitad del stream, "Waiting for
 * Network" que se rinde, 5xx/529). Dos capas:
 *
 * 1. Dentro del turno (`turn.step`): si la petición al modelo falla antes de
 *    que llegue cualquier pedazo de respuesta, la reenvía en el acto, sin
 *    mensaje nuevo. Si ya llegó algo, no la reenvía: el texto o la tool call
 *    parcial quedarían duplicados.
 * 2. Al terminar el turno en error (`turn.complete`): casi al instante (1s,
 *    luego 2s, 4s… con tope) manda un mensaje que le pide al modelo seguir
 *    donde quedó sin repetir lo que ya hizo.
 *
 * Solo reintenta errores transitorios: el tipo que Claude Code le da al error
 * (`classic.StopFailure`) descarta los que fallarían igual en cada intento
 * (400 / contexto lleno, 401/403, facturación, modelo inexistente).
 *
 * Mientras espera, una banda sobre el prompt muestra un spinner y la cuenta
 * regresiva; `/network-retry status` dibuja una tarjeta con el estado.
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

/** Reintentos seguidos antes de rendirse y avisar. */
const MAX_CONSECUTIVE_RETRIES = 5
/** Espera antes del primer reintento; se duplica en cada intento seguido. */
const BASE_RETRY_DELAY_MS = 1_000
/** Tope de la espera entre reintentos. */
const MAX_RETRY_DELAY_MS = 20_000
const LONG_TOAST_TIMEOUT_MS = 15_000

/**
 * Lo que el mod manda para retomar: la instrucción entera va en el mensaje,
 * porque el motor no deja sumarle contexto oculto a un prompt del propio
 * plugin y puede bloquear una sección agregada al system prompt.
 */
const RESUME_PROMPT =
  'Tu respuesta anterior se cortó por un error de red o de la API. ' +
  'Seguí donde quedaste sin repetir lo que ya hiciste. ' +
  'Si ibas a correr una herramienta, fijate en el historial si ya corrió antes de repetirla.'

/**
 * Tipos de error de Claude Code que fallarían igual en cada intento (cuenta,
 * credenciales, facturación, modelo inexistente): el mod no reintenta por
 * ellos. El resto (`server_error`, `overloaded`, `rate_limit`, `unknown`, un
 * corte de red sin tipo) se reintenta.
 */
const PERMANENT_ERROR_KINDS: readonly ModelApiError[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'model_not_found',
  'max_output_tokens',
  'cloud_credential_error',
]

/**
 * `invalid_request` se reintenta: un proxy como CLI Proxy API suele devolver
 * como 400 una falla pasajera del proveedor de arriba. Solo no se reintenta
 * cuando el detalle dice que el contexto se llenó, porque eso no se arregla
 * esperando.
 */
const CONTEXT_LIMIT_DETAILS = /prompt is too long|context (window|length)|maximum context|too many tokens/i

/** La forma en que Claude Code muestra un error de la API como respuesta. */
const API_ERROR_ANSWER = /^\s*API Error\b/i

const isEnabledAtom = atom({ plugin: 'network-auto-resume-cc-mod', key: 'isEnabled' } as const, true)
const initialRetries: ConsecutiveRetries = 0
const consecutiveRetriesAtom = atom(
  { plugin: 'network-auto-resume-cc-mod', key: 'consecutiveRetries' } as const,
  initialRetries,
)
const noBanner: RetryBanner | null = null
const bannerAtom = atom({ plugin: 'network-auto-resume-cc-mod', key: 'banner' } as const, noBanner)
const spinnerFrameAtom = atom({ plugin: 'network-auto-resume-cc-mod', key: 'spinnerFrame' } as const, 0)

/**
 * Calcula la espera antes del reintento número `attemptNumber` (desde 1).
 */
export function retryDelayMs(attemptNumber: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attemptNumber - 1), MAX_RETRY_DELAY_MS)
}

/**
 * Si un error es de los que no vale la pena reintentar, por su tipo y, para
 * `invalid_request`, por su detalle.
 */
export function isNonRetryableError(errorKind: ModelApiError | undefined, errorDetails?: string): boolean {
  if (errorKind === undefined) return false
  if (errorKind === 'invalid_request') return CONTEXT_LIMIT_DETAILS.test(errorDetails ?? '')

  return PERMANENT_ERROR_KINDS.includes(errorKind)
}

/**
 * Una respuesta que no llegó: sin motivo de parada y sin texto ni tool calls.
 */
function isMissingResponse(result: TurnStepResult): boolean {
  return result.stopReason === null && result.answer === '' && result.toolUses.length === 0
}

/** Reintento programado; se pierde al recargar el mod, a propósito. */
let pendingRetry: Timer | undefined
/** Cuándo dispara el reintento programado, en el reloj del motor. */
let pendingRetryDueAtMs: number | undefined
/** Avanza el spinner de la banda mientras se ve. */
let spinnerTimer: Timer | undefined
/**
 * Tipo del último error del turno principal, según `classic.StopFailure`;
 * se limpia al empezar cada turno.
 */
let lastErrorKind: ModelApiError | undefined
/** El detalle de ese error, cuando Claude Code lo da. */
let lastErrorDetails: string | undefined
/** Si el turno principal está corriendo: un StopFailure tardío lo necesita. */
let isMainTurnRunning = false

function isLastErrorNonRetryable(): boolean {
  return isNonRetryableError(lastErrorKind, lastErrorDetails)
}

async function showBanner($: EngineInterface, banner: RetryBanner) {
  await update($, bannerAtom, () => banner)
  if (spinnerTimer !== undefined) return
  spinnerTimer = $.clock.every(SPINNER_INTERVAL_MS, () => {
    void update($, spinnerFrameAtom, frame => frame + 1)
  })
}

async function hideBanner($: EngineInterface) {
  if (spinnerTimer !== undefined) {
    spinnerTimer.cancel()
    spinnerTimer = undefined
  }
  await update($, bannerAtom, () => null)
}

async function cancelPendingRetry($: EngineInterface) {
  if (pendingRetry === undefined) return
  pendingRetry.cancel()
  pendingRetry = undefined
  pendingRetryDueAtMs = undefined
  await hideBanner($)
}

async function resetRetries($: EngineInterface) {
  await cancelPendingRetry($)
  await update($, consecutiveRetriesAtom, () => 0)
}

async function announceSkippedRetry($: EngineInterface, errorKind: ModelApiError) {
  await hideBanner($)
  $.ui.toast(`${EMOJI.skipped} ${PLUGIN_NAME}: no reintento un error "${errorKind}", fallaría igual. Revisalo y seguí a mano.`, {
    timeoutMs: LONG_TOAST_TIMEOUT_MS,
  })
}

async function scheduleRetry($: EngineInterface) {
  const previousRetries = await read($, consecutiveRetriesAtom)

  if (previousRetries >= MAX_CONSECUTIVE_RETRIES) {
    await hideBanner($)
    $.ui.toast(
      `${EMOJI.gaveUp} ${PLUGIN_NAME}: ${MAX_CONSECUTIVE_RETRIES} reintentos seguidos fallaron; revisá la red o CLI Proxy API y pedile que siga a mano.`,
      { timeoutMs: LONG_TOAST_TIMEOUT_MS },
    )
    await update($, consecutiveRetriesAtom, () => 0)
    return
  }

  const attemptNumber = previousRetries + 1
  const delayMs = retryDelayMs(attemptNumber)
  await update($, consecutiveRetriesAtom, () => attemptNumber)

  pendingRetryDueAtMs = (await $.clock.now()) + delayMs
  await showBanner($, {
    kind: 'waiting',
    attempt: attemptNumber,
    maxAttempts: MAX_CONSECUTIVE_RETRIES,
    dueAtMs: pendingRetryDueAtMs,
  })

  pendingRetry = $.clock.after(delayMs, () => {
    pendingRetry = undefined
    pendingRetryDueAtMs = undefined
    void hideBanner($)
    // StopFailure puede llegar después de turn.complete: se mira otra vez acá.
    if (lastErrorKind !== undefined && isLastErrorNonRetryable()) {
      void announceSkippedRetry($, lastErrorKind)
      return
    }
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

      return { text: formatToggleText({ isEnabled }), isTextDisplayOnly: true }
    }

    const nowMs = await $.clock.now()
    const text = formatStatusText({
      isEnabled: await read($, isEnabledAtom),
      consecutiveRetries: await read($, consecutiveRetriesAtom),
      maxRetries: MAX_CONSECUTIVE_RETRIES,
      pendingRetryInSeconds:
        pendingRetryDueAtMs === undefined ? null : secondsUntil(pendingRetryDueAtMs, nowMs),
      lastErrorKind: lastErrorKind ?? null,
      isLastErrorRetryable: !isLastErrorNonRetryable(),
    })

    return { text, isTextDisplayOnly: true }
  })

  // La fila del comando: tarjeta para `status`, línea de color para `on`/`off`.
  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND_NAME } }, ($, e, next) => {
    const elements = $.ui.resolve(e)
    const snapshot = parseStatusText(e.props.text)
    if (snapshot !== undefined) return <StatusCard elements={elements} snapshot={snapshot} />

    const toggle = parseToggleText(e.props.text)
    if (toggle !== undefined) return <ToggleLine elements={elements} result={toggle} />

    return next(e)
  })

  // La banda sobre el prompt mientras hay una espera real.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const banner = await read($, bannerAtom)
    if (banner === null || e.props.hasSurvey) return next(e)

    return (
      <RetryBand
        elements={$.ui.resolve(e)}
        banner={banner}
        spinnerFrame={await read($, spinnerFrameAtom)}
        nowMs={await $.clock.now()}
      />
    )
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
          if (!hasYieldedChunk && resendNumber > 0) await hideBanner($)
          hasYieldedChunk = true
          yield step.value
          step = await stream.next()
        }
        result = step.value
      } catch (streamError) {
        if (hasYieldedChunk || isLastAttempt || next.signal.aborted) {
          await hideBanner($)
          throw streamError
        }
        await showBanner($, { kind: 'resending', attempt: resendNumber + 1, maxAttempts: MAX_IN_TURN_RESENDS })
        await $.clock.sleep(IN_TURN_RESEND_DELAY_MS, { signal: next.signal })
        continue
      }

      const canResend =
        !hasYieldedChunk && !isLastAttempt && !next.signal.aborted && isMissingResponse(result)
      if (!canResend) {
        if (resendNumber > 0) await hideBanner($)
        return result
      }

      await showBanner($, { kind: 'resending', attempt: resendNumber + 1, maxAttempts: MAX_IN_TURN_RESENDS })
      await $.clock.sleep(IN_TURN_RESEND_DELAY_MS, { signal: next.signal })
    }
  })

  // Un prompt del usuario, del bridge o de otro plugin reemplaza el
  // reintento pendiente. El mensaje del propio mod no pasa por acá: el motor saltea los
  // hooks del plugin que hace la llamada.
  on('prompt.submit', async ($, e, next) => {
    await resetRetries($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      lastErrorKind = undefined
      lastErrorDetails = undefined
      isMainTurnRunning = true
    }

    return next(e)
  })

  // El tipo de error con que Claude Code cerró el turno principal.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)

    lastErrorKind = e.error
    lastErrorDetails = e.error_details
    if (isLastErrorNonRetryable()) {
      if (pendingRetry !== undefined) {
        await cancelPendingRetry($)
        await announceSkippedRetry($, e.error)
      }
    } else if (!isMainTurnRunning && pendingRetry === undefined && (await read($, isEnabledAtom))) {
      // Llegó después de que el turno terminó como si nada: reintentar igual.
      await scheduleRetry($)
    }

    return next(e)
  })

  // Capa 2: el turno murió en error igual; pedirle al modelo que siga.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Solo el loop principal: un subagente que falla lo maneja su llamador.
    if (e.agentId !== undefined) return result
    isMainTurnRunning = false

    // Claude Code puede cerrar como respuesta un turno que murió por un error
    // de la API: cuenta como error si hubo StopFailure o si la respuesta es
    // el "API Error: …" que muestra.
    const isApiError =
      e.reason === 'error' || lastErrorKind !== undefined || API_ERROR_ANSWER.test(e.answer)

    if (e.reason === 'aborted') {
      await resetRetries($)
    } else if (isApiError) {
      if (!(await read($, isEnabledAtom))) return result
      await cancelPendingRetry($)
      if (lastErrorKind !== undefined && isLastErrorNonRetryable()) {
        await announceSkippedRetry($, lastErrorKind)
      } else {
        await scheduleRetry($)
      }
    } else {
      const retriesBeforeAnswer = await read($, consecutiveRetriesAtom)
      await resetRetries($)
      if (retriesBeforeAnswer > 0) {
        $.ui.toast(
          `${EMOJI.recovered} Respuesta retomada tras ${retriesBeforeAnswer} ${retriesBeforeAnswer === 1 ? 'reintento' : 'reintentos'}`,
        )
      }
    }

    return result
  })
}
