import type { Register } from 'claude-code'

const HEARTBEAT_MS = 30000

// Starts the transparent robot window and tells it whether this session is working.
export const register: Register = on => {
  const id = crypto.randomUUID()
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const script = `${$.plugin.root}/overlay/maskot.pyw`

    if (/^[A-Za-z]:/.test($.plugin.root)) {
      for (const python of ['pythonw', 'pyw']) {
        const { exitCode } = await $.process
          .run(['cmd', '/c', 'start', '', python, script])
          .catch(() => ({ exitCode: 1 }))

        if (exitCode === 0) {
          break
        }
      }
    }

    return started
  })

  on('turn.start', async ($, e, next) => {
    await $.fs.write(`${$.plugin.root}/overlay/state/${id}.json`, JSON.stringify({ working: true }))
    timer?.cancel()
    timer = $.clock.every(HEARTBEAT_MS, () => {
      void $.fs.write(`${$.plugin.root}/overlay/state/${id}.json`, JSON.stringify({ working: true }))
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    await $.fs.write(`${$.plugin.root}/overlay/state/${id}.json`, JSON.stringify({ working: false }))

    return next(e)
  })
}
