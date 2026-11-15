import type { EngineInterface, Register } from 'claude-code'

// Ayrı maskot penceresine bu oturumun durumunu söyler.
// Ayrıca tehlike bekçisi: geri dönüşsüz bir kabuk komutunu çalışmadan durdurur,
// kararı kullanıcıya bırakır ve maskota "danger" olayı yazar.
const HEARTBEAT_MS = 30000
// Kutlama yalnızca en az bu kadar süren işlerin sonunda.
const LONG_TURN_MS = 60000
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// Kullanıcının "onaylıyorum" dediği komut bu süre içinde bir kez çalışabilir.
const APPROVAL_MS = 10 * 60 * 1000

type TurnEvent = 'done' | 'error' | 'danger'

type Status = {
  // Süren turlar: ana döngü ve alt ajanlar, turnId ile.
  turns: Set<string>
  // Kullanıcıdan cevap bekleyen sorular ve izinler.
  asks: Set<string>
  event: TurnEvent | null
  eventId: number
  // Olayın gerçekleştiği an; nabız yazışları bunu değiştirmez.
  eventAt: number
  // Ana turun başladığı an.
  mainStartedAt: number
  timer?: { cancel: () => void }
}

// Maskot hatası Claude'un işini asla bozmamalı; yazılamayan durum sonraki yazışta düzelir.
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

    // Oturum başına tek dosya: yeniden yükleme ve devam ettirme aynı dosyayı kullanır.
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

// ---------------------------------------------------------------------------
// Tehlike sınıflandırıcı (saf): komut metni -> null ya da kısa Türkçe sebep.
// Sebep, izin penceresinde kullanıcıya gösterilir.
// ---------------------------------------------------------------------------

export type Shell = 'bash' | 'powershell' | 'cmd'

// heredoc: "<<EOF" gövdesi; tırnaklı sonlandırıcıda (<<'EOF') gövde düz veridir.
type Tok = { t: string; op?: string; redir?: boolean; heredoc?: { quoted: boolean } }
type Heredoc = { body: string; quoted: boolean }
type Segment = { words: string[]; redirects: string[]; heredocs: Heredoc[]; pipedFrom?: Segment }

const R_DELETE = (target: string) => `irreversible bulk deletion: ${target}`
const R_DISK = 'formats or overwrites a disk'
const R_FORCE_PUSH = 'force-rewrites history on the remote (git push --force)'
const R_REMOTE_DELETE = 'deletes branches or history on the remote (git push --delete/--mirror)'
const R_RESET_HARD = 'throws away all uncommitted changes (git reset --hard)'
const R_CLEAN = 'permanently deletes untracked files (git clean)'
const R_BRANCH_D = 'force-deletes an unmerged branch (git branch -D)'
const R_DISCARD = 'discards uncommitted changes for good'
const R_STASH = 'deletes all stashed changes (git stash clear)'
const R_DB = 'drops or empties a database or table'
const R_DOCKER = 'deletes Docker data and volumes'
const R_SHUTDOWN = 'shuts down or restarts the computer'
const R_REGISTRY = 'deletes from the Windows registry'
const R_RECYCLE = 'permanently empties the Recycle Bin'
const R_BACKUP = 'deletes backups or shadow copies'
const R_CHMOD = 'changes permissions on an important folder recursively'

const DELETE_CMDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'ri', 'remove-item', 'rimraf', 'deltree'])
const CMD_SWITCH_CMDS = new Set(['del', 'erase', 'rd', 'rmdir', 'deltree'])
const LISTING_CMDS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi'])
const DB_CLIENTS = new Set([
  'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'invoke-sqlcmd', 'mongo', 'mongosh',
  'clickhouse-client', 'clickhouse', 'duckdb', 'cockroach', 'redis-cli', 'osql', 'isql', 'pgcli', 'mycli', 'litecli',
])
const USER_FOLDERS = new Set([
  'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'appdata', 'onedrive',
  'masaüstü', 'belgeler', 'indirilenler', 'resimler', 'favorites', 'contacts', 'saved games', 'links',
  'library', 'projects', 'source', 'repos', 'code', 'dev', 'src', 'work', 'workspace',
])
const POSIX_SYSTEM = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'opt', 'proc', 'root', 'sbin', 'srv', 'sys',
  'usr', 'var', 'users', 'system', 'library', 'applications', 'private', 'mnt', 'media', 'snap',
])
const WINDOWS_SYSTEM = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'system volume information',
  '$recycle.bin', 'recovery', 'boot', 'perflogs',
])

