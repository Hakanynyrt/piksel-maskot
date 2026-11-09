import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

type Vec = [number, number, number]
type Box = {
  a: Vec
  b: Vec
  m: string
  tilt?: { deg: number; y: number; z: number }
  turn?: { deg: number; x: number; z: number }
}
type Camera = { yaw: number; pitch: number; pivotZ: number; scale: number; centerY: number; ox: number; oy: number }

const WIDTH_PX = 150
const HEIGHT_PX = 64
const PERSPECTIVE = 60
const BACKDROP_DARK = '#191919'
const BACKDROP_LIGHT = '#F5F4EF'
const TENNIS = { frames: 32, seconds: 1.6 }
const WORKING = { frames: 36, seconds: 3 }
const MASCOT_X = WIDTH_PX - 55
const GROUND_Y = HEIGHT_PX - 3

// Mesaj kutusunun penceredeki yeri: içerik alanı kenar çubuğu kadar sağa kaymış,
// kutu ortalanmış ve pencerenin altından bu kadar yukarıda.
const SIDEBAR_SHIFT_PX = 158
const COMPOSER_HALF_WIDTH_PX = 378
const COMPOSER_TOP_FROM_BOTTOM_PX = 83
const RIGHT_OVERHANG_PX = 22

const isWorkingAtom = atom({ plugin: 'piksel-maskot', key: 'isWorking' } as const, false)

// Her malzemenin üst, ön ve yan yüzü için tek bir düz renk.
const PALETTE: Record<string, [string, string, string]> = {
  o: ['#6FD6C9', '#3FB8AF', '#2A8A83'],
  e: ['#141414', '#141414', '#141414'],
  g: ['#BFFFF4', '#BFFFF4', '#BFFFF4'],
  a: ['#F7D154', '#F2C230', '#C99E20'],
  l: ['#B4B2AA', '#A09E96', '#7C7A73'],
  k: ['#4A4944', '#3C3B37', '#33322E'],
  r: ['#E6E4DC', '#D6D4CC', '#B4B2AA'],
}

