import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelApiError,
  PromptComposeSection,
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
 * 2. Al terminar el turno en error (`turn.complete`): manda `go` casi al
 *    instante (1s, luego 2s, 4s… con tope) para que el modelo siga.
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

/** Mensajes `go` seguidos antes de rendirse y avisar. */
const MAX_CONSECUTIVE_RETRIES = 5
/** Espera antes del primer `go`; se duplica en cada intento seguido. */
const BASE_RETRY_DELAY_MS = 1_000
/** Tope de la espera entre mensajes `go`. */
const MAX_RETRY_DELAY_MS = 20_000
const LONG_TOAST_TIMEOUT_MS = 15_000

const RESUME_PROMPT = 'go'

/**
 * Sección del system prompt que explica el `go`: el motor no deja que un
 * plugin le agregue contexto oculto a un prompt que manda él mismo.
 */
const RESUME_INSTRUCTIONS_SECTION = {
  id: 'network-auto-resume-cc-mod:resume',
  scope: 'session',
  text:
    'Si recibís un mensaje "go" del plugin network-auto-resume-cc-mod, tu respuesta anterior ' +
    'se cortó por un error de red o de la API. Seguí donde quedaste sin repetir lo que ya ' +
    'escribiste. Si ibas a ejecutar una herramienta, fijate en el historial si ya corrió antes ' +
    'de repetirla, sobre todo si tiene efectos.',
} as const satisfies PromptComposeSection

/**
 * Tipos de error de Claude Code que fallarían igual en cada intento: el mod no
 * manda `go` por ellos. El resto (`server_error`, `overloaded`, `rate_limit`,
 * `unknown`, un corte de red sin tipo) se reintenta.
 */
const NON_RETRYABLE_ERROR_KINDS: readonly ModelApiError[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'max_output_tokens',
  'cloud_credential_error',
]

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
 * Calcula la espera antes del `go` número `attemptNumber` (desde 1).
 */
export function retryDelayMs(attemptNumber: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attemptNumber - 1), MAX_RETRY_DELAY_MS)
}

/**
 * Si un tipo de error es de los que no vale la pena reintentar.
 */
export function isNonRetryableError(errorKind: ModelApiError | undefined): boolean {
  return errorKind !== undefined && NON_RETRYABLE_ERROR_KINDS.includes(errorKind)
}

/**
 * Una respuesta que no llegó: sin motivo de parada y sin texto ni tool calls.
 */
function isMissingResponse(result: TurnStepResult): boolean {
  return result.stopReason === null && result.answer === '' && result.toolUses.length === 0
}

/** `go` programado; se pierde al recargar el mod, a propósito. */
let pendingRetry: Timer | undefined
/** Cuándo dispara el `go` programado, en el reloj del motor. */
let pendingRetryDueAtMs: number | undefined
/** Avanza el spinner de la banda mientras se ve. */
let spinnerTimer: Timer | undefined
/**
 * Tipo del último error del turno principal, según `classic.StopFailure`;
 * se limpia al empezar cada turno.
 */
let lastErrorKind: ModelApiError | undefined

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
      `${EMOJI.gaveUp} ${PLUGIN_NAME}: ${MAX_CONSECUTIVE_RETRIES} reintentos seguidos fallaron; revisá la red o CLI Proxy API y escribí "go" a mano.`,
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
    if (lastErrorKind !== undefined && isNonRetryableError(lastErrorKind)) {
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
      isLastErrorRetryable: !isNonRetryableError(lastErrorKind),
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

  // Un prompt del usuario, del bridge o de otro plugin reemplaza el `go`
  // pendiente. El `go` del propio mod no pasa por acá: el motor saltea los
  // hooks del plugin que hace la llamada.
  on('prompt.submit', async ($, e, next) => {
    await resetRetries($)

    return next(e)
  })

  // Le explica al modelo qué es un `go` de este mod, para que siga sin
  // repetir texto ni herramientas que ya corrieron.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isEnabledAtom))) return composed

    return { sections: [...composed.sections, RESUME_INSTRUCTIONS_SECTION] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) lastErrorKind = undefined

    return next(e)
  })

  // El tipo de error con que Claude Code cerró el turno principal.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)

    lastErrorKind = e.error
    if (pendingRetry !== undefined && isNonRetryableError(e.error)) {
      await cancelPendingRetry($)
      await announceSkippedRetry($, e.error)
    }

    return next(e)
  })

  // Capa 2: el turno murió en error igual; mandar `go`.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Solo el loop principal: un subagente que falla lo maneja su llamador.
    if (e.agentId !== undefined) return result

    if (e.reason === 'answer') {
      const retriesBeforeAnswer = await read($, consecutiveRetriesAtom)
      await resetRetries($)
      if (retriesBeforeAnswer > 0) $.ui.toast(`${EMOJI.recovered} Respuesta retomada tras ${retriesBeforeAnswer} "go"`)
    } else if (e.reason === 'aborted') {
      await resetRetries($)
    } else if (e.reason === 'error' && (await read($, isEnabledAtom))) {
      await cancelPendingRetry($)
      if (lastErrorKind !== undefined && isNonRetryableError(lastErrorKind)) {
        await announceSkippedRetry($, lastErrorKind)
      } else {
        await scheduleRetry($)
      }
    }

    return result
  })
}