function tokenize(src: string, shell: Shell): Tok[] {
  const out: Tok[] = []
  let cur = ''
  let has = false
  const heredocs: Array<{ delim: string; strip: boolean; quoted: boolean }> = []
  const push = () => {
    if (has) out.push({ t: cur })
    cur = ''
    has = false
  }
  const op = (o: string) => {
    push()
    out.push({ t: o, op: o })
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const n = src[i + 1]

    if (c === "'" && shell !== 'cmd') {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      cur += src.slice(i + 1, end)
      has = true
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        const d = src[j]!
        const e = src[j + 1]
        if (shell === 'bash' && d === '\\' && (e === '"' || e === '\\' || e === '$' || e === '`')) {
          cur += e
          j += 2
          continue
        }
        if (shell === 'powershell' && d === '`' && e !== undefined) {
          cur += e
          j += 2
          continue
        }
        cur += d
        j++
      }
      has = true
      i = j
      continue
    }
    if (c === '\\' && shell === 'bash' && (n === '\n' || n === ' ')) {
      if (n === ' ') {
        cur += ' '
        has = true
      }
      i++
      continue
    }
    if (c === '`' && shell === 'powershell' && n !== undefined) {
      if (n !== '\n') {
        cur += n
        has = true
      }
      i++
      continue
    }
    if (c === '<' && n === '<' && src[i + 2] !== '<' && shell === 'bash') {
      // Heredoc başlangıcı: <<EOF, <<-EOF, <<'EOF', <<"EOF", <<\EOF
      push()
      let j = i + 2
      const strip = src[j] === '-'
      if (strip) j++
      while (src[j] === ' ' || src[j] === '\t') j++
      let delim = ''
      let quoted = false
      while (j < src.length && !/[\s;|&<>()]/.test(src[j]!)) {
        const d = src[j]!
        if (d === "'" || d === '"') {
          const k = src.indexOf(d, j + 1)
          const end = k < 0 ? src.length : k
          delim += src.slice(j + 1, end)
          quoted = true
          j = end + 1
          continue
        }
        if (d === '\\') {
          quoted = true
          j++
          continue
        }
        delim += d
        j++
      }
      if (delim) heredocs.push({ delim, strip, quoted })
      i = j - 1
      continue
    }
    if (c === '\n' || c === '\r') {
      if (heredocs.length && c === '\n') {
        // Bekleyen heredoc gövdelerini sonlandırıcı satıra kadar oku.
        push()
        let pos = i + 1
        for (const h of heredocs) {
          const lines: string[] = []
          while (pos < src.length) {
            const nl = src.indexOf('\n', pos)
            const end = nl < 0 ? src.length : nl
            let line = src.slice(pos, end).replace(/\r$/, '')
            pos = end + 1
            if (h.strip) line = line.replace(/^\t+/, '')
            if (line === h.delim) break
            lines.push(line)
          }
          out.push({ t: lines.join('\n'), heredoc: { quoted: h.quoted } })
        }
        heredocs.length = 0
        op(';')
        i = Math.min(pos, src.length) - 1
        continue
      }
      op(';')
      continue
    }
    if (c === ' ' || c === '\t') {
      push()
      continue
    }
    if (c === '#' && !has && shell !== 'cmd') {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
      continue
    }
    if (c === '>' || c === '<') {
      if (/^\d+$/.test(cur) || cur === '*') {
        cur = ''
        has = false
      } else push()
      let o = c
      let j = i + 1
      if (src[j] === c) o += src[j++]
      if (src[j] === '&') {
        j++
        while (j < src.length && /[\d-]/.test(src[j]!)) j++
        out.push({ t: o + '&', op: 'redir', redir: false })
      } else out.push({ t: o, op: 'redir', redir: true })
      i = j - 1
      continue
    }
    if (c === '&' || c === '|') {
      if (n === c) {
        op(c + c)
        i++
      } else op(c)
      continue
    }
    if (c === ';') {
      op(';')
      continue
    }
    if (c === '$' && n === '(') {
      op(';')
      i++
      continue
    }
    if (c === '(' || c === ')' || (c === '`' && shell === 'bash')) {
      op(';')
      continue
    }
    if ((c === '{' || c === '}') && !has) {
      op(';')
      continue
    }
    cur += c
    has = true
  }
  push()
  return out
}

function segmentsOf(tokens: Tok[]): Segment[] {
  const segs: Segment[] = []
  let seg: Segment = { words: [], redirects: [], heredocs: [] }
  let piped = false
  const close = () => {
    if (seg.words.length || seg.redirects.length || seg.heredocs.length) {
      if (piped && segs.length) seg.pipedFrom = segs[segs.length - 1]
      segs.push(seg)
    }
    seg = { words: [], redirects: [], heredocs: [] }
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok.heredoc) {
      seg.heredocs.push({ body: tok.t, quoted: tok.heredoc.quoted })
      continue
    }
    if (tok.op === 'redir') {
      if (tok.redir && tokens[i + 1] && !tokens[i + 1]!.op) seg.redirects.push(tokens[++i]!.t)
      continue
    }
    if (tok.op) {
      close()
      piped = tok.op === '|'
      continue
    }
    seg.words.push(tok.t)
  }
  close()
  return segs
}

function baseName(word: string): string {
  const last = word.split(/[\\/]/).pop() ?? word
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-c', '-h', '-p', '-r', '-t', '-U', '-C', '-D'])
const XARGS_VALUE_FLAGS = new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-s', '-a'])
const PLAIN_WRAPPERS = new Set(['nohup', 'time', 'command', 'builtin', 'exec', 'call', 'unbuffer', 'npx', 'pnpx', 'bunx'])

// Komutun önündeki sarmalayıcıları atar: sudo, env, VAR=x, nohup, xargs, npx...
function stripPrefixes(words: string[]): string[] {
  let w = words.slice()
  for (let guard = 0; guard < 10 && w.length; guard++) {
    const first = w[0]!
    const name = baseName(first)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      w.shift()
      continue
    }
    if (name === 'sudo' || name === 'doas' || name === 'gsudo') {
      w.shift()
      while (w.length && w[0]!.startsWith('-')) {
        const f = w.shift()!
        if (SUDO_VALUE_FLAGS.has(f) && w.length) w.shift()
      }
      continue
    }
    if (name === 'env') {
      w.shift()
      while (w.length && (w[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!))) w.shift()
      continue
    }
    if (name === 'xargs') {
      w.shift()
      while (w.length && w[0]!.startsWith('-')) {
        const f = w.shift()!
        if (XARGS_VALUE_FLAGS.has(f) && w.length) w.shift()
      }
      continue
    }
    if (name === 'timeout' || name === 'nice' || name === 'ionice' || name === 'stdbuf') {
      w.shift()
      while (w.length && w[0]!.startsWith('-')) {
        const f = w.shift()!
        if ((f === '-n' || f === '-s' || f === '-k' || f === '-c') && w.length) w.shift()
      }
      if (name === 'timeout' && w.length && /^\d/.test(w[0]!)) w.shift()
      continue
    }
    if (PLAIN_WRAPPERS.has(name)) {
      w.shift()
      while (w.length && w[0]!.startsWith('-')) {
        const f = w.shift()!
        if ((f === '-p' || f === '--package') && w.length) w.shift()
      }
      continue
    }
    if ((name === 'pnpm' || name === 'yarn') && w[1]?.toLowerCase() === 'dlx') {
      w = w.slice(2)
      continue
    }
    break
  }
  return w
}

