"""A transparent robot that stands on the message box of the Claude desktop app."""
import ctypes as C
import ctypes.wintypes as W
import json
import sys
import time
import tkinter as tk
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / 'state'
CONFIG = ROOT / 'position.json'
KEY = '#ff00fe'
W_PX, H_PX = 150, 64
SIDEBAR, HALF_COMPOSER, COMPOSER_FROM_BOTTOM, OVERHANG = 324, 386, 85, 22
STALE_SECONDS = 75
IDLE_MS, WORK_MS = 50, 83

u = C.windll.user32
k = C.windll.kernel32
u.SetProcessDpiAwarenessContext(C.c_void_p(-4))
u.SetWindowLongPtrW.restype = C.c_void_p
u.SetWindowLongPtrW.argtypes = [W.HWND, C.c_int, C.c_void_p]
u.GetWindowLongPtrW.restype = C.c_void_p
u.GetWindowLongPtrW.argtypes = [W.HWND, C.c_int]
u.GetParent.restype = W.HWND
u.GetParent.argtypes = [W.HWND]
GWL_EXSTYLE, GWLP_HWNDPARENT = -20, -8
WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x80, 0x08000000
SWP = 0x0001 | 0x0004 | 0x0010  # NOSIZE | NOZORDER | NOACTIVATE

if not k.CreateMutexW(None, False, 'piksel-maskot-robot') or k.GetLastError() == 183:
    sys.exit(0)


def claude_window():
    found = []
    enum = C.WINFUNCTYPE(C.c_bool, W.HWND, W.LPARAM)

    def visit(h, _):
        if not u.IsWindowVisible(h):
            return True
        cls = C.create_unicode_buffer(64)
        u.GetClassNameW(h, cls, 64)
        if cls.value != 'Chrome_WidgetWin_1':
            return True
        pid = W.DWORD()
        u.GetWindowThreadProcessId(h, C.byref(pid))
        p = k.OpenProcess(0x1000, 0, pid.value)
        if not p:
            return True
        buf = C.create_unicode_buffer(600)
        n = W.DWORD(600)
        k.QueryFullProcessImageNameW(p, 0, buf, C.byref(n))
        k.CloseHandle(p)
        if buf.value.lower().endswith('\\claude.exe'):
            r = W.RECT()
            u.GetWindowRect(h, C.byref(r))
            area = (r.right - r.left) * (r.bottom - r.top)
            if area > 200000:
                found.append((area, h))
        return True

    u.EnumWindows(enum(visit), 0)
    return max(found)[1] if found else None


def is_working():
    now = time.time()
    try:
        for f in STATE_DIR.glob('*.json'):
            if now - f.stat().st_mtime < STALE_SECONDS and json.loads(f.read_text(encoding='utf-8')).get('working'):
                return True
    except (OSError, ValueError):
        pass
    return False


root = tk.Tk()
root.overrideredirect(True)
root.configure(bg=KEY)
root.attributes('-transparentcolor', KEY)
root.geometry(f'{W_PX}x{H_PX}+0+0')
idle_src = [tk.PhotoImage(file=str(p)) for p in sorted((ROOT / 'frames').glob('idle_*.png'))]
work_src = [tk.PhotoImage(file=str(p)) for p in sorted((ROOT / 'frames').glob('work_*.png'))]
frames = {'zoom': 1, 'idle': idle_src, 'work': work_src}
label = tk.Label(root, image=idle_src[0], bd=0, bg=KEY, highlightthickness=0)
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

state = {'owner': None, 'shown': True, 'working': False, 'frame': 0, 'pos': None, 'drag': None, 'scale': 1.0}


def use_scale(h):
    scale = (u.GetDpiForWindow(h) or 96) / 96
    state['scale'] = scale
    zoom = max(1, round(scale))
    if zoom != frames['zoom']:
        frames['zoom'] = zoom
        frames['idle'] = [p.zoom(zoom) for p in idle_src] if zoom > 1 else idle_src
        frames['work'] = [p.zoom(zoom) for p in work_src] if zoom > 1 else work_src
        root.geometry(f'{W_PX * zoom}x{H_PX * zoom}')
        state['pos'] = None


def place():
    h = state['owner']
    r = W.RECT()
    if not h or not u.GetWindowRect(h, C.byref(r)):
        return
    s = state['scale']
    zoom = frames['zoom']
    x = int(r.left + ((r.right - r.left) + SIDEBAR * s) / 2 + (HALF_COMPOSER + OVERHANG) * s - W_PX * zoom) + offset['x']
    y = int(r.bottom - COMPOSER_FROM_BOTTOM * s - H_PX * zoom + 1) + offset['y']
    if state['pos'] != (x, y):
        state['pos'] = (x, y)
        u.SetWindowPos(me, 0, x, y, 0, 0, SWP)


def watch():
    h = claude_window()
    if h != state['owner']:
        state['owner'] = h
        state['pos'] = None
        if h:
            u.SetWindowLongPtrW(me, GWLP_HWNDPARENT, C.c_void_p(h))
    if h:
        use_scale(h)
    visible = bool(h) and not u.IsIconic(h)
    if visible != state['shown']:
        state['shown'] = visible
        if visible:
            root.deiconify()
        else:
            root.withdraw()
        state['pos'] = None
    was = state['working']
    state['working'] = is_working()
    if was != state['working']:
        state['frame'] = 0
    root.after(700, watch)


def tick():
    if state['shown'] and not state['drag']:
        place()
    current = frames['work'] if state['working'] else frames['idle']
    state['frame'] = (state['frame'] + 1) % len(current)
    label.configure(image=current[state['frame']])
    root.after(WORK_MS if state['working'] else IDLE_MS, tick)


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
watch()
tick()
root.mainloop()
