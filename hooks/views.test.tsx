import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatStatusText, formatToggleText, parseStatusText, parseToggleText } from './status'
import type { StatusSnapshot } from './status'

const PLUGIN = 'network-auto-resume-cc-mod'
const SURFACES = ['terminal', 'desktop'] as const

const SNAPSHOT: StatusSnapshot = {
  isEnabled: true,
  consecutiveRetries: 2,
  maxRetries: 5,
  pendingRetryInSeconds: 4,
  lastErrorKind: 'overloaded',
  isLastErrorRetryable: true,
}

const ERRORED_TURN = {
  answer: '',
  durationMs: 1200,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'error',
} as const

function commandOutput(surface: (typeof SURFACES)[number], text: string) {
  return {
    plugin: PLUGIN,
    surface,
    component: 'CommandOutput',
    props: { command: 'network-retry', args: 'status', text, isErrored: false },
  } as const
}

function abovePrompt(surface: (typeof SURFACES)[number]) {
  return {
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as const
}

/** El motor por debajo: reloj en memoria y toasts, prompts y turnos que responden. */
function setUpEngine(on: On) {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return { clock, toasts }
}

test('el texto del estado se lee de vuelta igual, con y sin error', () => {
  expect(parseStatusText(formatStatusText(SNAPSHOT))).toEqual(SNAPSHOT)

  const calm: StatusSnapshot = {
    ...SNAPSHOT,
    consecutiveRetries: 0,
    pendingRetryInSeconds: null,
    lastErrorKind: null,
  }
  expect(parseStatusText(formatStatusText(calm))).toEqual(calm)
  expect(parseToggleText(formatToggleText({ isEnabled: false }))).toEqual({ isEnabled: false })
  expect(parseStatusText('otra cosa')).toBeUndefined()
})

test('status se dibuja como tarjeta con borde, íconos y medidor', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(commandOutput(surface, formatStatusText(SNAPSHOT)))

    expect((await ui.find({ type: 'Text', text: /network-auto-resume-cc-mod/ }))?.text).toMatch(/📡/)
    expect((await ui.find({ type: 'Text', text: /●●○○○/ }))?.text).toMatch(/2\/5/)
    expect((await ui.find({ type: 'Text', text: /sí, en 4 s/ }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: /overloaded · se reintenta/ }))?.props.color).toBe('warning')
    const card = await ui.find({ type: 'Box' })
    expect(card?.props.borderStyle).toBe('round')
    await ui.unmount()
  }
})

test('un error que no se reintenta y el mod apagado cambian de color', async $ => {
  const snapshot = {
    ...SNAPSHOT,
    isEnabled: false,
    lastErrorKind: 'invalid_request',
    isLastErrorRetryable: false,
  }
  const ui = await $.ui.mount(commandOutput('terminal', formatStatusText(snapshot)))

  expect((await ui.find({ type: 'Text', text: /no se reintenta/ }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: /^desactivada$/ }))?.props.color).toBe('inactive')
  expect(await ui.find({ type: 'Text', text: /network-retry on/ })).toBeDefined()
  await ui.unmount()
})

test('on y off se dibujan como una línea de color', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(commandOutput(surface, formatToggleText({ isEnabled: true })))
    const line = await ui.find({ type: 'Text', text: /Reanudación automática/ })

    expect(line?.text).toMatch(/● Reanudación automática activada/)
    expect(line?.props.color).toBe('success')
    await ui.unmount()
  }
})

test('mientras espera el reintento, la banda gira y cuenta hacia atrás', async ($, on) => {
  const { clock } = setUpEngine(on)

  const quiet = await $.ui.mount(abovePrompt('terminal'))
  expect(await quiet.find({ type: 'Text', text: /Respuesta cortada/ })).toBeUndefined()
  await quiet.unmount()

  await $.turn.complete(ERRORED_TURN)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(abovePrompt(surface))
    expect((await ui.find({ type: 'Text', text: /Respuesta cortada/ }))?.text).toMatch(/⏳ .*reintento 1\/5 en 1 s/)
    await ui.unmount()
  }

  const before = await $.ui.mount(abovePrompt('terminal'))
  const frameBefore = await before.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })
  await before.unmount()
  await clock.advance(250)
  const ui = await $.ui.mount(abovePrompt('terminal'))
  const frameAfter = await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })
  expect(frameAfter?.text).not.toBe(frameBefore?.text)
  await ui.unmount()

  // Al disparar el reintento, la banda desaparece.
  await clock.advance(1_000)
  const after = await $.ui.mount(abovePrompt('terminal'))
  expect(await after.find({ type: 'Text', text: /Respuesta cortada/ })).toBeUndefined()
  await after.unmount()
})

test('una respuesta que llega después de un reintento avisa que se retomó', async ($, on) => {
  const { clock, toasts } = setUpEngine(on)

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(1_000)
  await $.turn.complete({ ...ERRORED_TURN, reason: 'answer', answer: 'listo' })

  expect(toasts).toEqual(['✅ Respuesta retomada tras 1 reintento'])
})