// Bir ortam değişkeninin tüm yazılışları: $env:X, ${env:X}, %X%, $X, ${X} (Git Bash).
function envAlts(names: string[]): string[] {
  return names.flatMap(raw => {
    const n = raw.replace(/[()]/g, m => `\\${m}`)
    const forms = [`\\$env:${n}`, `\\$\\{env:${n}\\}`, `%${n}%`, `\\$\\{${n}\\}`]
    if (!/[()]/.test(raw)) forms.push(`\\$${n}`)
    return forms
  })
}

function envForms(...names: string[]): RegExp {
  return new RegExp(`^(${envAlts(names).join('|')})(?=\\/|$)`)
}

const HOME_PREFIX = new RegExp(`^(~|${envAlts(['home', 'userprofile']).join('|')})(?=\\/|$)`)
const ENV_PREFIXES: Array<[RegExp, string]> = [
  [envForms('windir', 'systemroot'), 'c:/windows'],
  [envForms('programfiles(x86)'), 'c:/program files (x86)'],
  [envForms('programfiles', 'programw6432'), 'c:/program files'],
  [envForms('programdata', 'allusersprofile'), 'c:/programdata'],
  [envForms('systemdrive', 'homedrive'), 'c:'],
  [envForms('appdata'), '~/appdata/roaming'],
  [envForms('localappdata'), '~/appdata/local'],
  // OneDrive klasörünü silmek dosyaları buluttan da siler.
  [envForms('onedrive', 'onedriveconsumer', 'onedrivecommercial'), '~/onedrive'],
]

type NormPath = { path: string; wildcardAll: boolean }

function normalizePath(raw: string): NormPath {
  let p = raw.trim().toLowerCase().replace(/\\/g, '/')
  p = p.replace(/^(microsoft\.powershell\.core\/)?filesystem::/, '')
  p = p.replace(/^\/\/\?\//, '')
  p = p.replace(HOME_PREFIX, '~')
  for (const [re, to] of ENV_PREFIXES) p = p.replace(re, to)
  // Git Bash ve WSL sürücü yolları: /c/... ve /mnt/c/...
  const drive = /^\/(?:mnt\/)?([a-z])(\/.*)?$/.exec(p)
  if (drive) p = `${drive[1]}:${drive[2] ?? '/'}`
  p = p.replace(/\/{2,}/g, '/')
  p = p.replace(/\/\.(?=\/|$)/g, '')
  if (p === '') p = '/'
  let wildcardAll = false
  const wild = /^(.*?)\/?(\*|\*\.\*|\.\*)$/.exec(p)
  if (wild && (wild[1] === '' || p.includes('/'))) {
    wildcardAll = true
    p = wild[1] === '' ? (p.startsWith('/') ? '/' : '.') : wild[1]!
  }
  if (p.length > 1 && p.endsWith('/') && !/^[a-z]:\/$/.test(p)) p = p.replace(/\/+$/, '')
  if (/^[a-z]:$/.test(p)) p += '/'
  if (p === './' || p === '') p = '.'
  return { path: p, wildcardAll }
}

// Silinirse ağır kayıp olan yerler: kökler, sistem klasörleri, ev klasörü, .git...
function isCriticalPath(p: string): boolean {
  if (p === '/' || p === '.' || p === '~' || /^\.\.(\/\.\.)*$/.test(p)) return true
  if (p === '.git' || p.endsWith('/.git')) return true
  if (/^[a-z]:\/?$/.test(p)) return true

  const win = /^[a-z]:\/(.*)$/.exec(p)
  if (win) {
    const parts = win[1]!.split('/')
    const top = parts[0]!
    if (parts.length === 1) return true
    if (WINDOWS_SYSTEM.has(top)) return true
    if (top === 'users') {
      if (parts.length <= 2) return true
      if (parts.length === 3) return USER_FOLDERS.has(parts[2]!) || parts[2]!.startsWith('.')
      return parts.length === 4 && parts[2] === 'appdata'
    }
    return false
  }

  if (p.startsWith('~/')) {
    const parts = p.slice(2).split('/')
    if (parts.length === 1) return USER_FOLDERS.has(parts[0]!) || parts[0]!.startsWith('.')
    return parts.length === 2 && parts[0] === 'appdata'
  }

  if (p.startsWith('/')) {
    const parts = p.slice(1).split('/')
    if (parts.length === 1) return true
    return parts.length === 2 && POSIX_SYSTEM.has(parts[0]!)
  }
  return false
}

// "$DIR/" ya da "$DIR/*": değişken boşsa kök klasör silinir.
function isEmptyVarRoot(raw: string): boolean {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\\/]\*?$/.test(raw.trim())
}

function isRegistryPath(raw: string): boolean {
  return /^(hklm|hkcu|hkcr|hku|hkcc):|^registry::/i.test(raw.trim())
}

function deletionTargetDanger(raw: string, recursive: boolean): string | null {
  if (isEmptyVarRoot(raw)) return R_DELETE(raw)
  const { path, wildcardAll } = normalizePath(raw)
  if (recursive) return isCriticalPath(path) ? R_DELETE(raw) : null
  // Özyinelemesiz: yalnız önemli bir klasörün içini toptan silmek tehlikeli.
  return wildcardAll && path !== '.' && isCriticalPath(path) ? R_DELETE(raw) : null
}

const PS_PATH_PARAMS = new Set(['-path', '-literalpath', '-lp', '-pspath'])
const PS_VALUE_PARAMS = new Set([
  '-include', '-exclude', '-filter', '-erroraction', '-ea', '-warningaction', '-wa', '-credential',
  '-stream', '-informationaction', '-infa', '-errorvariable', '-ev', '-outvariable', '-ov', '-depth',
])

function isRecursiveFlag(tok: string): boolean {
  const l = tok.toLowerCase()
  if (l === '--recursive' || l === '/s') return true
  if (/^-[rfvdip]+$/i.test(tok) && /r/i.test(tok)) return true
  const bare = l.replace(/:\$true$/, '')
  return bare.length >= 2 && /^-r[a-z]*$/.test(bare) && '-recurse'.startsWith(bare)
}

type Targets = { recursive: boolean; targets: string[] }

