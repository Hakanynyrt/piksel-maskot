import type { EngineInterface, Register } from 'claude-code'

// Starts the transparent robot window and tells it what this session is doing.
const HEARTBEAT_MS = 30000
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

type TurnEvent = 'done' | 'error'

type Status = {
  // Running turns, main loop and subagents, by turnId.
  turns: Set<string>
  // Questions and permissions waiting for the user.
  asks: Set<string>
  event: TurnEvent | null
  eventId: number
  // When the event happened; heartbeats leave it alone.
  eventAt: number
  timer?: { cancel: () => void }
}

// A robot problem must never disturb Claude; a failed write is repaired by the next one.
async function publish($: EngineInterface, s: Status, raised?: TurnEvent) {
  try {
    const isActive = s.turns.size > 0 || s.asks.size > 0

    if (isActive && !s.timer) {
      s.timer = $.clock.every(HEARTBEAT_MS, () => {
        void publish($, s)
      })
    } else if (!isActive && s.timer) {
      s.timer.cancel()
      s.timer = undefined
    }

    const now = await $.clock.now()

    if (raised) {
      s.event = raised
      s.eventId = Math.max(s.eventId + 1, now)
      s.eventAt = now
    }

    // One file per session, so reloading and resuming reuse it.
    await $.fs.write(
      `${$.plugin.root}/overlay/state/${await $.session.id()}.json`,
      JSON.stringify({
        working: s.turns.size > 0,
        waiting: s.asks.size > 0,
        event: s.event,
        eventId: s.eventId,
        at: s.event ? s.eventAt : now,
      }),
    )
  } catch {}
}

export const register: Register = on => {
  const s: Status = {
    turns: new Set(),
    asks: new Set(),
    event: null,
    eventId: 0,
    eventAt: 0,
  }

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
    s.turns.add(e.turnId)
    if (e.agentId === undefined) s.event = null
    await publish($, s)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    s.turns.delete(e.turnId)
    if (s.turns.size === 0) s.asks.clear()

    const raised =
      e.agentId !== undefined || e.reason === 'aborted'
        ? undefined
        : e.reason === 'answer'
          ? 'done'
          : 'error'

    await publish($, s, raised)

    return next(e)
  })

  // A question or plan approval lasts until the user answers. Permission opens below
  // and closes when the tool ends, as no event marks the answer itself.
  on('tool.call', async ($, e, next) => {
    if (QUESTION_TOOLS.has(e.tool)) {
      s.asks.add(e.tool)
      await publish($, s)
    }

    try {
      return await next(e)
    } finally {
      if (s.asks.delete(e.tool)) await publish($, s)
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    s.asks.add(e.tool_name)
    await publish($, s)

    return next(e)
  })

  on('classic.Elicitation', async ($, e, next) => {
    s.asks.add(`mcp:${e.mcp_server_name}`)
    await publish($, s)

    return next(e)
  })

  on('classic.ElicitationResult', async ($, e, next) => {
    if (s.asks.delete(`mcp:${e.mcp_server_name}`)) await publish($, s)

    return next(e)
  })
}
