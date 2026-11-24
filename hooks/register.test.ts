import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnStepResult } from 'claude-code'

const ERRORED_TURN = {
  answer: '',
  durationMs: 1200,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'error',
} as const

const ANSWERED_TURN = { ...ERRORED_TURN, reason: 'answer', answer: 'listo' } as const

const STEP = { turnId: 'turn-1', index: 0, model: 'opus', messageCount: 3 } as const

const MISSING_RESPONSE: TurnStepResult = {
  turnId: 'turn-1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: null,
  usage: null,
}

const ANSWERED_RESPONSE: TurnStepResult = {
  ...MISSING_RESPONSE,
  answer: 'hola',
  stopReason: 'end_turn',
}

const FIRST_GO_DELAY_MS = 1_000
const IN_TURN_RESEND_DELAY_MS = 750

/**
 * Lo que el motor responde por debajo del mod en cada test: reloj en memoria,
 * estado y toasts mudos, y los prompts que llegan al fondo.
 */
function setUpEngine(on: On) {
  const clock = mock.clock(on)
  const submittedTexts: string[] = []
  const toasts: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    // El mensaje del mod se anota como `resume`, así los tests no dependen de
    // su redacción, solo de que pida seguir sin repetir.
    submittedTexts.push(/Seguí donde quedaste sin repetir lo que ya hiciste/.test(e.text) ? 'resume' : e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))

  return { clock, submittedTexts, toasts }
}

test('un turno que termina en error pide seguir al segundo', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(FIRST_GO_DELAY_MS - 1)
  expect(submittedTexts).toEqual([])

  await clock.advance(1)
  expect(submittedTexts).toEqual(['resume'])
})

test('el backoff se duplica y se rinde tras el tope de reintentos', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)

  for (const delayMs of [1_000, 2_000, 4_000, 8_000, 16_000]) {
    await $.turn.complete(ERRORED_TURN)
    await clock.advance(delayMs)
  }
  expect(submittedTexts.length).toBe(5)

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(60_000)
  expect(submittedTexts.length).toBe(5)
})

test('un turno que termina bien reinicia el contador', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(FIRST_GO_DELAY_MS)
  await $.turn.complete(ANSWERED_TURN)

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(FIRST_GO_DELAY_MS)
  expect(submittedTexts).toEqual(['resume', 'resume'])
})

test('un prompt del usuario o Esc cancelan el reintento pendiente', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)

  await $.turn.complete(ERRORED_TURN)
  await $.prompt.submit({ text: 'mejor hacé otra cosa', origin: { kind: 'composer' }, wait: false })
  await clock.advance(FIRST_GO_DELAY_MS * 4)
  expect(submittedTexts).toEqual(['mejor hacé otra cosa'])

  await $.turn.complete(ERRORED_TURN)
  await $.turn.complete({ ...ERRORED_TURN, reason: 'aborted', isAborted: true })
  await clock.advance(FIRST_GO_DELAY_MS * 4)
  expect(submittedTexts).toEqual(['mejor hacé otra cosa'])
})

test('no reintenta errores de subagentes ni con el mod apagado', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)
  on('command.run', () => ({ text: '' }))

  await $.turn.complete({ ...ERRORED_TURN, agentId: 'agent-1' })
  await clock.advance(FIRST_GO_DELAY_MS)
  expect(submittedTexts).toEqual([])

  const turnedOff = await $.command.run({
    command: 'network-retry',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(turnedOff.text).toMatch(/desactivada/)
  await $.turn.complete(ERRORED_TURN)
  await clock.advance(FIRST_GO_DELAY_MS)
  expect(submittedTexts).toEqual([])
})