// Silme ve listeleme komutlarının hedeflerini ve özyineleme bayrağını okur.
function readTargets(cmd: string, args: string[]): Targets {
  let recursive = cmd === 'rimraf' || cmd === 'deltree'
  const targets: string[] = []
  let endOfFlags = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const l = a.toLowerCase()
    if (!endOfFlags && a === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && (isRecursiveFlag(a) || l === '--no-preserve-root')) {
      recursive = true
      continue
    }
    if (!endOfFlags && CMD_SWITCH_CMDS.has(cmd) && /^\/[a-z]$/i.test(a)) continue
    if (!endOfFlags && a.startsWith('-') && a.length > 1) {
      const name = l.split(':')[0]!
      if (PS_PATH_PARAMS.has(name)) {
        const inline = a.slice(name.length + 1)
        if (inline) targets.push(inline)
        else if (i + 1 < args.length) targets.push(args[++i]!)
      } else if (PS_VALUE_PARAMS.has(name) && !a.includes(':')) i++
      continue
    }
    targets.push(a)
  }
  return { recursive, targets: targets.flatMap(t => t.split(',')).filter(Boolean) }
}

function classifyDeletion(cmd: string, args: string[], pipedFrom?: Segment): string | null {
  let { recursive, targets } = readTargets(cmd, args)
  // "Get-ChildItem C:\ | Remove-Item -Recurse": hedef borunun başındaki listeden gelir.
  if (!targets.length && pipedFrom) {
    const src = stripPrefixes(pipedFrom.words)
    const srcCmd = src.length ? baseName(src[0]!) : ''
    const narrowed = src.some(w => /^-(filter|include|exclude|fi|in|ex)/i.test(w))
    if (LISTING_CMDS.has(srcCmd) && !narrowed) {
      const listed = readTargets(srcCmd, src.slice(1))
      recursive = recursive || listed.recursive
      targets = listed.targets.length ? listed.targets : ['.']
      if (!recursive && targets.every(t => !normalizePath(t).wildcardAll)) targets = targets.map(t => `${t}/*`)
    }
  }
  for (const t of targets) {
    if (isRegistryPath(t)) return R_REGISTRY
    const r = deletionTargetDanger(t, recursive)
    if (r) return r
  }
  return null
}

function shortFlagsHave(tok: string, letter: string): boolean {
  return /^-[A-Za-z]+$/.test(tok) && tok.includes(letter)
}

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const BROAD_PATHSPECS = new Set(['.', './', '*', ':/', ':/*', ':(top)'])

function classifyGit(args: string[]): string | null {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    if (GIT_VALUE_OPTS.has(args[i]!)) i++
    i++
  }
  const sub = args[i]?.toLowerCase()
  const rest = args.slice(i + 1)
  const lower = rest.map(a => a.toLowerCase())

  if (sub === 'push') {
    for (const a of rest) {
      const l = a.toLowerCase()
      if (l === '--mirror' || l === '--delete' || l === '--prune' || shortFlagsHave(a, 'd')) return R_REMOTE_DELETE
      if (l === '--force' || shortFlagsHave(a, 'f')) return R_FORCE_PUSH
      if (/^\+\S/.test(a)) return R_FORCE_PUSH
      if (/^:\S/.test(a)) return R_REMOTE_DELETE
    }
    return null
  }
  if (sub === 'reset') return lower.includes('--hard') ? R_RESET_HARD : null
  if (sub === 'clean') {
    const force = rest.some(a => a.toLowerCase() === '--force' || shortFlagsHave(a, 'f'))
    const dry = rest.some(a => a.toLowerCase() === '--dry-run' || shortFlagsHave(a, 'n'))
    return force && !dry ? R_CLEAN : null
  }
  if (sub === 'branch') {
    if (rest.some(a => shortFlagsHave(a, 'D'))) return R_BRANCH_D
    const del = rest.some(a => a === '--delete' || shortFlagsHave(a, 'd'))
    const force = rest.some(a => a === '--force' || shortFlagsHave(a, 'f'))
    return del && force ? R_BRANCH_D : null
  }
  if (sub === 'checkout') {
    if (lower.includes('-f') || lower.includes('--force')) return R_DISCARD
    return lower.some(a => BROAD_PATHSPECS.has(a)) ? R_DISCARD : null
  }
  if (sub === 'restore') {
    const staged = lower.includes('--staged') || rest.includes('-S')
    const worktree = lower.includes('--worktree') || rest.includes('-W')
    if (staged && !worktree) return null
    return lower.some(a => BROAD_PATHSPECS.has(a)) ? R_DISCARD : null
  }
  if (sub === 'stash') return lower[0] === 'clear' ? R_STASH : null
  return null
}

function classifyDocker(cmd: string, args: string[]): string | null {
  const l = args.map(a => a.toLowerCase())
  const shortHas = (letter: string) => l.some(a => /^-[a-z]+$/.test(a) && a.includes(letter))
  if (l.includes('system') && l.includes('prune')) {
    if (l.includes('--all') || l.includes('--volumes') || shortHas('a')) return R_DOCKER
  }
  if (l.includes('volume') && l.some(a => a === 'rm' || a === 'remove' || a === 'prune')) return R_DOCKER
  if ((cmd === 'docker-compose' || l.includes('compose')) && l.includes('down')) {
    if (l.includes('--volumes') || shortHas('v')) return R_DOCKER
  }
  return null
}

function decodePowerShellBase64(text: string): string | null {
  try {
    const bin = atob(text)
    let out = ''
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
    return out
  } catch {
    return null
  }
}

const PS_LAUNCH_VALUE_FLAGS = new Set([
  '-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-inputformat', '-if', '-outputformat', '-of', '-o',
  '-configurationname', '-workingdirectory', '-wd', '-settingsfile', '-psconsolefile', '-version', '-v',
])

function nestedPowerShell(args: string[], depth: number): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const l = a.toLowerCase()
    if (/^-e(c|n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)?$/.test(l)) {
      const decoded = args[i + 1] ? decodePowerShellBase64(args[i + 1]!) : null
      return decoded ? classifyCommand(decoded, 'powershell', depth + 1) : null
    }
    if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(l)) return classifyCommand(args.slice(i + 1).join(' '), 'powershell', depth + 1)
    if (/^-f(i(l(e)?)?)?$/.test(l)) return null
    if (PS_LAUNCH_VALUE_FLAGS.has(l)) {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return classifyCommand(args.slice(i).join(' '), 'powershell', depth + 1)
  }
  return null
}

