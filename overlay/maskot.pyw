"""Claude masaustu penceresinin mesaj kutusu uzerinde duran seffaf maskot.

Secim mantigi (decide, Player, StatusScanner, parse_catalog) Tk ve Win32'ye dokunmaz.
`python maskot.pyw --kontrol` bu mantigi sahte saatle sinar; pencere acmaz, mutex almaz.
"""
import collections
import ctypes as C
import ctypes.wintypes as W
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SELF = Path(__file__).resolve()
ROOT = SELF.parent
FRAMES_DIR = ROOT / 'frames'
STATE_DIR = ROOT / 'state'
CONFIG = ROOT / 'position.json'
LOG = ROOT / 'overlay.log'
KEY = '#ff00fe'
W_PX, H_PX = 150, 64
SIDEBAR, HALF_COMPOSER, COMPOSER_FROM_BOTTOM, OVERHANG = 324, 386, 85, 22
MIN_CLAUDE_AREA = 200000
MUTEX_NAME = 'piksel-maskot-robot'
OFF_SCREEN = -32000          # Claude bulunana kadar pencere gorunmez bir yerde bekler

GROUPS = frozenset(('idle', 'work', 'waiting', 'done', 'error', 'sleep'))
EVENT_GROUPS = frozenset(('done', 'error'))
STALE_MS = 75_000
EVENT_MAX_AGE_MS = 10_000
SLEEP_AFTER_MS = 300_000
IDLE_LOOPS = (2, 4)
MIN_FRAME_MS = 16
LEGACY = (('idle', 50, 'idle'), ('work', 83, 'work'))

POLL_SHOWN_MS = 700          # Claude gorunurken durum dosyalari
POLL_HIDDEN_MS = 1000        # Claude simge durumundayken yalniz pencere kontrolu
POLL_MISSING_MS = 3000       # Claude kapaliyken pencere aramasi
ENUM_EVERY_S = 15            # bulunan pencere varken tam tarama araligi
PURGE_EVERY_S = 3600         # eski durum dosyalarini silme araligi
PURGE_AFTER_MS = 86_400_000  # bu kadar eski durum dosyasi silinir
FOLLOW_ACTIVE_MS = 50        # pencere yeni hareket ettiyse takip adimi
FOLLOW_REST_MS = 250         # pencere dururken en uzun bekleme
FOLLOW_ACTIVE_FOR_MS = 1000
MAX_CACHED_FRAMES = 120
LOG_MAX_BYTES = 32_768

Anim = collections.namedtuple('Anim', 'frames ms group loop')
Decision = collections.namedtuple('Decision', 'state new_event mem')

u = C.windll.user32
k = C.windll.kernel32
k.CreateMutexW.restype = W.HANDLE
u.SetWindowLongPtrW.restype = C.c_void_p
u.SetWindowLongPtrW.argtypes = [W.HWND, C.c_int, C.c_void_p]
u.GetWindowLongPtrW.restype = C.c_void_p
u.GetWindowLongPtrW.argtypes = [W.HWND, C.c_int]
u.GetParent.restype = W.HWND
u.GetParent.argtypes = [W.HWND]
GWL_EXSTYLE, GWLP_HWNDPARENT = -20, -8
WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x80, 0x08000000
SWP = 0x0001 | 0x0004 | 0x0010  # NOSIZE | NOZORDER | NOACTIVATE

_logged_errors = set()
_mutex = None


