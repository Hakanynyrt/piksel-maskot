import { describe, expect, mock, test } from 'claude-code/testing'
import { approvalCode, approvedKey, classifyCommand, classifyToolCall, saysApproval, type Shell } from './register'

type Row = [command: string, shell: Shell, dangerous: boolean]

const B: Shell = 'bash'
const P: Shell = 'powershell'

const TABLE: Row[] = [
  // --- tehlikeli: özyinelemeli silme
  ['rm -rf /', B, true],
  ['rm -rf ~', B, true],
  ['rm -rf $HOME', B, true],
  ['rm -rf "$HOME/"', B, true],
  ['sudo rm -rf --no-preserve-root /', B, true],
  ['rm -fr /*', B, true],
  ['rm -rf *', B, true],
  ['rm -rf ./*', B, true],
  ['rm -rf .git', B, true],
  ['rm -rf ../project/.git', B, true],
  ['rm -rf ..', B, true],
  ['rm -rf C:\\', B, true],
  ['rm -rf /c/Users/Hakan', B, true],
  ['rm -rf "C:\\Windows\\System32"', B, true],
  ['rm -rf ~/Desktop', B, true],
  ['rm -rf "$BUILD_DIR/"', B, true],
  ['cd /tmp && rm -rf /etc', B, true],
  ['echo hi; RM -RF /usr/lib', B, true],
  ['ls | xargs rm -rf /', B, true],
  ['find / -delete', B, true],
  ['bash -c "rm -rf ~"', B, true],
  ['echo "$(rm -rf /)"', B, true],
  ['cmd /c rd /s /q C:\\', B, true],
  ['cmd.exe /C "del /s /q C:\\Users\\Hakan\\Documents\\*"', B, true],
  ['powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\\Users"', B, true],
  ['Remove-Item -Recurse -Force C:\\', P, true],
  ['Remove-Item -Path "C:\\Program Files" -Recurse -Force', P, true],
  ['Remove-Item $env:USERPROFILE -Recurse -Force', P, true],
  ['Remove-Item -LiteralPath "$HOME\\Documents" -Recurse', P, true],
  ['rm -r -fo D:\\', P, true],
  ['rd /s /q C:\\Windows', P, true],
  ['Get-ChildItem C:\\ | Remove-Item -Recurse -Force', P, true],
  ['Remove-Item .git -Recurse -Force', P, true],
  ['del /q C:\\Windows\\*', P, true],
  // --- tehlikeli: diskler
  ['format C: /q', P, true],
  ['Format-Volume -DriveLetter D', P, true],
  ['diskpart /s wipe.txt', P, true],
  ['sudo mkfs.ext4 /dev/sda1', B, true],
  ['dd if=/dev/zero of=/dev/sda bs=1M', B, true],
  ['cat image.iso > /dev/sdb', B, true],
  // --- tehlikeli: git
  ['git push --force', B, true],
  ['git push -f origin main', B, true],
  ['git push origin +main', B, true],
  ['git push --mirror backup', B, true],
  ['git push origin --delete feature', B, true],
  ['git push origin :feature', B, true],
  ['git reset --hard HEAD~3', B, true],
  ['git -C C:/myproject reset --hard', P, true],
  ['git clean -fdx', B, true],
  ['git clean -fd', B, true],
  ['git branch -D feature/x', B, true],
  ['git checkout -- .', B, true],
  ['git checkout .', P, true],
  ['git restore .', B, true],
  ['git stash clear', B, true],
  ['git add . && git commit -m wip && git push -f', B, true],
  // --- tehlikeli: veritabanı
  ['psql -c "DROP DATABASE shop"', B, true],
  ['mysql -u root -e "drop table users"', B, true],
  ['echo "TRUNCATE TABLE orders;" | psql mydb', B, true],
  ['sqlite3 app.db "DELETE FROM users;"', B, true],
  ['docker exec db psql -U app -c "DROP TABLE logs"', B, true],
  ['dropdb production', B, true],
  ['npx prisma migrate reset --force', B, true],
  ['redis-cli FLUSHALL', B, true],
  ['php artisan migrate:fresh', B, true],
  // --- tehlikeli: docker
  ['docker system prune -a -f', B, true],
  ['docker system prune --all --volumes', B, true],
  ['docker volume rm pgdata', B, true],
  ['docker compose down -v', B, true],
  // --- tehlikeli: kapatma, kayıt defteri, yedekler
  ['Stop-Computer -Force', P, true],
  ['Restart-Computer', P, true],
  ['shutdown /s /t 0', P, true],
  ['sudo shutdown -h now', B, true],
  ['reg delete HKCU\\Software\\App /f', P, true],
  ['Remove-Item -Path HKLM:\\SOFTWARE\\Vendor -Recurse', P, true],
  ['Remove-ItemProperty -Path HKCU:\\Software\\App -Name Key', P, true],
  ['Clear-RecycleBin -Force', P, true],
  ['vssadmin delete shadows /all /quiet', P, true],
  ['robocopy C:\\empty C:\\Users\\Hakan /MIR', P, true],
  // --- kırmızı takım bulguları (düzeltildi)
  ['cmd //c rd /s /q C:\\Users\\Hakan', B, true],
  ['cmd //c "rd /s /q C:\\Users\\Hakan"', B, true],
  ['cmd //c rd /s /q C:\\\\myproject', B, true],
  ['cmd.exe //C "del /s /q C:\\Users\\Hakan\\*"', B, true],
  ['Remove-Item -Recurse -Force ${env:USERPROFILE}', P, true],
  ['Remove-Item -Recurse -Force "${env:USERPROFILE}\\Documents"', P, true],
  ['Remove-Item -Recurse -Force ${env:windir}', P, true],
  ['Remove-Item -Recurse -Force ${env:APPDATA}', P, true],
  ['find . -delete', B, true],
  ['find . -mindepth 1 -delete', B, true],
  ['find . -type f -exec rm -f {} +', B, true],
  ['find -delete', B, true],
  ['Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE "Documents")', P, true],
  ['Remove-Item -Recurse -Force (Join-Path -Path $HOME -ChildPath Desktop)', P, true],
  ['Remove-Item -Recurse -Force ([Environment]::GetFolderPath("Desktop"))', P, true],
  ['Remove-Item -Recurse -Force $(Resolve-Path ~)', P, true],
  ['rm -rf $APPDATA', B, true],
  ['rm -rf "$LOCALAPPDATA"', B, true],
  ['rm -rf ${APPDATA}', B, true],
  ['rm -rf $PROGRAMDATA', B, true],
  ['Remove-Item -Recurse -Force $env:OneDrive', P, true],
  ['rm -rf "$OneDrive"', B, true],
  ['Remove-Item -Recurse -Force $env:HOMEDRIVE\\', P, true],
  ['rmdir /s /q %HOMEDRIVE%\\', P, true],
  ['bash <<EOF\nrm -rf ~\nEOF', B, true],
  ["cat <<'EOF' | sh\ngit push --force\nEOF", B, true],
  ['cat > f.sh <<EOF\necho $(rm -rf /)\nEOF', B, true],

  // --- güvenli: günlük işler
  ['rm -rf node_modules', B, false],
  ['rm -rf dist build .next __pycache__', B, false],
  ['rm -rf ./tmp-something', B, false],
  ['rm -rf ./node_modules/.cache', B, false],
  ['rm file.txt', B, false],
  ['rm -f ./notes.md', B, false],
  ['rm -rf /tmp/build-123', B, false],
  ['rm -rf C:/myproject/dist', B, false],
  ['rm -rf "C:\\Users\\Hakan\\AppData\\Local\\Temp\\claude\\scratch"', B, false],
  ['rm -rf dist/*', B, false],
  ['rm *.log', B, false],
  ['rm -r .git/hooks/pre-commit.sample', B, false],
  ['find . -name "*.pyc" -delete', B, false],
  ['Remove-Item -Recurse -Force node_modules', P, false],
  ['Remove-Item .\\dist -Recurse -Force -ErrorAction SilentlyContinue', P, false],
  ['Remove-Item C:\\myproject\\build -Recurse', P, false],
  ['Remove-Item report.txt', P, false],
  ['rd /s /q build', P, false],
  ['del /s /q *.tmp', P, false],
  ['Get-ChildItem -Recurse -Filter *.log | Remove-Item', P, false],
  ['git push', B, false],
  ['git push origin main', B, false],
  ['git push -u origin feature/x', B, false],
  ['git push --force-with-lease', B, false],
  ['git push --force-with-lease origin main', B, false],
  ['git push origin HEAD:main', B, false],
  ['git reset --soft HEAD~1', B, false],
  ['git reset HEAD file.txt', B, false],
  ['git clean -n', B, false],
  ['git clean -fdn', B, false],
  ['git branch -d merged-branch', B, false],
  ['git checkout -b feature/new', B, false],
  ['git checkout main', B, false],
  ['git restore --staged .', B, false],
  ['git restore src/app.ts', B, false],
  ['git stash pop', B, false],
  ['git status && git diff', B, false],
  ['git commit -m "drop table support, rm -rf docs"', B, false],
  ['git log --oneline -20', P, false],
  ['npm install', B, false],
  ['npm ci && npm test', B, false],
  ['pip install -r requirements.txt', B, false],
  ['npx rimraf dist', B, false],
  ['pytest -q', B, false],
  ['node uretim/animasyon-uret.mjs', B, false],
  ['cat README.md | grep install', B, false],
  ['ls -la ~', B, false],
  ['Get-ChildItem C:\\', P, false],
  ['Get-Content $HOME\\notes.txt', P, false],
  ['echo "rm -rf /"', B, false],
  ['psql -c "SELECT * FROM users"', B, false],
  ['sqlite3 app.db "DELETE FROM users WHERE id = 3;"', B, false],
  ['truncate -s 0 app.log', B, false],
  ['docker system prune -f', B, false],
  ['docker compose down', B, false],
  ['docker volume ls', B, false],
  ['shutdown /a', P, false],
  ['chmod -R 755 ./scripts', B, false],
  ['python -m http.server 8000', B, false],
  // --- güvenli: kırmızı takım sonrası
  ['cmd //c dir', B, false],
  ['Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE "proj\\build")', P, false],
  ['Remove-Item -Recurse -Force (Join-Path $PWD "dist")', P, false],
  ['Remove-Item (Join-Path $env:TEMP "x.txt")', P, false],
  ['rm -rf "$APPDATA/npm-cache/_cacache"', B, false],
  ['find . -name "*.pyc" -type f -exec rm -f {} +', B, false],
  ['find ./build -delete', B, false],
  ['find . -type d -empty -delete', B, false],
  ["cat > cleanup.sh <<'EOF'\n#!/bin/bash\nrm -rf \"$BUILD_DIR/\"\nEOF", B, false],
  ["cat > README.md <<'EOF'\nTo start over run:\ngit reset --hard\nEOF", B, false],
  ["python - <<'EOF'\nprint(\"hello\")\n# shutdown the server\nshutdown = True\nEOF", B, false],
  ["cat <<'EOF' > notes.txt\ndocker compose down -v\nEOF", B, false],
  ["git commit -m \"$(cat <<'EOF'\nAdd danger guard\n\ngit reset --hard is now blocked\nEOF\n)\"", B, false],
  ["git commit -m \"$(cat <<'EOF'\nAdd guard (fixes rm -rf ~)\n\nrm -rf /\nEOF\n)\"", B, false],
  ['cat <<-EOF > x.txt\n\trm -rf ~\n\tEOF\necho ok', B, false],
  ['bash build.sh <<EOF\nrm -rf ~\nEOF', B, false],
]