function nestedPosixShell(args: string[], depth: number): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (/^-[a-z]*c[a-z]*$/i.test(a) && i + 1 < args.length) return classifyCommand(args[i + 1]!, 'bash', depth + 1)
    if (!a.startsWith('-')) return null
  }
  return null
}

function nestedWsl(args: string[], depth: number): string | null {
  let i = 0
  while (i < args.length) {
    const l = args[i]!.toLowerCase()
    if (l === '-e' || l === '--exec' || l === '--') return classifyCommand(args.slice(i + 1).join(' '), 'bash', depth + 1)
    if (['-d', '--distribution', '-u', '--user', '--cd'].includes(l)) {
      i += 2
      continue
    }
    if (l.startsWith('-')) {
      i++
      continue
    }
    return classifyCommand(args.slice(i).join(' '), 'bash', depth + 1)
  }
  return null
}

const DISK_CMDS = new Set(['diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition'])
const DB_TASKS = new Set(['db:drop', 'db:reset', 'db:wipe', 'migrate:fresh', 'migrate:reset', 'db:schema:load'])

function classifySegment(seg: Segment, shell: Shell, depth: number): string | null {
  for (const r of seg.redirects) {
    if (/^\/dev\/(sd|hd|nvme|xvd|vd|mmcblk|disk)/i.test(r) || /physicaldrive/i.test(r)) return R_DISK
  }
  const words = stripPrefixes(seg.words)
  if (!words.length) return null
  const cmd = baseName(words[0]!)
  const args = words.slice(1)
  const lower = args.map(a => a.toLowerCase())

  // İç içe kabuklar
  // Kabuğa beslenen heredoc ("bash <<EOF", "cat <<EOF | sh") komut olarak okunur.
  // Betik dosyası verilmişse ("bash x.sh <<EOF") gövde o betiğin girdisidir, komut değil.
  const readsStdin = !args.some(a => !a.startsWith('-')) || lower.includes('-s') || lower.includes('-')
  const fedDocs = readsStdin ? [...seg.heredocs, ...(seg.pipedFrom?.heredocs ?? [])] : []
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(cmd)) {
    const r = nestedPosixShell(args, depth)
    if (r) return r
    for (const h of fedDocs) {
      const inner = classifyCommand(h.body, 'bash', depth + 1)
      if (inner) return inner
    }
    return null
  }
  if (cmd === 'powershell' || cmd === 'pwsh') {
    const r = nestedPowerShell(args, depth)
    if (r) return r
    for (const h of fedDocs) {
      const inner = classifyCommand(h.body, 'powershell', depth + 1)
      if (inner) return inner
    }
    return null
  }
  if (cmd === 'cmd') {
    // Git Bash "/c"yi yola çevirdiği için oradan "cmd //c ..." yazılır.
    const at = lower.findIndex(a => /^\/{1,2}[ckr]$/.test(a))
    return at >= 0 ? classifyCommand(args.slice(at + 1).join(' '), 'cmd', depth + 1) : null
  }
  if (cmd === 'wsl') return nestedWsl(args, depth)
  if (cmd === 'eval') return classifyCommand(args.join(' '), shell, depth + 1)
  if (cmd === 'iex' || cmd === 'invoke-expression') {
    return classifyCommand(args.filter(a => a.toLowerCase() !== '-command').join(' '), 'powershell', depth + 1)
  }

  if (DELETE_CMDS.has(cmd)) return classifyDeletion(cmd, args, seg.pipedFrom)

  if (cmd === 'remove-itemproperty' || cmd === 'rp' || cmd === 'clear-itemproperty') {
    return args.some(isRegistryPath) ? R_REGISTRY : null
  }
  if (cmd === 'reg' && lower[0] === 'delete') return R_REGISTRY

  if (cmd === 'find') {
    // Başlangıç yolları ifadeden (-name, !, "(") öncedir; yoksa ".".
    const firstExpr = args.findIndex(a => /^[-!(]/.test(a) && a !== '-' )
    const starts = (firstExpr < 0 ? args : args.slice(0, firstExpr)).filter(a => !/^-[HLP]$/.test(a))
    const deletes =
      lower.includes('-delete') ||
      (['-exec', '-execdir', '-ok', '-okdir'].some(x => lower.includes(x)) &&
        lower.some(a => DELETE_CMDS.has(baseName(a)) || a === 'shred'))
    if (!deletes) return null
    const filtered = lower.some(a =>
      ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-empty'].includes(a),
    )
    for (const start of starts.length ? starts : ['.']) {
      const { path } = normalizePath(start)
      if (!isCriticalPath(path)) continue
      // Süzgeçsiz "find . -delete", "rm -rf ." gibi bütün klasörü (.git dahil) siler.
      if (!filtered || path === '/' || path === '~' || /^[a-z]:\/$/.test(path)) return R_DELETE(start)
    }
    return null
  }

  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') {
    if (!args.some(a => a === '--recursive' || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a))) return null
    const hit = args.some(a => {
      if (a.startsWith('-')) return false
      const { path, wildcardAll } = normalizePath(a)
      return path !== '.' && !wildcardAll && isCriticalPath(path)
    })
    return hit ? R_CHMOD : null
  }

  // Diskler
  if (cmd === 'format') return lower.some(a => /^[a-z]:\\?$/.test(a)) ? R_DISK : null
  if (DISK_CMDS.has(cmd) || cmd === 'mkfs' || cmd.startsWith('mkfs.')) return R_DISK
  if (cmd === 'wipefs') return lower.some(a => a === '-a' || a === '--all') ? R_DISK : null
  if (cmd === 'dd') return lower.some(a => /^of=(\/dev\/|\\\\\.\\physicaldrive)/.test(a)) ? R_DISK : null
  if (cmd === 'shred' || cmd === 'blkdiscard') return lower.some(a => a.startsWith('/dev/')) ? R_DISK : null

  if (cmd === 'git') return classifyGit(args)

  // Veritabanı araçları
  if (cmd === 'dropdb') return R_DB
  if (cmd === 'mysqladmin' && lower.includes('drop')) return R_DB
  if (lower.some(a => DB_TASKS.has(a))) return R_DB
  if (cmd === 'prisma' && (lower.includes('--force-reset') || (lower.includes('migrate') && lower.includes('reset')))) return R_DB
  if (cmd === 'supabase' && lower.includes('db') && lower.includes('reset')) return R_DB
  if (lower.some(a => a.endsWith('manage.py')) && (lower.includes('flush') || lower.includes('reset_db'))) return R_DB

  if (cmd === 'docker' || cmd === 'podman' || cmd === 'docker-compose') return classifyDocker(cmd, args)

  // Kapatma
  if (['stop-computer', 'restart-computer', 'reboot', 'poweroff', 'halt'].includes(cmd)) return R_SHUTDOWN
  if (cmd === 'shutdown') return lower.some(a => a === '/a' || a === '-a' || a === '-c') ? null : R_SHUTDOWN
  if (cmd === 'init' && (lower[0] === '0' || lower[0] === '6')) return R_SHUTDOWN
  if (cmd === 'systemctl' && lower.some(a => ['poweroff', 'reboot', 'halt', 'kexec'].includes(a))) return R_SHUTDOWN

  // Kurtarma imkânını yok edenler
  if (cmd === 'clear-recyclebin') return R_RECYCLE
  if ((cmd === 'vssadmin' || cmd === 'wbadmin') && lower.includes('delete')) return R_BACKUP
  if (cmd === 'bcdedit' && lower.includes('/delete')) return R_DISK
  if (cmd === 'robocopy' && lower.some(a => a === '/mir' || a === '/purge')) {
    const dest = args.filter(a => !a.startsWith('/'))[1]
    if (dest && isCriticalPath(normalizePath(dest).path)) return R_DELETE(dest)
  }
  return null
}