const FACES: { n: Vec; shade: number; corners: (a: Vec, b: Vec) => Vec[] }[] = [
  { n: [0, -1, 0], shade: 0, corners: (a, b) => [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]], [a[0], a[1], b[2]]] },
  { n: [0, 1, 0], shade: 0, corners: (a, b) => [[a[0], b[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]] },
  { n: [0, 0, 1], shade: 1, corners: (a, b) => [[a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]] },
  { n: [0, 0, -1], shade: 1, corners: (a, b) => [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]]] },
  { n: [1, 0, 0], shade: 2, corners: (a, b) => [[b[0], a[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [b[0], a[1], b[2]]] },
  { n: [-1, 0, 0], shade: 2, corners: (a, b) => [[a[0], a[1], a[2]], [a[0], b[1], a[2]], [a[0], b[1], b[2]], [a[0], a[1], b[2]]] },
]

function viewOf(box: Box, cam: Camera, p: Vec): Vec {
  let [x, y, z] = p

  if (box.turn) {
    const t = (box.turn.deg * Math.PI) / 180
    const dx = x - box.turn.x
    const dz = z - box.turn.z
    x = box.turn.x + dx * Math.cos(t) + dz * Math.sin(t)
    z = box.turn.z - dx * Math.sin(t) + dz * Math.cos(t)
  }

  if (box.tilt) {
    const t = (box.tilt.deg * Math.PI) / 180
    const dy = y - box.tilt.y
    const dz = z - box.tilt.z
    y = box.tilt.y + dy * Math.cos(t) - dz * Math.sin(t)
    z = box.tilt.z + dy * Math.sin(t) + dz * Math.cos(t)
  }

  const yaw = (cam.yaw * Math.PI) / 180
  const pitch = (cam.pitch * Math.PI) / 180
  const rz = z - cam.pivotZ
  const x1 = x * Math.cos(yaw) + rz * Math.sin(yaw)
  const z1 = -x * Math.sin(yaw) + rz * Math.cos(yaw)
  const y1 = y - cam.centerY

  return [x1, y1 * Math.cos(pitch) + z1 * Math.sin(pitch), z1 * Math.cos(pitch) - y1 * Math.sin(pitch)]
}

function project(v: Vec, cam: Camera): string {
  const k = (PERSPECTIVE / (PERSPECTIVE - v[2])) * cam.scale

  return `${(cam.ox + v[0] * k).toFixed(1)} ${(cam.oy + v[1] * k).toFixed(1)}`
}

function drawBoxes(boxes: Box[], cam: Camera): string {
  const centerOf = (box: Box): Vec => [(box.a[0] + box.b[0]) / 2, (box.a[1] + box.b[1]) / 2, (box.a[2] + box.b[2]) / 2]
  const sorted = boxes
    .map(box => ({ box, depth: viewOf(box, cam, centerOf(box))[2] }))
    .sort((p, q) => p.depth - q.depth)
  let out = ''

  for (const { box } of sorted) {
    const center = centerOf(box)
    const from = viewOf(box, cam, center)

    for (const face of FACES) {
      const tip = viewOf(box, cam, [center[0] + face.n[0], center[1] + face.n[1], center[2] + face.n[2]])

      if (tip[2] - from[2] <= 0.02) {
        continue
      }

      const pts = face.corners(box.a, box.b).map(c => project(viewOf(box, cam, c), cam))
      out += `<path class="${box.m}${face.shade}" d="M${pts.join('L')}Z"/>`
    }
  }

  return out
}

// İlk STILL_PARTS parça sabit, geri kalanı (vizör ve gözler) göz kırpar.
const STILL_PARTS = 6

function torso(lift: number, blink: boolean): Box[] {
  const eyeTop = blink ? 0.85 : 0.5
  const eyeBottom = blink ? 0.95 : 1.3

  return [
    { a: [-3, 6, -1.2], b: [-1, 8, 1.2], m: 'o' },
    { a: [1, 6, -1.2], b: [3, 8, 1.2], m: 'o' },
    { a: [-3.5, -1 + lift, -2.5], b: [3.5, 3.5 + lift, 2.5], m: 'o' },
    { a: [-2.6, 3.5, -1.8], b: [2.6, 6.2, 1.8], m: 'o' },
    { a: [-0.25, -2.5 + lift, -0.25], b: [0.25, -1 + lift, 0.25], m: 'l' },
    { a: [-0.6, -3.6 + lift, -0.6], b: [0.6, -2.4 + lift, 0.6], m: 'a' },
    { a: [-2.6, 0.2 + lift, 2.5], b: [2.6, 1.6 + lift, 2.6], m: 'e' },
    { a: [-1.9, eyeTop + lift, 2.6], b: [-1, eyeBottom + lift, 2.65], m: 'g' },
    { a: [1, eyeTop + lift, 2.6], b: [1.9, eyeBottom + lift, 2.65], m: 'g' },
  ]
}

// Vuruşa göre raketin ne kadar öne geldiği: p=0 topla temas anı.
function swingAmount(p: number): number {
  if (p >= 0.85) {
    return -30 + ((p - 0.85) / 0.15) * 70
  }

  if (p < 0.12) {
    return 40 + (p / 0.12) * 60
  }

  if (p < 0.5) {
    return 100 - ((p - 0.12) / 0.38) * 130
  }

  return -30
}

function playerCamera(side: 1 | -1, ox: number): Camera {
  return { yaw: -side * 38, pitch: 14, pivotZ: 0, scale: 3.3, centerY: 4, ox, oy: GROUND_Y - 12 }
}

function racketArm(p: number, side: 1 | -1, ox: number): string {
  const forward = swingAmount(p)
  const turn = { deg: -side * forward, x: side * 3, z: 0 }
  const span = (from: number, to: number): [number, number] => (side === 1 ? [from, to] : [-to, -from])
  const [armA, armB] = span(2.6, 5.6)
  const [handleA, handleB] = span(5.6, 8.6)
  const [headA, headB] = span(8.6, 13.6)
  const boxes: Box[] = [
    { a: [armA, 3.8, -0.8], b: [armB, 5.4, 0.8], m: 'o', turn },
    { a: [handleA, 4.3, -0.3], b: [handleB, 4.9, 0.3], m: 'l', turn },
    { a: [headA, 2.6, -0.25], b: [headB, 6.6, 0.25], m: 'r', turn },
  ]

  return drawBoxes(boxes, playerCamera(side, ox))
}

function playerScene(side: 1 | -1, ox: number, phaseShift: number, cls: string): string {
  const cam = playerCamera(side, ox)
  const parts = torso(0, false)
  const otherArm: [number, number] = side === 1 ? [-4.6, -2.6] : [2.6, 4.6]
  const still = drawBoxes([...parts.slice(0, STILL_PARTS), { a: [otherArm[0], 3.8, -0.8], b: [otherArm[1], 5.4, 0.8], m: 'o' }], cam)
  const eyes = drawBoxes(parts.slice(STILL_PARTS), cam)
  const swing = frameGroups(TENNIS.frames, i => racketArm((i / TENNIS.frames + phaseShift) % 1, side, ox))

  return `<g class="${cls}">${still}<g class="bl">${eyes}</g>${swing}</g>`
}

function tennisBall(): string {
  return `<rect class="sh" x="${MASCOT_X - 27}" y="${GROUND_Y}" width="6" height="2" fill="#000" opacity=".3"/><rect class="ball" x="${MASCOT_X - 26}" y="${GROUND_Y - 22}" width="4" height="4" fill="#D9E64B"/>`
}

function ballCss(): string {
  const { seconds } = TENNIS

  return `.ball{animation:b ${seconds}s ease-in-out infinite}@keyframes b{0%,100%{transform:translateY(0)}50%{transform:translateY(-34px)}}.sh{animation:sh ${seconds}s ease-in-out infinite;transform-origin:${MASCOT_X - 24}px ${GROUND_Y + 1}px}@keyframes sh{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.45)}}@keyframes j{0%,100%{transform:translateY(-3px)}9%,91%{transform:translateY(0)}}.pR{animation:j ${seconds}s linear infinite}.bl{animation:bl 4.4s steps(1) infinite}@keyframes bl{0%,90%,100%{opacity:1}91%,95%{opacity:0}}@media (prefers-reduced-motion:reduce){.ball,.sh,.pR,.bl{animation:none}}`
}

function laptopParts(): { under: Box[]; over: Box[] } {
  const lidTilt = { deg: -14, y: 7.6, z: 6.4 }

  return {
    under: [
      { a: [-6, 7.6, 3], b: [6, 8, 6.8], m: 'l' },
      { a: [-5, 7.5, 3.4], b: [5, 7.6, 6.2], m: 'k' },
    ],
    over: [
      { a: [-6, 2.8, 6.4], b: [6, 7.6, 6.8], m: 'l', tilt: lidTilt },
      { a: [-0.8, 4.2, 6.8], b: [0.8, 5.8, 6.9], m: 'o', tilt: lidTilt },
    ],
  }
}

const WORK_CAMERA: Camera = { yaw: -28, pitch: 18, pivotZ: 2, scale: 3.1, centerY: 3.2, ox: WIDTH_PX - 60, oy: 44.3 }

function workingFrame(i: number): string {
  const t = i / WORKING.frames
  const tap = Math.sin(t * Math.PI * 12) * 0.55
  const lift = Math.sin(t * Math.PI * 12) * 0.12
  const boxes: Box[] = [
    ...torso(lift, t > 0.62 && t < 0.67),
    { a: [-4.6, 3.8, -0.8], b: [-2.6, 5.4, 3.2], m: 'o' },
    { a: [2.6, 3.8, -0.8], b: [4.6, 5.4, 3.2], m: 'o' },
    { a: [-4.6, 4.2 + tap, 3.2], b: [-3, 7.2 + tap, 4.4], m: 'o' },
    { a: [3, 4.2 - tap, 3.2], b: [4.6, 7.2 - tap, 4.4], m: 'o' },
  ]

  return drawBoxes(boxes, WORK_CAMERA)
}

function frameCss(frames: number, seconds: number): string {
  const dt = seconds / frames
  const showUntil = (100 / frames + 0.3).toFixed(2)
  let delays = ''

  for (let i = 1; i < frames; i++) {
    delays += `.f${i}{animation-delay:-${(seconds - i * dt).toFixed(3)}s}`
  }

  const colors = Object.entries(PALETTE)
    .map(([m, tones]) => tones.map((c, s) => `.${m}${s}{fill:${c}}`).join(''))
    .join('')

  return `${colors}.f{visibility:hidden;animation:s ${seconds}s steps(1) infinite}@keyframes s{0%{visibility:visible}${showUntil}%,100%{visibility:hidden}}${delays}@media (prefers-reduced-motion:reduce){.f{animation:none;visibility:hidden}.f0{visibility:visible}}`
}

function frameGroups(frames: number, draw: (i: number) => string): string {
  let groups = ''

  for (let i = 0; i < frames; i++) {
    groups += `<g class="f f${i}">${draw(i)}</g>`
  }

  return groups
}

export function mascotSvg(isWorking: boolean): string {
  const x = `calc(50vw + ${SIDEBAR_SHIFT_PX + COMPOSER_HALF_WIDTH_PX + RIGHT_OVERHANG_PX - WIDTH_PX}px)`
  const y = `calc(100vh - ${COMPOSER_TOP_FROM_BOTTOM_PX + HEIGHT_PX - 1}px)`
  const page = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${BACKDROP_DARK}}@media (prefers-color-scheme:light){html,body{background:${BACKDROP_LIGHT}}}svg{display:block;position:fixed;inset:0;width:100vw;height:100vh}.spot{transform:translate(${x},${y})}`
  let css: string
  let content: string

  if (isWorking) {
    const laptop = laptopParts()

    css = frameCss(WORKING.frames, WORKING.seconds)
    content =
      drawBoxes(laptop.under, WORK_CAMERA) +
      frameGroups(WORKING.frames, workingFrame) +
      drawBoxes(laptop.over, WORK_CAMERA)
  } else {
    css = frameCss(TENNIS.frames, TENNIS.seconds) + ballCss()
    content = playerScene(1, MASCOT_X, 0, 'pR') + tennisBall()
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" shape-rendering="crispEdges"><style>${page}${css}</style><g class="spot">${content}</g></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.ui.backdrop({ id: 'maskot', glass: { blur: 0, opacity: 0 } })

    return started
  })

  on('turn.start', async ($, e, next) => {
    await update($, isWorkingAtom, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isWorkingAtom, () => false)

    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.plugin !== 'piksel-maskot') {
      return next(e)
    }

    const { Svg } = $.ui.resolve(e)
    const isWorking = await read($, isWorkingAtom)

    return (
      <Svg
        source={mascotSvg(isWorking)}
        alt={isWorking ? 'Robot maskot dizüstünde yazı yazıyor' : 'Robot maskot raketle top sektiriyor'}
        isInteractive
      />
    )
  })
}