describe('classifyCommand', () => {
  test('tablo en az 60 komut içerir', () => {
    expect(TABLE.length >= 60).toBe(true)
  })

  for (const [command, shell, dangerous] of TABLE) {
    test(`${dangerous ? 'TEHLİKELİ' : 'güvenli'} [${shell}] ${command}`, () => {
      const reason = classifyCommand(command, shell)
      if (dangerous) expect(typeof reason).toBe('string')
      else expect(reason).toBe(null)
    })
  }

  test('boş ya da metin olmayan girdi', () => {
    expect(classifyCommand('')).toBe(null)
    expect(classifyCommand('   ')).toBe(null)
    expect(classifyCommand(undefined as unknown as string)).toBe(null)
  })
})

describe('classifyToolCall: kabuk çalıştıran tüm araçlar', () => {
  const DC = 'mcp__plugin_desktop-commander_desktop-commander__'
  const CASES: Array<[tool: string, input: unknown, dangerous: boolean]> = [
    ['Bash', { command: 'rm -rf ~' }, true],
    ['PowerShell', { command: 'Remove-Item -Recurse -Force C:\\' }, true],
    ['Monitor', { command: 'rm -rf ~', description: 'x' }, true],
    ['Monitor', { command: 'tail -f app.log', description: 'x' }, false],
    [`${DC}start_process`, { command: 'Remove-Item -Recurse -Force $env:USERPROFILE', timeout_ms: 1 }, true],
    [`${DC}start_process`, { command: 'rd /s /q C:\\Users', shell: 'cmd', timeout_ms: 1 }, true],
    [`${DC}start_process`, { command: 'git push --force', shell: 'bash', timeout_ms: 1 }, true],
    [`${DC}start_process`, { command: 'npm test', timeout_ms: 1 }, false],
    [`${DC}interact_with_process`, { pid: 1, input: 'rm -rf ~' }, true],
    [`${DC}interact_with_process`, { pid: 1, input: 'print(1)' }, false],
    ['mcp__terminal__run_in_terminal', { command: 'Remove-Item -Recurse -Force C:\\Users\\Hakan' }, true],
    ['mcp__terminal__run_in_terminal', { command: 'npm run dev' }, false],
    ['mcp__some_other__exec', { command: 'git reset --hard' }, true],
    ['Read', { file_path: 'C:/x' }, false],
  ]
  for (const [tool, input, dangerous] of CASES) {
    test(`${dangerous ? 'TEHLİKELİ' : 'güvenli'} ${tool} ${JSON.stringify(input)}`, () => {
      const reason = classifyToolCall(tool, input)
      if (dangerous) expect(typeof reason).toBe('string')
      else expect(reason).toBe(null)
    })
  }
})