const SQL_DANGER = [
  /\bdrop\s+(database|schema|table|collection|keyspace)\b/i,
  /\btruncate\s+(table\s+)?[`"[\w]/i,
  /\bdelete\s+from\s+[\w.`"[\]]+\s*(;|$|"|'|\))/i,
  /\bdropDatabase\s*\(/i,
  /\.drop\s*\(\s*\)/,
  /\bflush(all|db)\b/i,
]

function hasDbClient(segs: Segment[]): boolean {
  return segs.some(seg => seg.words.some(w => DB_CLIENTS.has(baseName(w))))
}

// "$(...)" içeriklerini iç içe parantezleri sayarak çıkarır.
function substitutions(s: string): string[] {
  const found: string[] = []
  let i = s.indexOf('$(')
  while (i >= 0) {
    let depth = 1
    let j = i + 2
    for (; j < s.length && depth > 0; j++) {
      if (s[j] === '(') depth++
      else if (s[j] === ')') depth--
    }
    found.push(s.slice(i + 2, depth === 0 ? j - 1 : s.length))
    i = s.indexOf('$(', j)
  }
  return found
}

const PS_ARG = `("[^"]*"|'[^']*'|[^\\s()"']+)`
const JOIN_PATH = new RegExp(
  `\\$?\\(\\s*join-path\\s+(?:-path\\s+)?${PS_ARG}\\s+(?:-childpath\\s+)?${PS_ARG}((?:\\s+${PS_ARG})*)\\s*\\)`,
  'gi',
)

// "(Join-Path $env:USERPROFILE Documents)" -> "$env:USERPROFILE/Documents": hedef görünür olur.
function inlineJoinPath(text: string): string {
  const unq = (a: string) => a.replace(/^["']|["']$/g, '')
  for (let k = 0; k < 5; k++) {
    const next = text.replace(JOIN_PATH, (_m, base: string, child: string, more: string) => {
      const extra = (more.match(new RegExp(PS_ARG, 'g')) ?? []).map(unq)
      return `"${[unq(base), unq(child), ...extra].join('/')}"`
    })
    if (next === text) break
    text = next
  }
  return text
}

const PS_DELETE_AT = /(^|[;|&({\n]\s*)(remove-item|ri|rm|rmdir|rd|del|erase)(?=\s)/gi
const RISKY_SUBEXPR =
  /\$env:(userprofile|home|homedrive|homepath|systemdrive|onedrive\w*|appdata|localappdata|windir|systemroot|programfiles|programdata)\b|\$\{env:|\$home\b|(^|[\s"'(,])~(?=[\\/"'\s)]|$)|getfolderpath|specialfolder|getenvironmentvariable|(^|[\s"'(])[a-z]:[\\/]?(?=["'\s)]|$)/i

/**
 * PowerShell: "Remove-Item -Recurse (<ifade>)" hedefi ancak çalışınca belli olur.
 * İfade ev klasörüne, özel klasöre ya da bir sürücü köküne dayanıyorsa
 * tehlikeli sayılır (emin olunamayınca durdur).
 */
function psSubexpressionDeletion(text: string): string | null {
  for (const m of text.matchAll(PS_DELETE_AT)) {
    const from = m.index! + m[0].length
    let depth = 0
    let quote = ''
    let flat = ''
    const groups: string[] = []
    let group = ''
    let j = from
    for (; j < text.length; j++) {
      const c = text[j]!
      if (quote) {
        if (c === quote) quote = ''
        if (depth > 0) group += c
        else flat += c
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === '(') {
        depth++
        if (depth === 1) {
          group = ''
          continue
        }
      } else if (c === ')') {
        if (depth === 0) break
        depth--
        if (depth === 0) {
          groups.push(group)
          flat += ' ( ) '
          continue
        }
      } else if (depth === 0 && (c === ';' || c === '|' || c === '\n')) break
      if (depth > 0) group += c
      else flat += c
    }
    if (!groups.length) continue
    const recursive = flat.split(/\s+/).some(w => isRecursiveFlag(w.replace(/["']/g, '')))
    if (!recursive) continue
    const risky = groups.find(g => RISKY_SUBEXPR.test(g))
    if (risky !== undefined) return R_DELETE(`(${risky.trim()})`)
  }
  return null
}

/**
 * Bir kabuk komutunu sınıflandırır: geri dönüşsüz bir zarar verebiliyorsa kısa
 * Türkçe sebep, değilse null. Saf fonksiyondur; Bash ve PowerShell araçları için.
 */
export function classifyCommand(command: string, shell: Shell = 'bash', depth = 0): string | null {
  if (typeof command !== 'string' || depth > 4) return null
  let text = command.trim()
  if (!text) return null

  if (shell === 'powershell') {
    text = inlineJoinPath(text)
    const sub = psSubexpressionDeletion(text)
    if (sub) return sub
  }

  const tokens = tokenize(text, shell)
  const segs = segmentsOf(tokens)
  for (const seg of segs) {
    const r = classifySegment(seg, shell, depth)
    if (r) return r
  }

  // Tırnak içindeki komut yerleştirmeleri: "$(...)" ve `...`.
  // Tırnaklı heredoc gövdesi düz veridir, taranmaz.
  for (const tok of tokens) {
    if (tok.op || tok.heredoc?.quoted) continue
    for (const inner of substitutions(tok.t)) {
      const r = classifyCommand(inner, shell, depth + 1)
      if (r) return r
    }
    if (shell === 'bash') {
      for (const m of tok.t.matchAll(/`([^`]*)`/g)) {
        const r = classifyCommand(m[1]!, shell, depth + 1)
        if (r) return r
      }
    }
  }

  if (hasDbClient(segs)) {
    const sql = text.replace(/\btruncate\s+-/gi, '')
    if (SQL_DANGER.some(re => re.test(sql))) return R_DB
  }
  return null
}

const DC_START = 'mcp__plugin_desktop-commander_desktop-commander__start_process'
const DC_INTERACT = 'mcp__plugin_desktop-commander_desktop-commander__interact_with_process'

function shellFromName(name: unknown): Shell[] | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const b = baseName(name.trim().split(/\s+/)[0]!)
  if (b === 'cmd') return ['cmd']
  if (b === 'powershell' || b === 'pwsh') return ['powershell']
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'wsl', 'git-bash'].includes(b)) return ['bash']
  return null
}

/**
 * Araç çağrısından komutu ve onu okuyacak kabukları çıkarır; kabuk komutu
 * çalıştırmayan bir araçsa null. Bash ve PowerShell'in yanında Monitor,
 * Desktop Commander ve Terminal paneli de komut çalıştırır; girdisinde metin
 * bir `command` alanı olan bilinmeyen araçlar her iki kabukla okunur.
 */
export function shellCommandOf(tool: string, input: unknown): { command: string; shells: Shell[] } | null {
  const rec = (input ?? {}) as Record<string, unknown>
  if (typeof rec !== 'object') return null
  if (tool === DC_INTERACT) {
    return typeof rec.input === 'string' ? { command: rec.input, shells: ['powershell', 'bash'] } : null
  }
  const command = rec.command
  if (typeof command !== 'string') return null
  if (tool === 'Bash' || tool === 'Monitor') return { command, shells: ['bash'] }
  if (tool === 'PowerShell') return { command, shells: ['powershell'] }
  if (tool === DC_START) return { command, shells: shellFromName(rec.shell) ?? ['powershell'] }
  if (tool === 'mcp__terminal__run_in_terminal') return { command, shells: ['powershell'] }
  return { command, shells: ['powershell', 'bash'] }
}

/** Komutu araç girdisinden okur ve sınıflandırır. */
export function classifyToolCall(tool: string, input: unknown): string | null {
  const found = shellCommandOf(tool, input)
  if (!found) return null
  for (const shell of found.shells) {
    const r = classifyCommand(found.command, shell)
    if (r) return r
  }
  return null
}

/** Kullanıcının mesajı "onaylıyorum" içeriyor mu (ı/i, İ/I farkı gözetmez). */
export function saysApproval(text: string): boolean {
  const folded = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
  return folded.includes('onayliyorum') || /\bi approve\b/.test(folded)
}

/** Bir komut için kısa, kararlı onay kodu (4 rakam). */
export function approvalCode(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
  return String(1000 + (h % 9000))
}

/**
 * Kullanıcının mesajı hangi bekleyen komutu onaylıyor: mesajda bir komutun
 * kodu geçiyorsa yalnız o; kod yoksa ve bekleyen tek komut varsa o; aksi halde hiçbiri.
 */
export function approvedKey(text: string, pending: ReadonlyMap<string, string>): string | null {
  if (!saysApproval(text)) return null
  const digits = new Set(text.match(/\d{4}/g) ?? [])
  const named = [...pending].filter(([, code]) => digits.has(code))
  if (named.length === 1) return named[0]![0]
  if (named.length > 1 || digits.size > 0) return null
  return pending.size === 1 ? [...pending.keys()][0]! : null
}

// Claude'un okuduğu ret metni (İngilizce); kullanıcıya Türkçe anlatmasını ister.
export function denyMessage(reason: string, code: string): string {
  return [
    `Blocked by the piksel-maskot danger guard: this command looks irreversible (${reason}).`,
    'Do not run it, and do not try another command, script or tool that does the same thing.',
    'Stop now. Explain the risk to the user in plain, simple words in the language they write in: what would be lost and that it cannot be undone.',
    `Then wait. If the user still wants it, ask them to type "I approve ${code}" (or "onaylıyorum ${code}") in their next message;`,
    'after that, this exact command may run once within 10 minutes. You cannot approve it yourself.',
    'If it is still blocked after the user typed that, do not retry it or work around it: tell the user',
    'that the guard keeps it blocked and that they can run the command themselves if they are sure.',
  ].join(' ')
}

// İzin penceresinde kullanıcının gördüğü metin (Türkçe).
export function askMessage(reason: string): string {
  return `Warning, dangerous command: ${reason}. This cannot be undone. If you are not sure, do not allow it.`
}

// Kullanıcının kendi yazdığı mesaj mı: Claude, eklentiler ve başka oturumlar sayılmaz.
// 'sdk': masaüstü uygulaması motoru SDK yoluyla sürer; kullanıcının yazdığı mesaj
// büyük olasılıkla bu kökenle gelir. Claude'un araç girdileri hiçbir zaman prompt.submit olmaz.
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

// Alarm animasyonu ~1,6 sn; maskot 0,7 sn'de bir okur. İzin penceresinin "bekliyor"
// durumu alarm bitene kadar yazılmaz, yoksa bekleme alarmı bastırır.
const ALARM_HOLD_MS = 2600

type Guard = {
  // Kullanıcının son mesajından beri engellenen komutlar ve onay kodları.
  pending: Map<string, string>
  pendingAt: number
  // Onaylanmış, bir kez çalışabilecek komutlar ve onay anları.
  approved: Map<string, number>
  // Aynı çağrı için alarm bir kez çalar.
  alarmed: Set<string>
  // Alarm çalan araç adı -> izin penceresinin "bekliyor" yazımının ertelendiği son an.
  alarmHold: Map<string, number>
}

function reasonOf(tool: string, input: unknown): { key: string; reason: string } | null {
  const found = shellCommandOf(tool, input)
  const reason = found ? classifyToolCall(tool, input) : null
  return found && reason ? { key: `${tool}\u0000${found.command.trim()}`, reason } : null
}

export const register: Register = on => {
  const s: Status = {
    turns: new Set(),
    asks: new Set(),
    event: null,
    eventId: 0,
    eventAt: 0,
    mainStartedAt: 0,
  }
  const g: Guard = { pending: new Map(), pendingAt: 0, approved: new Map(), alarmed: new Set(), alarmHold: new Map() }
  // İzin penceresi açık ama "bekliyor" yazımı alarm bitene kadar ertelenmiş araçlar.
  const heldAsks = new Set<string>()

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
    if (e.agentId === undefined) {
      s.event = null
      s.mainStartedAt = await $.clock.now()
    }
    await publish($, s)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    s.turns.delete(e.turnId)
    if (s.turns.size === 0) {
      s.asks.clear()
      heldAsks.clear()
    }

    const isLong = (await $.clock.now()) - s.mainStartedAt >= LONG_TURN_MS
    const raised =
      e.agentId !== undefined || e.reason === 'aborted'
        ? undefined
        : e.reason === 'answer'
          ? isLong
            ? 'done'
            : undefined
          : 'error'

    await publish($, s, raised)

    return next(e)
  })

  // Tehlike bekçisi. Kişi sorulabiliyorsa motorun kendi izin penceresi açılır
  // (eklentinin sorusu: hiçbir kural ya da sınıflandırıcı onu kendiliğinden geçemez).
  // Sorulamıyorsa reddedilir; kullanıcı "onaylıyorum" yazarsa aynı komut bir kez geçer.
  on('tool.check', async ($, e, next) => {
    const hit = reasonOf(e.tool, e.input)
    if (!hit) return next(e)

    const now = await $.clock.now()
    const approvedAt = g.approved.get(hit.key)
    if (approvedAt !== undefined) {
      g.approved.delete(hit.key)
      if (now - approvedAt <= APPROVAL_MS) return next(e)
    }

    // Sorgu ($.tool.check) değil gerçek bir çağrıysa maskot alarm verir.
    if (e.tool_use_id !== undefined && !g.alarmed.has(e.tool_use_id)) {
      if (g.alarmed.size > 200) g.alarmed.clear()
      g.alarmed.add(e.tool_use_id)
      await publish($, s, 'danger')
      if (e.approver !== undefined) g.alarmHold.set(e.tool, now + ALARM_HOLD_MS)
    }

    if (e.approver !== undefined) return { decision: 'ask', reason: askMessage(hit.reason) }

    // Kullanıcının son mesajından beri engellenenlerin hepsi tutulur; biri ötekinin yerini almaz.
    if (now - g.pendingAt > APPROVAL_MS) g.pending.clear()
    g.pendingAt = now
    const code = approvalCode(hit.key)
    g.pending.set(hit.key, code)
    return { decision: 'deny', reason: denyMessage(hit.reason, code) }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    let hit: { key: string; reason: string } | null = null
    try {
      hit = reasonOf(e.tool, e.input)
    } catch {}
    return hit ? { decision: 'deny', reason: denyMessage(hit.reason, approvalCode(hit.key)) } : next(e)
  })

  // Yalnız kullanıcının kendi yazdığı bir sonraki mesaj onaylayabilir.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (g.pending.size && !e.isMeta && !e.command && USER_ORIGINS.has(e.origin.kind)) {
        const pending = new Map(g.pending)
        g.pending.clear()
        const now = await $.clock.now()
        const key = now - g.pendingAt <= APPROVAL_MS ? approvedKey(e.text, pending) : null
        if (key) g.approved.set(key, now)
      }
    } catch {}

    return next(e)
  }).catch(($, e, next) => next(e))

  // Soru ve plan onayı: araç, kullanıcı cevaplayana kadar bitmez.
  // İzin: aşağıdaki PermissionRequest açar; cevap anı için olay yok, araç bitince kapanır.
  on('tool.call', async ($, e, next) => {
    if (QUESTION_TOOLS.has(e.tool)) {
      s.asks.add(e.tool)
      await publish($, s)
    }

    try {
      return await next(e)
    } finally {
      heldAsks.delete(e.tool)
      if (s.asks.delete(e.tool)) await publish($, s)
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const name = e.tool_name
    const now = await $.clock.now()
    const holdUntil = g.alarmHold.get(name)
    g.alarmHold.delete(name)
    if (holdUntil !== undefined && holdUntil > now) {
      // Bekçinin sorusu: önce alarm oynasın, "bekliyor" sonra yazılsın.
      heldAsks.add(name)
      $.clock.after(holdUntil - now, () => {
        if (!heldAsks.delete(name)) return
        s.asks.add(name)
        void publish($, s)
      })
    } else {
      s.asks.add(name)
      await publish($, s)
    }

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