def log(text):
    if LOG is None:
        return
    try:
        if LOG.exists() and LOG.stat().st_size > LOG_MAX_BYTES:
            LOG.write_bytes(LOG.read_bytes()[-LOG_MAX_BYTES // 2:])
        with LOG.open('a', encoding='utf-8') as f:
            f.write(time.strftime('%H:%M:%S ') + text + '\n')
    except OSError:
        pass


def log_once(text):
    if text not in _logged_errors and len(_logged_errors) < 50:
        _logged_errors.add(text)
        log(text)


# --- Katalog -----------------------------------------------------------------

def frame_path(frames_dir, name, index):
    return Path(frames_dir) / f'{name}_{index:02d}.png'


def parse_catalog(data, frames_dir, on_skip=lambda text: None):
    """animasyonlar.json icerigini dogrular; kareleri eksik olani atlar."""
    entries = data.get('animations') if isinstance(data, dict) else None
    if not isinstance(entries, dict):
        return {}
    catalog = {}
    for name, item in entries.items():
        try:
            frames, ms, group = int(item['frames']), float(item['ms']), item['group']
            loop = bool(item.get('loop', True))
        except (AttributeError, KeyError, TypeError, ValueError):
            on_skip(f'animasyon gecersiz: {name}')
            continue
        if not re.fullmatch(r'[\w-]+', str(name)) or frames < 1 or ms <= 0 or group not in GROUPS:
            on_skip(f'animasyon gecersiz: {name}')
            continue
        if not all(frame_path(frames_dir, name, i).exists() for i in range(frames)):
            on_skip(f'animasyon kareleri eksik: {name}')
            continue
        catalog[name] = Anim(frames, max(MIN_FRAME_MS, int(ms)), group, loop)
    return catalog


def legacy_frame_count(frames_dir, stem):
    count = 0
    while count < 100 and frame_path(frames_dir, stem, count).exists():
        count += 1
    return count


def load_catalog(frames_dir, on_skip=lambda text: None):
    """Katalog yoksa ya da idle/work grubu eksikse eski bos/calisma karelerine doner."""
    try:
        data = json.loads((Path(frames_dir) / 'animasyonlar.json').read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        data = None
    catalog = parse_catalog(data, frames_dir, on_skip)
    groups = {a.group for a in catalog.values()}
    for stem, ms, group in LEGACY:
        if group not in groups:
            count = legacy_frame_count(frames_dir, stem)
            if count:
                catalog[stem] = Anim(count, ms, group, True)
    return catalog


# --- Durum dosyalari ---------------------------------------------------------

def normalize_status(session, mtime_ms, data):
    """Eski {"working": bool} dosyalarinda eksik alanlar false/null sayilir."""
    def number(value):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    event = data.get('event')
    return {
        'id': session,
        'mtime': mtime_ms,
        'working': bool(data.get('working')),
        'waiting': bool(data.get('waiting')),
        'event': event if event in EVENT_GROUPS else None,
        'eventId': number(data.get('eventId')),
        'at': number(data.get('at')),
    }


class StatusScanner:
    """Klasoru tarar; yalniz degisen ve hala gecerli olabilecek dosyalari okur.

    75 sn'den eski dosya acilmaz: working/waiting sayilmaz, olayi da en cok 10 sn gecerlidir.
    Yarim yazilmis dosyada son iyi deger kalir. `newest_ms`, son taramada gorulen en yeni degisiklik.
    """

    def __init__(self, folder):
        self.folder = folder
        self.known = {}
        self.reads = 0
        self.newest_ms = None

    def scan(self, now_ms=None):
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        self.newest_ms = None
        try:
            with os.scandir(self.folder) as it:
                entries = [e for e in it if e.name.endswith('.json')]
        except OSError:
            return [status for _, status in self.known.values()]
        found = {}
        for entry in entries:
            try:
                info = entry.stat()
            except OSError:
                continue
            mtime_ms = info.st_mtime_ns / 1e6
            self.newest_ms = max(self.newest_ms or 0, mtime_ms)
            if now_ms - mtime_ms >= STALE_MS:
                continue
            stamp = (info.st_mtime_ns, info.st_size)
            previous = self.known.get(entry.name)
            if previous and previous[0] == stamp:
                found[entry.name] = previous
                continue
            try:
                self.reads += 1
                data = json.loads(Path(entry.path).read_text(encoding='utf-8-sig'))
                if not isinstance(data, dict):
                    raise ValueError
            except (OSError, ValueError):
                if previous:
                    found[entry.name] = previous
                continue
            session = entry.name[:-len('.json')]
            found[entry.name] = (stamp, normalize_status(session, mtime_ms, data))
        self.known = found
        return [status for _, status in found.values()]


def purge_old_status(folder, now_ms):
    """Uzun suredir yazilmamis oturum dosyalarini siler; silinen dosya sayisini doner."""
    removed = 0
    try:
        with os.scandir(folder) as it:
            entries = [e for e in it if e.name.endswith('.json') and e.is_file()]
    except OSError:
        return 0
    for entry in entries:
        try:
            if now_ms - entry.stat().st_mtime_ns / 1e6 >= PURGE_AFTER_MS:
                os.unlink(entry.path)
                removed += 1
        except OSError:
            continue
    return removed


# --- Saf secim mantigi -------------------------------------------------------

def new_memory(now_ms):
    return {'seen': {}, 'oneshot': None, 'last_active': now_ms}


def finish_event(mem):
    """Oynayan done/error animasyonu bittiginde cagrilir."""
    return {**mem, 'oneshot': None}


def restored_memory(mem, newest_ms, now_ms):
    """Claude yeniden gorununce: gizliyken yazilan durumlar da etkinlik sayilir."""
    if newest_ms is None:
        return mem
    return {**mem, 'last_active': max(mem['last_active'], min(newest_ms, now_ms))}


def decide(statuses, now_ms, mem, groups=GROUPS):
    """Oncelik: waiting > tek seferlik done/error > working > (5 dk sonra sleep) > idle.

    Saf fonksiyondur: saat, durumlar ve hafiza disaridan gelir, yeni hafiza Decision icinde doner.
    `groups` katalogda animasyonu bulunan gruplardir; olmayan grup atlanir.
    """
    live = [s for s in statuses if now_ms - s['mtime'] < STALE_MS]
    waiting = any(s['waiting'] for s in live)
    working = any(s['working'] for s in live)
    show_waiting = waiting and 'waiting' in groups

    seen = {s['id']: mem['seen'][s['id']] for s in statuses if s['id'] in mem['seen']}
    fresh = []
    for s in statuses:
        if s['event'] is None or s['eventId'] is None or seen.get(s['id']) == s['eventId']:
            continue
        if s['at'] is not None and abs(now_ms - s['at']) <= EVENT_MAX_AGE_MS:
            fresh.append(s)
        else:
            seen[s['id']] = s['eventId']  # suresi gecti, bir daha bakilmaz

    oneshot, new_event = mem['oneshot'], False
    if show_waiting:
        oneshot = None  # taze olaylar isaretlenmez: bekleme 10 sn icinde biterse yine oynar
    elif fresh:
        for s in fresh:
            seen[s['id']] = s['eventId']
        newest = max(fresh, key=lambda s: s['at'])
        if newest['event'] in groups:
            oneshot, new_event = newest['event'], True

    last_active = now_ms if (waiting or working or fresh or oneshot) else mem['last_active']
    if show_waiting:
        state = 'waiting'
    elif oneshot:
        state = oneshot
    elif working and 'work' in groups:
        state = 'work'
    elif now_ms - last_active >= SLEEP_AFTER_MS and 'sleep' in groups:
        state = 'sleep'
    else:
        state = 'idle'
    return Decision(state, new_event, {'seen': seen, 'oneshot': oneshot, 'last_active': last_active})


class Player:
    """Hangi animasyonun hangi karesinde olundugunu tutar; Tk bilmez."""

    def __init__(self, catalog, rng):
        self.catalog, self.rng = catalog, rng
        self.names = {}
        for name, anim in catalog.items():
            self.names.setdefault(anim.group, []).append(name)
        self.group = self.name = None
        self.index = 0
        self.loops_left = 0

    def _start(self):
        names = self.names[self.group]
        self.name = self.rng.choice([n for n in names if n != self.name] or names)
        self.index = 0
        self.loops_left = self.rng.randint(*IDLE_LOOPS)

    def enter(self, group, restart=False):
        if group == self.group and not restart:
            return False
        self.group = group
        self._start()
        self.index = -1  # ilk step() 0. kareyi verir
        return True

    def step(self):
        """Bir kare ilerler. Tek seferlik olay son karesini bitirince True doner."""
        anim = self.catalog[self.name]
        if self.index + 1 < anim.frames:
            self.index += 1
            return False
        if self.group in EVENT_GROUPS:
            return True
        if self.group == 'idle':
            self.loops_left -= 1
            if not anim.loop or self.loops_left <= 0:
                self._start()
                return False
        if anim.loop:
            self.index = 0
        return False  # loop olmayan animasyon son karesinde bekler


class FrameCache:
    """Kareleri ilk gosterimde yukler, en uzun suredir kullanilmayan animasyonlari birakir."""

    def __init__(self, loader, frames_dir, limit=MAX_CACHED_FRAMES):
        self.loader, self.frames_dir, self.limit = loader, frames_dir, limit
        self.items = collections.OrderedDict()
        self.count = 0

    def get(self, name, index):
        frames = self.items.setdefault(name, {})
        self.items.move_to_end(name)
        if index not in frames:
            try:
                frames[index] = self.loader(str(frame_path(self.frames_dir, name, index)))
            except Exception as error:
                log_once(f'kare yuklenemedi: {name}_{index:02d}: {error}')
                return None
            self.count += 1
            self._trim()
        return frames[index]

    def _trim(self):
        while self.count > self.limit and len(self.items) > 1:
            _, dropped = self.items.popitem(last=False)
            self.count -= len(dropped)

    def clear(self):
        self.items.clear()
        self.count = 0


# --- Win32 yardimcilari ------------------------------------------------------

def claude_window():
    found = []
    enum = C.WINFUNCTYPE(C.c_bool, W.HWND, W.LPARAM)
    is_claude = {}

    def claude_pid(pid):
        if pid not in is_claude:
            is_claude[pid] = False
            p = k.OpenProcess(0x1000, 0, pid)
            if p:
                buf = C.create_unicode_buffer(600)
                n = W.DWORD(600)
                k.QueryFullProcessImageNameW(p, 0, buf, C.byref(n))
                k.CloseHandle(p)
                name = buf.value.lower()
                is_claude[pid] = name.endswith('\\claude.exe')
        return is_claude[pid]

    def visit(h, _):
        if not u.IsWindowVisible(h):
            return True
        r = W.RECT()
        u.GetWindowRect(h, C.byref(r))
        area = (r.right - r.left) * (r.bottom - r.top)
        if area <= MIN_CLAUDE_AREA:
            return True
        cls = C.create_unicode_buffer(64)
        u.GetClassNameW(h, cls, 64)
        if cls.value != 'Chrome_WidgetWin_1':
            return True
        pid = W.DWORD()
        u.GetWindowThreadProcessId(h, C.byref(pid))
        if claude_pid(pid.value):
            found.append((area, h))
        return True

    u.EnumWindows(enum(visit), 0)
    return max(found)[1] if found else None


def window_pid(h):
    pid = W.DWORD()
    u.GetWindowThreadProcessId(h, C.byref(pid))
    return pid.value


def owner_status(h, pid):
    """Tum pencereleri taramadan, bilinen pencerenin halini soyler: gone / hidden / shown."""
    if not h or not u.IsWindow(h) or window_pid(h) != pid:
        return 'gone'
    if u.IsIconic(h) or not u.IsWindowVisible(h):
        return 'hidden'
    r = W.RECT()
    if not u.GetWindowRect(h, C.byref(r)):
        return 'gone'
    return 'shown' if (r.right - r.left) * (r.bottom - r.top) > MIN_CLAUDE_AREA else 'gone'


def relaunch():
    """Pencere olu: mutex birakilir, ayni betik yeni surec olarak baslar, bu surec biter.

    Claude penceresi kapaninca Windows ona bagli maskot penceresini de yok eder; Tk bunu geri getiremez.
    Yeni surec baslatilamazsa False doner, sonraki kontrolde yeniden denenir.
    """
    global _mutex
    if _mutex:
        k.CloseHandle(W.HANDLE(_mutex))
        _mutex = None
    try:
        subprocess.Popen([sys.executable, str(SELF)], cwd=str(ROOT))
    except OSError as error:
        log_once(f'yeniden baslatilamadi: {error!r}')
        return False
    log('pencere yok oldu, yeniden baslatiliyor')
    os._exit(0)


# --- Pencere -----------------------------------------------------------------

def run_overlay():
    import tkinter as tk

    catalog = load_catalog(FRAMES_DIR, log_once)
    if not any(a.group == 'idle' for a in catalog.values()):
        log('bos animasyon karesi yok, cikiliyor')
        return

    root = tk.Tk()
    root.overrideredirect(True)
    root.configure(bg=KEY)
    root.attributes('-transparentcolor', KEY)
    root.geometry(f'{W_PX}x{H_PX}+{OFF_SCREEN}+{OFF_SCREEN}')

    view = {'zoom': 1, 'scale': 1.0}

    def load_frame(path):
        image = tk.PhotoImage(file=path)
        return image.zoom(view['zoom']) if view['zoom'] > 1 else image

    cache = FrameCache(load_frame, FRAMES_DIR)
    player = Player(catalog, random.Random())
    groups = frozenset(a.group for a in catalog.values())
    scanner = StatusScanner(STATE_DIR)
    player.enter('idle')
    player.step()
    first = cache.get(player.name, player.index)

    label = tk.Label(root, image=first, bd=0, bg=KEY, highlightthickness=0)
    label.pack()
    root.update()
    me = u.GetParent(root.winfo_id()) or root.winfo_id()
    ex = int(u.GetWindowLongPtrW(me, GWL_EXSTYLE) or 0)
    u.SetWindowLongPtrW(me, GWL_EXSTYLE, C.c_void_p(ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE))

    offset = {'x': 0, 'y': 0}
    try:
        offset.update(json.loads(CONFIG.read_text(encoding='utf-8')))
    except (OSError, ValueError):
        pass

    state = {
        'owner': None, 'owner_pid': 0, 'next_enum': 0.0, 'shown': True, 'pos': None, 'drag': None,
        'tick': None, 'next_frame': 0.0, 'moved_at': 0.0, 'img': first, 'statuses': [],
        'mem': new_memory(time.time() * 1000), 'current': 'idle', 'next_purge': 0.0,
    }

    def place():
        h = state['owner']
        r = W.RECT()
        if not h or not u.GetWindowRect(h, C.byref(r)):
            return False
        scale = (u.GetDpiForWindow(h) or 96) / 96
        zoom = max(1, round(scale))
        view['scale'] = scale
        if zoom != view['zoom']:
            view['zoom'] = zoom
            cache.clear()
            root.geometry(f'{W_PX * zoom}x{H_PX * zoom}')
            state['next_frame'] = 0.0
        width = r.right - r.left
        x = int(r.left + (width + SIDEBAR * scale) / 2 + (HALF_COMPOSER + OVERHANG) * scale - W_PX * zoom) + offset['x']
        y = int(r.bottom - COMPOSER_FROM_BOTTOM * scale - H_PX * zoom + 1) + offset['y']
        if state['pos'] == (x, y):
            return False
        state['pos'] = (x, y)
        u.SetWindowPos(me, 0, x, y, 0, 0, SWP)
        return True

    def apply_statuses(statuses):
        state['statuses'] = statuses
        result = decide(statuses, time.time() * 1000, state['mem'], groups)
        state['mem'] = result.mem
        if player.enter(result.state, restart=result.new_event):
            state['next_frame'] = 0.0
        if result.state != state['current']:
            state['current'] = result.state
            log(f'durum={result.state}')

    def tick_step():
        now = time.monotonic() * 1000
        if not state['drag'] and place():
            state['moved_at'] = now
        if now >= state['next_frame']:
            if player.step():
                state['mem'] = finish_event(state['mem'])
                apply_statuses(state['statuses'])
                player.step()
            image = cache.get(player.name, player.index)
            if image is not None and image is not state['img']:
                label.configure(image=image)
                state['img'] = image
            state['next_frame'] = now + catalog[player.name].ms
        moving = now - state['moved_at'] < FOLLOW_ACTIVE_FOR_MS
        return max(1, int(min(state['next_frame'] - now, FOLLOW_ACTIVE_MS if moving else FOLLOW_REST_MS)))

    def tick():
        delay = FOLLOW_REST_MS
        try:
            delay = tick_step()
        except Exception as error:
            log_once(f'tick hatasi: {error!r}')
        state['tick'] = root.after(delay, tick)

    def set_shown(visible):
        state['shown'] = visible
        state['pos'] = None
        if visible:
            statuses = scanner.scan()
            state['mem'] = restored_memory(state['mem'], scanner.newest_ms, time.time() * 1000)
            apply_statuses(statuses)
            root.deiconify()
            state['next_frame'] = 0.0
            if state['tick'] is None:
                tick()
        else:
            state['mem'] = finish_event(state['mem'])  # yarim kalan olay geri donunce surmesin
            root.withdraw()
            if state['tick'] is not None:
                root.after_cancel(state['tick'])
                state['tick'] = None
            cache.clear()

    def watch_step():
        if not u.IsWindow(me):
            relaunch()
            return POLL_MISSING_MS
        now = time.monotonic()
        if now >= state['next_purge']:
            state['next_purge'] = now + PURGE_EVERY_S
            removed = purge_old_status(STATE_DIR, time.time() * 1000)
            if removed:
                log(f'eski durum dosyasi silindi: {removed}')
        status = owner_status(state['owner'], state['owner_pid'])
        if status == 'gone' or now >= state['next_enum']:
            state['next_enum'] = now + ENUM_EVERY_S
            h = claude_window()
            if h and h != state['owner']:
                state['owner'], state['owner_pid'], state['pos'] = h, window_pid(h), None
                u.SetWindowLongPtrW(me, GWLP_HWNDPARENT, C.c_void_p(h))
                log(f'claude penceresi bulundu: {h}')
            elif not h and status == 'gone':
                state['owner'] = None
            status = owner_status(state['owner'], state['owner_pid'])
        visible = status == 'shown'
        if visible != state['shown']:
            set_shown(visible)
        if not visible:
            return POLL_MISSING_MS if status == 'gone' else POLL_HIDDEN_MS
        apply_statuses(scanner.scan())
        return POLL_SHOWN_MS

    def watch():
        delay = POLL_MISSING_MS
        try:
            delay = watch_step()
        except Exception as error:
            log_once(f'watch hatasi: {error!r}')
        root.after(delay, watch)

    def start_drag(e):
        state['drag'] = (e.x_root, e.y_root, offset['x'], offset['y'])

    def drag(e):
        d = state['drag']
        if d:
            offset['x'], offset['y'] = d[2] + e.x_root - d[0], d[3] + e.y_root - d[1]
            place()

    def save():
        CONFIG.write_text(json.dumps(offset), encoding='utf-8')

    def stop_drag(_):
        state['drag'] = None
        place()
        save()

    def reset():
        offset.update(x=0, y=0)
        place()
        save()

    menu = tk.Menu(root, tearoff=0)
    menu.add_command(label='Reset position', command=reset)
    menu.add_command(label='Close robot', command=root.destroy)
    label.bind('<ButtonPress-1>', start_drag)
    label.bind('<B1-Motion>', drag)
    label.bind('<ButtonRelease-1>', stop_drag)
    label.bind('<Button-3>', lambda e: menu.tk_popup(e.x_root, e.y_root))
    log('basladi')
    watch()
    if state['shown']:
        tick()
    root.mainloop()


# --- Kontrol modu ------------------------------------------------------------

def kontrol():
    """Sahte saatle secim mantigini sinar. Pencere acmaz, mutex almaz, gercek dosyalara yazmaz."""
    global LOG
    LOG = None
    if sys.stdout:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    failures = []

    def check(title, actual, expected):
        ok = actual == expected
        print(f"{'TAMAM' if ok else 'HATA '}  {title}: {actual!r}" + ('' if ok else f' (beklenen {expected!r})'))
        if not ok:
            failures.append(title)

    NOW = 1_800_000_000_000
    with tempfile.TemporaryDirectory(prefix='maskot-kontrol-') as temp:
        folder = Path(temp) / 'durum'
        folder.mkdir()

        def clean():
            for path in folder.glob('*'):
                path.unlink()

        def write(session, data, age_ms=0, now=NOW):
            path = folder / f'{session}.json'
            path.write_text(data if isinstance(data, str) else json.dumps(data), encoding='utf-8')
            stamp = (now - age_ms) / 1000
            os.utime(path, (stamp, stamp))

        def event(kind, event_id, age_ms=0, now=NOW, **extra):
            return {'working': False, 'waiting': False, 'event': kind, 'eventId': event_id,
                    'at': now - age_ms, **extra}

        def state_of(files, now=NOW, mem=None, groups=GROUPS):
            clean()
            for session, data, age_ms in files:
                write(session, data, age_ms, now)
            return decide(StatusScanner(folder).scan(now), now, mem or new_memory(now), groups)

        print('--- oncelik ---')
        full = {'working': True, 'waiting': True, 'event': 'done', 'eventId': 1, 'at': NOW}
        check('waiting hepsinden once', state_of([('a', full, 0)]).state, 'waiting')
        check('olay working den once', state_of([('a', event('done', 1, working=True), 0)]).state, 'done')
        check('error olayi', state_of([('a', event('error', 1), 0)]).state, 'error')
        check('working idle dan once', state_of([('a', {'working': True}, 0)]).state, 'work')
        check('hic durum yoksa idle', state_of([]).state, 'idle')
        check('oturumlar birlesir',
              state_of([('a', {'working': True}, 0), ('b', {'waiting': True}, 0)]).state, 'waiting')

        print('--- eski ve bozuk dosyalar ---')
        check('eski bicim {working:true}', state_of([('a', {'working': True}, 0)]).state, 'work')
        check('eski bicim {working:false}', state_of([('a', {'working': False}, 0)]).state, 'idle')
        check('bozuk JSON yok sayilir', state_of([('a', '{yarim', 0)]).state, 'idle')
        check('liste JSON yok sayilir', state_of([('a', '[1]', 0)]).state, 'idle')
        check('eventId olmayan olay oynamaz', state_of([('a', {'event': 'done', 'at': NOW}, 0)]).state, 'idle')
        check('bilinmeyen olay oynamaz', state_of([('a', event('patla', 1), 0)]).state, 'idle')

        print('--- bayatlik (75 sn) ---')
        check('working 74.999 sn canli', state_of([('a', {'working': True}, 74_999)]).state, 'work')
        check('working 75 sn bayat', state_of([('a', {'working': True}, 75_000)]).state, 'idle')
        check('waiting 74.999 sn canli', state_of([('a', {'waiting': True}, 74_999)]).state, 'waiting')
        check('waiting 75 sn bayat', state_of([('a', {'waiting': True}, 75_000)]).state, 'idle')

        print('--- olay basina tek oynatma ---')
        one = state_of([('a', event('done', 7), 0)])
        check('yeni olay oynar', (one.state, one.new_event), ('done', True))
        again = decide(StatusScanner(folder).scan(), NOW + 700, finish_event(one.mem))
        check('ayni eventId tekrar oynamaz', (again.state, again.new_event), ('idle', False))
        still = decide(StatusScanner(folder).scan(), NOW + 700, one.mem)
        check('bitene kadar olay surer', (still.state, still.new_event), ('done', False))
        write('a', event('error', 8))
        newer = decide(StatusScanner(folder).scan(), NOW + 800, again.mem)
        check('yeni eventId oynar', (newer.state, newer.new_event), ('error', True))
        check('ayni eventId baska oturumda ayri',
              decide([normalize_status('b', NOW, event('done', 7))], NOW, finish_event(one.mem)).new_event, True)
        two = state_of([('a', event('done', 1, age_ms=3000), 0), ('b', event('error', 2, age_ms=1000), 0)])
        check('ayni anda iki olayda en yenisi', two.state, 'error')
        after_two = decide(StatusScanner(folder).scan(), NOW + 100, finish_event(two.mem))
        check('digeri sonradan oynamaz', after_two.new_event, False)

        print('--- olay yasi (10 sn) ---')
        check('10.000 sn sinirinda oynar', state_of([('a', event('done', 1, age_ms=10_000), 0)]).state, 'done')
        late = state_of([('a', event('done', 1, age_ms=10_001), 0)])
        check('10.001 sn eski oynamaz', late.state, 'idle')
        check('suresi gecen tekrar bakilmaz', late.mem['seen'], {'a': 1})
        check('at olmayan olay oynamaz',
              state_of([('a', {'event': 'done', 'eventId': 1}, 0)]).state, 'idle')

        print('--- waiting ile olay ---')
        held = state_of([('a', full, 0)])
        check('waiting altinda olay harcanmaz', held.mem['seen'], {})
        status = normalize_status('a', NOW, {**full, 'waiting': False})
        released = decide([status], NOW + 5_000, held.mem)
        check('waiting biterse olay oynar', (released.state, released.new_event), ('done', True))
        expired = decide([status], NOW + 10_001, held.mem)
        check('waiting 10 sn asarsa olay kaybolur', (expired.state, expired.new_event), ('work', False))
        playing = state_of([('a', event('done', 1), 0)])
        waiting_now = normalize_status('a', NOW, {**event('done', 1), 'waiting': True})
        broke = decide([waiting_now], NOW + 100, playing.mem)
        check('waiting oynayan olayi keser', (broke.state, broke.mem['oneshot']), ('waiting', None))

        print('--- uyku (5 dk) ---')
        start = new_memory(NOW - 299_999)
        check('299.999 sn sonra idle', decide([], NOW, start).state, 'idle')
        start = new_memory(NOW - 300_000)
        check('300 sn sonra sleep', decide([], NOW, start).state, 'sleep')
        woke = state_of([('a', {'working': True}, 0)], mem=start)
        check('working uyandirir', (woke.state, woke.mem['last_active']), ('work', NOW))
        check('working sonrasi sayac sifir', decide([], NOW + 299_999, woke.mem).state, 'idle')
        check('sonra yine sleep', decide([], NOW + 300_000, woke.mem).state, 'sleep')
        check('bayat dosya uyutmayi engellemez',
              state_of([('a', {'working': True}, 75_000)], mem=start).state, 'sleep')
        evented = state_of([('a', event('done', 1), 0)], mem=start)
        check('olay sayaci sifirlar', (evented.state, evented.mem['last_active']), ('done', NOW))

        print('--- eksik gruplar ---')
        old_groups = frozenset(('idle', 'work'))
        check('waiting karesi yoksa working',
              state_of([('a', {'working': True, 'waiting': True}, 0)], groups=old_groups).state, 'work')
        none = state_of([('a', event('done', 1), 0)], groups=old_groups)
        check('olay karesi yoksa idle ve harcanir', (none.state, none.mem['seen']), ('idle', {'a': 1}))
        check('sleep karesi yoksa idle', decide([], NOW, new_memory(NOW - 300_000), old_groups).state, 'idle')

        print('--- tarayici ---')
        clean()
        write('a', {'working': True}, 0)
        scanner = StatusScanner(folder)
        scanner.scan()
        scanner.scan()
        check('degismeyen dosya bir kez okunur', scanner.reads, 1)
        write('a', '{yarim', 0, NOW + 1000)
        check('yarim dosyada son iyi deger', scanner.scan()[0]['working'], True)
        clean()
        check('silinen dosya unutulur', scanner.scan(), [])
        check('klasor yoksa bos', StatusScanner(Path(temp) / 'yok').scan(), [])

        print('--- eski dosyalar ---')
        clean()
        write('canli', {'working': True}, 74_999)
        write('bayat', {'working': True}, 75_000)
        write('bozuk-bayat', '{yarim', 90_000)
        scanner = StatusScanner(folder)
        check('bayat dosya acilmaz', ([s['id'] for s in scanner.scan(NOW)], scanner.reads), (['canli'], 1))
        check('en yeni degisiklik bayati da gorur', round(scanner.newest_ms), NOW - 74_999)
        write('canli', {'working': True}, 75_000)
        check('bayatlayan dosya unutulur', (scanner.scan(NOW), scanner.known), ([], {}))
        check('en yeni degisiklik yine bilinir', round(scanner.newest_ms), NOW - 75_000)
        clean()
        write('yeni', {'working': False}, 86_399_999)
        write('eski', {'working': False}, 86_400_000)
        (folder / 'dokunma.txt').write_text('x', encoding='utf-8')
        os.utime(folder / 'dokunma.txt', (0, 0))
        check('24 saatlik dosya silinir', purge_old_status(folder, NOW), 1)
        check('yalniz eski json gider', sorted(p.name for p in folder.glob('*')), ['dokunma.txt', 'yeni.json'])
        check('klasor yoksa silme yok', purge_old_status(Path(temp) / 'yok', NOW), 0)
        clean()

        print('--- simge durumundan donus ---')
        hidden_mem = new_memory(NOW - 1_200_000)
        write('a', {'working': False}, 30_000)
        scanner = StatusScanner(folder)
        statuses = scanner.scan(NOW)
        back = restored_memory(hidden_mem, scanner.newest_ms, NOW)
        check('gizliyken biten is uyutmaz', decide(statuses, NOW, back).state, 'idle')
        check('dosya hep eskiyse uyur', decide([], NOW, restored_memory(hidden_mem, NOW - 1_000_000, NOW)).state, 'sleep')
        check('dosya yoksa hafiza ayni', restored_memory(hidden_mem, None, NOW), hidden_mem)
        check('gelecek zaman sayilmaz', restored_memory(hidden_mem, NOW + 5_000, NOW)['last_active'], NOW)
        cut = finish_event(state_of([('a', event('done', 1), 0)]).mem)
        check('gizlenince kesilen olay surmez', decide([], NOW + 3_600_000, cut).state, 'sleep')
        clean()

        print('--- nabiz olayi tazelemez ---')
        beat = {'working': True, 'waiting': True, 'event': 'done', 'eventId': 9, 'at': NOW}
        mem = new_memory(NOW)
        for second in range(0, 301, 30):
            mem = decide([normalize_status('a', NOW + second * 1000, beat)], NOW + second * 1000, mem).mem
        status = normalize_status('a', NOW + 330_000, {**beat, 'waiting': False})
        check('uzun beklemeden sonra eski olay oynamaz', decide([status], NOW + 330_000, mem).state, 'work')

        print('--- katalog ---')
        art = Path(temp) / 'kareler'
        art.mkdir()

        def touch(stem, count):
            for i in range(count):
                frame_path(art, stem, i).write_bytes(b'')

        touch('idle', 3)
        touch('work', 2)
        fallback = load_catalog(art)
        check('json yoksa eski bos/calisma', fallback,
              {'idle': Anim(3, 50, 'idle', True), 'work': Anim(2, 83, 'work', True)})
        touch('selam', 2)
        touch('eksik', 1)
        (art / 'animasyonlar.json').write_text(json.dumps({'animations': {
            'idle': {'frames': 3, 'ms': 50, 'group': 'idle', 'loop': True},
            'work': {'frames': 2, 'ms': 83, 'group': 'work', 'loop': True},
            'selam': {'frames': 2, 'ms': 100, 'group': 'done', 'loop': False},
            'eksik': {'frames': 5, 'ms': 100, 'group': 'error', 'loop': False},
            'grupsuz': {'frames': 1, 'ms': 100, 'group': 'yok', 'loop': False},
            '../kacak': {'frames': 1, 'ms': 100, 'group': 'idle', 'loop': False},
            'bicimsiz': 12,
        }}), encoding='utf-8')
        skipped = []
        parsed = load_catalog(art, skipped.append)
        check('gecerli animasyonlar', sorted(parsed), ['idle', 'selam', 'work'])
        check('atlananlar raporlanir', len(skipped), 4)
        (art / 'animasyonlar.json').write_text('{bozuk', encoding='utf-8')
        check('bozuk json da eski bos/calisma', sorted(load_catalog(art)), ['idle', 'work'])

    print('--- oynatici ---')
    catalog = {
        'a': Anim(2, 50, 'idle', True), 'b': Anim(2, 50, 'idle', True),
        'c': Anim(1, 50, 'idle', False), 'w': Anim(2, 83, 'work', True),
        'd': Anim(3, 50, 'done', True), 's': Anim(2, 200, 'sleep', False),
    }
    player = Player(catalog, random.Random(5))
    player.enter('idle')
    used, previous = set(), None
    for _ in range(600):
        player.step()
        if player.index == 0 and player.name != previous:
            used.add(player.name)
            previous = player.name
    check('idle hepsini gezer', sorted(used), ['a', 'b', 'c'])
    loops = Player({'a': Anim(2, 50, 'idle', True)}, random.Random(1))
    loops.enter('idle')
    check('tek idle varsa o doner', {(loops.step(), loops.name)[1] for _ in range(50)}, {'a'})
    shot = Player(catalog, random.Random(1))
    shot.enter('done')
    check('olay bir kez ve sonuna kadar', [shot.step() for _ in range(4)], [False, False, False, True])
    check('olay ayni grupta yeniden baslar', (shot.enter('done', restart=True), shot.index), (True, -1))
    held_player = Player(catalog, random.Random(1))
    held_player.enter('sleep')
    for _ in range(9):
        held_player.step()
    check('loop:false son karede bekler', held_player.index, 1)
    same = Player(catalog, random.Random(1))
    same.enter('work')
    check('ayni grup yeniden baslamaz', same.enter('work'), False)

    print('--- onbellek ---')
    loaded = []

    def loader(path):
        loaded.append(path)
        return object()

    small = FrameCache(loader, Path('x'), limit=3)
    small.get('a', 0)
    small.get('a', 0)
    check('kare bir kez yuklenir', len(loaded), 1)
    small.get('a', 1)
    small.get('b', 0)
    small.get('b', 1)
    check('sinir asilinca eski animasyon birakilir', (list(small.items), small.count), (['b'], 2))

    def broken(_):
        raise OSError('yok')

    check('bozuk kare None', FrameCache(broken, Path('x')).get('a', 0), None)

    print('--- guvenlik ---')
    check('tkinter hic yuklenmedi', 'tkinter' in sys.modules, False)
    real = load_catalog(FRAMES_DIR)
    print(f'bilgi  gercek katalog: {len(real)} animasyon, gruplar: {sorted({a.group for a in real.values()})}')

    print()
    if failures:
        print(f'{len(failures)} HATA: ' + ', '.join(failures))
        return 1
    print('Tum kontroller gecti.')
    return 0


def main():
    if '--kontrol' in sys.argv[1:]:
        sys.exit(kontrol())
    u.SetProcessDpiAwarenessContext(C.c_void_p(-4))
    global _mutex
    _mutex = k.CreateMutexW(None, False, MUTEX_NAME)
    if not _mutex or k.GetLastError() == 183:
        sys.exit(0)
    run_overlay()


if __name__ == '__main__':
    main()