describe('approvedKey', () => {
  test('tek bekleyen komut kodsuz onaylanır, birden fazlaysa kod gerekir', () => {
    expect(approvedKey('onaylıyorum', new Map([['a', '1234']]))).toBe('a')
    const two = new Map([['a', '1234'], ['b', '5678']])
    expect(approvedKey('onaylıyorum', two)).toBe(null)
    expect(approvedKey('Onaylıyorum 5678', two)).toBe('b')
    expect(approvedKey('onaylıyorum 9999', two)).toBe(null)
    expect(approvedKey('5678', two)).toBe(null)
  })
  test('kod kararlı ve 4 rakam', () => {
    expect(approvalCode('Bash rm -rf ~')).toBe(approvalCode('Bash rm -rf ~'))
    expect(/^\d{4}$/.test(approvalCode('x'))).toBe(true)
  })
})

describe('saysApproval', () => {
  test('Türkçe harf farklarını tolere eder', () => {
    for (const text of ['onaylıyorum', 'Onaylıyorum.', 'ONAYLIYORUM', 'ONAYLİYORUM', 'onayliyorum', 'tamam, onaylıyorum!']) {
      expect(saysApproval(text)).toBe(true)
    }
  })
  test('başka cevapları onay saymaz', () => {
    for (const text of ['onaylamıyorum', 'hayır', 'onay', 'evet']) {
      expect(saysApproval(text)).toBe(false)
    }
  })
})

