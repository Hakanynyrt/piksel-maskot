import { expect, test } from 'claude-code/testing'

import { mascotSvg } from './register'

const BACKDROP = {
  plugin: 'piksel-maskot',
  component: 'Backdrop',
  requestId: 'backdrop',
  props: { id: 'maskot', plugin: 'piksel-maskot', glass: { blur: 0, opacity: 0 } },
} as const

test('the mascot draws in the desktop backdrop', async $ => {
  const ui = await $.ui.mount({ ...BACKDROP, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeTruthy()
  await ui.unmount()
})

test('another plugin backdrop goes to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({
    ...BACKDROP,
    surface: 'desktop',
    props: { ...BACKDROP.props, plugin: 'other' },
  })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('both drawings fit the size an Svg may have and hold valid numbers', () => {
  for (const isWorking of [false, true]) {
    const source = mascotSvg(isWorking)

    expect(source.length).toBeLessThan(131072)
    expect(source.includes('NaN')).toBe(false)
  }
})