test('una petición que falla sin mandar nada se reenvía dentro del turno', async ($, on) => {
  const { clock } = setUpEngine(on)
  let requestsSent = 0
  on('turn.step', async function* () {
    requestsSent += 1
    if (requestsSent === 1) return MISSING_RESPONSE
    yield { kind: 'text', index: 0, text: 'hola' }
    return ANSWERED_RESPONSE
  })

  const stream = $.turn.step(STEP)
  const reading = (async () => {
    const texts: string[] = []
    let step = await stream.next()
    while (step.done !== true) {
      if (step.value.kind === 'text') texts.push(step.value.text)
      step = await stream.next()
    }
    return { texts, result: step.value }
  })()
  await clock.advance(IN_TURN_RESEND_DELAY_MS)

  const { texts, result } = await reading
  expect(texts).toEqual(['hola'])
  expect(result.answer).toBe('hola')
  expect(requestsSent).toBe(2)
})

test('una petición que se corta tras mandar texto no se reenvía', async ($, on) => {
  const { clock } = setUpEngine(on)
  let requestsSent = 0
  on('turn.step', async function* () {
    requestsSent += 1
    // El proxy corta el stream: llegó texto pero ninguna parada.
    yield { kind: 'text', index: 0, text: 'medio ' }
    return { ...MISSING_RESPONSE, answer: 'medio ' }
  })

  const stream = $.turn.step(STEP)
  const reading = (async () => {
    let step = await stream.next()
    while (step.done !== true) step = await stream.next()
    return step.value
  })()
  await clock.advance(IN_TURN_RESEND_DELAY_MS * 4)

  expect((await reading).answer).toBe('medio ')
  expect(requestsSent).toBe(1)
})

test('los reenvíos dentro del turno tienen tope', async ($, on) => {
  const { clock } = setUpEngine(on)
  let requestsSent = 0
  on('turn.step', async function* () {
    requestsSent += 1
    return MISSING_RESPONSE
  })

  const stream = $.turn.step(STEP)
  const reading = (async () => {
    let step = await stream.next()
    while (step.done !== true) step = await stream.next()
    return step.value
  })()
  await clock.advance(IN_TURN_RESEND_DELAY_MS * 4)

  expect((await reading).stopReason).toBeNull()
  expect(requestsSent).toBe(3)
})

test('un error que fallaría igual no se reintenta', async ($, on) => {
  const { clock, submittedTexts, toasts } = setUpEngine(on)

  for (const errorKind of ['invalid_request', 'authentication_failed', 'billing_error'] as const) {
    await $.turn.start({ text: 'hacé algo', turnId: `turn-${errorKind}` })
    await $.classic.StopFailure({ error: errorKind })
    await $.turn.complete(ERRORED_TURN)
    await clock.advance(FIRST_GO_DELAY_MS * 4)
  }

  expect(submittedTexts).toEqual([])
  expect(toasts.length).toBe(3)
  expect(toasts[0]).toMatch(/invalid_request/)
})

test('un StopFailure no reintentable que llega tarde cancela el reintento pendiente', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)

  await $.turn.start({ text: 'hacé algo', turnId: 'turn-1' })
  await $.turn.complete(ERRORED_TURN)
  await $.classic.StopFailure({ error: 'invalid_request' })
  await clock.advance(FIRST_GO_DELAY_MS * 4)

  expect(submittedTexts).toEqual([])
})

test('un error transitorio sí se reintenta y el turno siguiente limpia el tipo', async ($, on) => {
  const { clock, submittedTexts } = setUpEngine(on)

  await $.turn.start({ text: 'hacé algo', turnId: 'turn-1' })
  await $.classic.StopFailure({ error: 'overloaded' })
  await $.turn.complete(ERRORED_TURN)
  await clock.advance(FIRST_GO_DELAY_MS)
  expect(submittedTexts).toEqual(['resume'])

  // Un turno con invalid_request y después otro que se corta sin tipo: el
  // segundo se reintenta porque turn.start limpió el tipo anterior.
  await $.turn.start({ text: 'otra cosa', turnId: 'turn-2' })
  await $.classic.StopFailure({ error: 'invalid_request' })
  await $.turn.complete({ ...ERRORED_TURN, turnId: 'turn-2' })
  await $.turn.start({ text: 'go', turnId: 'turn-3' })
  await $.turn.complete({ ...ERRORED_TURN, turnId: 'turn-3' })
  await clock.advance(FIRST_GO_DELAY_MS * 2)
  expect(submittedTexts).toEqual(['resume', 'resume'])
})