type Write = { path: string; text: string }

describe('tool.check bekçisi', () => {
  test('kişi sorulabiliyorsa motorun izin penceresi açılır ve maskot alarm verir', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const writes: Write[] = []
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', ($, e) => {
      writes.push(e)
      return { value: undefined }
    })
    on('tool.check', () => ({ decision: 'allow' as const }))

    const verdict = await $.tool.check({
      tool: 'Bash',
      input: { command: 'rm -rf ~' },
      tool_use_id: 'call-1',
      approver: 'person',
    })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason ?? '').toContain('cannot be undone')

    const last = JSON.parse(writes[writes.length - 1]!.text)
    expect(last.event).toBe('danger')
    expect(typeof last.eventId).toBe('number')
    expect(last.at).toBe(1_000_000)

    const safe = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'call-2', approver: 'person' })
    expect(safe.decision).toBe('allow')
  })

  test('sorgu ($.tool.check, çağrı kimliği yok) alarm yazmaz', async ($, on) => {
    mock.clock(on, { now: 5 })
    const writes: Write[] = []
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', ($, e) => {
      writes.push(e)
      return { value: undefined }
    })
    on('tool.check', () => ({ decision: 'allow' as const }))
    const verdict = await $.tool.check({ tool: 'PowerShell', input: { command: 'Remove-Item C:\\ -Recurse -Force' } })
    expect(verdict.decision).toBe('deny')
    expect(writes.length).toBe(0)
  })

  test('sorulamıyorsa reddeder; kullanıcının "onaylıyorum" mesajı aynı komutu bir kez açar', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    const cmd = { tool: 'Bash', input: { command: 'git push --force' } }
    const first = await $.tool.check({ ...cmd, tool_use_id: 'c1' })
    expect(first.decision).toBe('deny')
    expect(first.reason ?? '').toContain('onaylıyorum')

    await $.prompt.submit({ text: 'Tamam, ONAYLIYORUM', wait: false, origin: { kind: 'composer' } })
    await clock.advance(60_000)

    // Başka bir tehlikeli komut açılmaz.
    const other = await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' }, tool_use_id: 'c2' })
    expect(other.decision).toBe('deny')

    const again = await $.tool.check({ ...cmd, tool_use_id: 'c3' })
    expect(again.decision).toBe('allow')

    // Onay tek kullanımlık.
    const third = await $.tool.check({ ...cmd, tool_use_id: 'c4' })
    expect(third.decision).toBe('deny')
  })

  test('iki komut bekliyorsa kodsuz onay hiçbirini açmaz; kodlu onay yalnız o komutu açar', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    const push = { tool: 'Bash', input: { command: 'git push --force' } }
    const wipe = { tool: 'Bash', input: { command: 'rm -rf ~' } }
    expect((await $.tool.check({ ...push, tool_use_id: 'p1' })).decision).toBe('deny')
    expect((await $.tool.check({ ...wipe, tool_use_id: 'w1' })).decision).toBe('deny')
    await $.prompt.submit({ text: 'onaylıyorum', wait: false, origin: { kind: 'composer' } })
    expect((await $.tool.check({ ...push, tool_use_id: 'p2' })).decision).toBe('deny')
    expect((await $.tool.check({ ...wipe, tool_use_id: 'w2' })).decision).toBe('deny')

    // Ret metnindeki kod kullanıcıya gösterilir; kodlu onay yalnız o komutu açar.
    const code = /onaylıyorum (\d{4})/.exec((await $.tool.check({ ...push, tool_use_id: 'p3' })).reason ?? '')![1]!
    await $.prompt.submit({ text: `onaylıyorum ${code}`, wait: false, origin: { kind: 'composer' } })
    expect((await $.tool.check({ ...wipe, tool_use_id: 'w3' })).decision).toBe('deny')
    expect((await $.tool.check({ ...push, tool_use_id: 'p4' })).decision).toBe('allow')
  })

  test('masaüstü uygulamasının mesajı (sdk kökeni) onaylayabilir', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    const cmd = { tool: 'PowerShell', input: { command: 'Remove-Item -Recurse -Force $env:USERPROFILE' } }
    expect((await $.tool.check({ ...cmd, tool_use_id: 'a' })).decision).toBe('deny')
    await $.prompt.submit({ text: 'Onaylıyorum', wait: false, origin: { kind: 'sdk' } })
    expect((await $.tool.check({ ...cmd, tool_use_id: 'b' })).decision).toBe('allow')
  })

  test('izin penceresi açılınca alarm önce oynar, "bekliyor" alarmdan sonra yazılır', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const writes: Array<{ t: number; s: { waiting: boolean; event: string | null; at: number } }> = []
    let now = 1_000_000
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', ($, e) => {
      writes.push({ t: now, s: JSON.parse(e.text) })
      return { value: undefined }
    })
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('classic.PermissionRequest', () => ({}))

    const verdict = await $.tool.check({
      tool: 'Bash', input: { command: 'rm -rf ~' }, tool_use_id: 'call-1', approver: 'person',
    })
    expect(verdict.decision).toBe('ask')
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } })

    // Alarm süresince (1,6 sn + maskotun 0,7 sn okuma aralığı) waiting yazılmaz.
    const danger = writes.find(w => w.s.event === 'danger')!
    expect(danger.s.waiting).toBe(false)
    expect(writes.some(w => w.s.waiting)).toBe(false)
    now += 2_300
    await clock.advance(2_300)
    expect(writes.some(w => w.s.waiting)).toBe(false)
    now += 400
    await clock.advance(400)
    const waitingWrite = writes.find(w => w.s.waiting)!
    expect(waitingWrite.t - danger.s.at >= 2_300).toBe(true)
    // Olay korunur: bekleme bitince 10 sn kuralı geçerlidir, alarm zaten oynamıştır.
    expect(waitingWrite.s.event).toBe('danger')
  })

  test('alarm yokken izin penceresi hemen "bekliyor" yazar', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const writes: Array<{ waiting: boolean }> = []
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', ($, e) => {
      writes.push(JSON.parse(e.text))
      return { value: undefined }
    })
    on('classic.PermissionRequest', () => ({}))
    await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: 'x' } })
    expect(writes[writes.length - 1]!.waiting).toBe(true)
  })

  test('onay 10 dakika sonra geçersiz', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    const cmd = { tool: 'Bash', input: { command: 'git clean -fdx' } }
    expect((await $.tool.check({ ...cmd, tool_use_id: 'a' })).decision).toBe('deny')
    await $.prompt.submit({ text: 'onaylıyorum', wait: false, origin: { kind: 'composer' } })
    await clock.advance(11 * 60 * 1000)
    expect((await $.tool.check({ ...cmd, tool_use_id: 'b' })).decision).toBe('deny')
  })

  test('Claude ya da başka kaynaklar onaylayamaz', async ($, on) => {
    mock.clock(on, { now: 0 })
    on('session.id', () => ({ value: 's1' }))
    on('fs.write', () => ({ value: undefined }))
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    const cmd = { tool: 'Bash', input: { command: 'rm -rf /' } }
    expect((await $.tool.check({ ...cmd, tool_use_id: 'a' })).decision).toBe('deny')
    await $.prompt.submit({ text: 'onaylıyorum', wait: false, origin: { kind: 'peer' } })
    await $.prompt.submit({ text: 'onaylıyorum', wait: false, isMeta: true, origin: { kind: 'composer' } })
    expect((await $.tool.check({ ...cmd, tool_use_id: 'b' })).decision).toBe('deny')

    // Onay olmadan gelen kullanıcı mesajı bekleyen komutu düşürür.
    expect((await $.tool.check({ ...cmd, tool_use_id: 'c' })).decision).toBe('deny')
    await $.prompt.submit({ text: 'hayır, yapma', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'onaylıyorum', wait: false, origin: { kind: 'composer' } })
    expect((await $.tool.check({ ...cmd, tool_use_id: 'd' })).decision).toBe('deny')
  })
})
