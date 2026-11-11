#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Torflix on a Raspberry Pi's console (no desktop, e.g. RetroPie): the TV shell.

It starts Torflix's engine (app/backend.mjs, on the Node in runtime/), draws Browse, title
pages, search, Continue watching and Settings on the TV, and plays through omxplayer, the Pi's
hardware video player. It works with a keyboard or a controller (RetroPie's controller setup).
The engine and this shell talk over the loopback bridge the Android TV app uses (backend.js).

Written for Raspbian Jessie: Python 3.4 and pygame 1.9 on SDL 1.2.
"""
import binascii
import collections
import http.client
import io
import json
import math
import os
import queue
import re
import signal
import subprocess
import threading
import time
import traceback
import xml.etree.ElementTree as ElementTree
from urllib.parse import quote

# Programs we start (omxplayer) get the environment as it was before our SDL settings.
CHILD_ENV = dict(os.environ)
os.environ.setdefault('SDL_NOMOUSE', '1')
import pygame  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.path.join(HERE, 'runtime')
HOME = os.path.expanduser('~')
DATA_DIR = os.environ.get('TORFLIX_DATA') or os.path.join(HOME, '.config', 'torflix')
DOWNLOAD_DIR = os.environ.get('TORFLIX_DOWNLOADS') or os.path.join(HOME, 'Downloads', 'Torflix')
LOG_FILE = os.path.join(DATA_DIR, 'torflix-tv.log')
ES_INPUT = '/opt/retropie/configs/all/emulationstation/es_input.cfg'
FONT_DIR = '/usr/share/fonts/truetype/dejavu'
VERSION = open(os.path.join(HERE, 'app', 'VERSION')).read().strip() if os.path.isfile(os.path.join(HERE, 'app', 'VERSION')) else '?'

W, H = 1280, 720
# Torflix's colours (src/renderer/styles.css).
BG = (20, 20, 20)
SURFACE = (31, 31, 31)
SURFACE_2 = (38, 38, 38)
SURFACE_3 = (48, 48, 48)
TEXT = (255, 255, 255)
MUTED = (179, 179, 179)
DIM = (128, 128, 128)
ACCENT = (229, 9, 20)
GREEN = (70, 211, 105)
YELLOW = (230, 184, 0)

# Rows the Pi cannot play: its decoder stops at 1080p H.264.
HIDDEN_ROWS = ('films-4k',)
POSTER = (144, 216)
CARD_GAP = 18
MARGIN = 64

# omxplayer reads its keys from stdin.
PLAYER_KEYS = {'a': b'p', 'left': b'\x1b[D', 'right': b'\x1b[C', 'up': b'\x1b[A', 'down': b'\x1b[B',
               'b': b'q', 'x': b's', 'y': b'k', 'pageup': b'-', 'pagedown': b'+'}
KEYS = {pygame.K_UP: 'up', pygame.K_DOWN: 'down', pygame.K_LEFT: 'left', pygame.K_RIGHT: 'right',
        pygame.K_RETURN: 'a', pygame.K_KP_ENTER: 'a', pygame.K_ESCAPE: 'b', pygame.K_BACKSPACE: 'b',
        pygame.K_PAGEUP: 'pageup', pygame.K_PAGEDOWN: 'pagedown', pygame.K_TAB: 'x', pygame.K_F1: 'start'}
# RetroPie's names for a controller's buttons (es_input.cfg), as actions here.
ES_ACTIONS = {'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right', 'a': 'a', 'b': 'b', 'x': 'x',
              'y': 'y', 'start': 'start', 'select': 'select', 'leftshoulder': 'pageup', 'rightshoulder': 'pagedown',
              'pageup': 'pageup', 'pagedown': 'pagedown', 'leftanalogup': 'up', 'leftanalogdown': 'down',
              'leftanalogleft': 'left', 'leftanalogright': 'right'}
# Used for a controller RetroPie has not set up: d-pad or first stick, first buttons as A, B, X, Y.
GENERIC_PAD = [('hat', 0, 1, 'up'), ('hat', 0, 4, 'down'), ('hat', 0, 8, 'left'), ('hat', 0, 2, 'right'),
               ('axis', 1, -1, 'up'), ('axis', 1, 1, 'down'), ('axis', 0, -1, 'left'), ('axis', 0, 1, 'right'),
               ('button', 0, 1, 'a'), ('button', 1, 1, 'b'), ('button', 2, 1, 'x'), ('button', 3, 1, 'y'),
               ('button', 6, 1, 'select'), ('button', 7, 1, 'start')]
DIRECTIONS = ('up', 'down', 'left', 'right')


def log(message):
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + message + '\n')
    except OSError:
        pass


def fmt_time(secs):
    secs = int(max(0, secs or 0))
    return '%d:%02d:%02d' % (secs // 3600, secs // 60 % 60, secs % 60) if secs >= 3600 else '%d:%02d' % (secs // 60, secs % 60)


def fmt_size(n):
    n = float(n or 0)
    return '%.1f GB' % (n / 1e9) if n >= 1e9 else '%d MB' % (n / 1e6)


def pi_plays(quality):
    """Whether the Pi's hardware decoder plays a copy: H.264 up to 1080p, no HEVC, AV1 or HDR."""
    if not quality:
        return True
    if (quality.get('resolution') or '').lower() in ('2160p', '4k', '1440p'):
        return False
    if (quality.get('codec') or '').lower() in ('x265', 'h265', 'hevc', 'av1', 'vp9'):
        return False
    return not quality.get('hdr')


def pick_copy(page):
    """The copy to play from a title page: the engine's best, or the best the Pi can play."""
    best = page.get('best')
    if best and pi_plays(best.get('quality')):
        return best
    for t in page.get('torrents') or []:
        if pi_plays(t.get('quality')):
            return t
    return best


def copy_line(t):
    q = t.get('quality') or {}
    parts = [q.get('label') or 'Video', '%d seeders' % (t.get('seeders') or 0)]
    if t.get('sizeBytes'):
        parts.append(fmt_size(t['sizeBytes']))
    return ' · '.join(parts)


def episode_label(t):
    if t and t.get('season') is not None and t.get('episode') is not None:
        return 'S%d E%d' % (t['season'], t['episode'])
    return ''


# ---------------------------------------------------------------- the engine

class BridgeError(Exception):
    def __init__(self, kind, message):
        Exception.__init__(self, message)
        self.kind = kind


class Backend(object):
    """Torflix's engine as a child process, and the loopback bridge to it."""

    def __init__(self):
        self.token = binascii.hexlify(os.urandom(16)).decode()
        self.port = None
        self.proc = None
        self.failed = None
        self.events = queue.Queue()
        self.headers = {}
        self.out = None
        self.stopping = False

    def start(self):
        lib = os.path.join(RUNTIME, 'lib')
        # Torflix's Node brings its own C library (musl): started through its loader, it needs
        # nothing from Jessie's, which is too old for any current Node.
        argv = [os.path.join(lib, 'ld-musl-armhf.so.1'), '--library-path', lib, os.path.join(RUNTIME, 'node'),
                '--openssl-legacy-provider', os.path.join(HERE, 'app', 'backend.mjs')]
        env = dict(CHILD_ENV)
        for name in ('LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS'):
            env.pop(name, None)
        env.update(TORFLIX_TOKEN=self.token, TORFLIX_DATA=DATA_DIR, TORFLIX_DOWNLOADS=DOWNLOAD_DIR,
                   NODE_ICU_DATA=os.path.join(RUNTIME, 'icu'), SSL_CERT_FILE=os.path.join(RUNTIME, 'cert.pem'),
                   OPENSSL_MODULES=os.path.join(RUNTIME, 'ossl-modules'))
        self.out = open(os.path.join(DATA_DIR, 'backend.log'), 'w')
        self.proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=self.out)
        threading.Thread(target=self._read_output, daemon=True).start()

    def _read_output(self):
        for raw in iter(self.proc.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').rstrip()
            m = re.match(r'TORFLIX_READY (\{.*\})', line)
            if m and self.port is None:
                port = json.loads(m.group(1))['port']
                self.headers = {'Cookie': 'tp=' + self.token, 'Host': '127.0.0.1:%d' % port}
                self.port = port
                threading.Thread(target=self._read_events, daemon=True).start()
            try:
                self.out.write(line + '\n')
                self.out.flush()
            except (OSError, ValueError):
                pass
        code = self.proc.wait()
        if not self.stopping:
            self.failed = 'The Torflix engine stopped (exit code %s). Its log is %s.' % (
                code, os.path.join(DATA_DIR, 'backend.log'))
            log(self.failed)

    def rpc(self, name, *args):
        if not self.port:
            raise BridgeError('notReady', 'The engine is still starting.')
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=180)
        try:
            headers = dict(self.headers)
            headers['Content-Type'] = 'application/json'
            c.request('POST', '/rpc/' + name, json.dumps(list(args)).encode('utf-8'), headers)
            r = c.getresponse()
            data = r.read()
            if r.status != 200:
                raise BridgeError('bridge', 'The engine answered %d.' % r.status)
            out = json.loads(data.decode('utf-8'))
        finally:
            c.close()
        if not out.get('ok'):
            error = out.get('error') or {}
            raise BridgeError(error.get('kind') or 'internal', error.get('message') or 'Something went wrong.')
        return out.get('value')

    def image(self, url):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=60)
        try:
            c.request('GET', '/image?url=' + quote(url, safe=''), headers=self.headers)
            r = c.getresponse()
            data = r.read()
            return data if r.status == 200 else None
        finally:
            c.close()

    def _read_events(self):
        while self.proc.poll() is None:
            try:
                c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=90)
                c.request('GET', '/events', headers=self.headers)
                r = c.getresponse()
                if r.status != 200:
                    raise BridgeError('bridge', 'events: %d' % r.status)
                buf = b''
                for chunk in self._chunks(r):
                    buf += chunk
                    while b'\n\n' in buf:
                        block, buf = buf.split(b'\n\n', 1)
                        data = [line[6:] for line in block.split(b'\n') if line.startswith(b'data: ')]
                        if data:
                            message = json.loads(b'\n'.join(data).decode('utf-8'))
                            self.events.put((message.get('name'), message.get('payload')))
            except Exception as e:  # noqa: BLE001 - reconnect on anything
                if self.proc.poll() is None and not self.stopping:
                    log('events: %r' % e)
            time.sleep(1)

    @staticmethod
    def _chunks(r):
        """The body of a chunked response, chunk by chunk (http.client would read it byte by byte)."""
        fp = r.fp
        while True:
            line = fp.readline()
            if not line:
                return
            size = int(line.split(b';')[0].strip() or b'0', 16)
            if size == 0:
                return
            data = fp.read(size)
            fp.read(2)
            yield data

    def stop(self):
        self.stopping = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=25)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Tasks(object):
    """Runs engine calls and picture loads off the main thread; their results come back to it."""

    def __init__(self):
        self.done = queue.Queue()

    def run(self, fn, args, then=None, fail=None):
        def work():
            try:
                result = (True, fn(*args))
            except Exception as e:  # noqa: BLE001 - handed to `fail`
                result = (False, e)
            self.done.put((result, then, fail))
        threading.Thread(target=work, daemon=True).start()

    def dispatch(self):
        while True:
            try:
                (ok, value), then, fail = self.done.get_nowait()
            except queue.Empty:
                return
            try:
                if ok:
                    if then:
                        then(value)
                elif fail:
                    fail(value)
                else:
                    log('task failed: %r' % value)
            except Exception:  # noqa: BLE001 - a broken callback must not end the app
                log('callback failed: ' + traceback.format_exc())


def fit_surface(img, size, cover=True):
    """A copy of `img` scaled to fill `size` (cropped to it) or to fit inside it."""
    w, h = size
    iw, ih = img.get_size()
    if not iw or not ih:
        return None
    if img.get_bitsize() not in (24, 32):
        full = pygame.Surface((iw, ih), 0, 32)
        full.blit(img, (0, 0))
        img = full
    scale = max(float(w) / iw, float(h) / ih) if cover else min(float(w) / iw, float(h) / ih)
    nw, nh = max(1, int(iw * scale + 0.5)), max(1, int(ih * scale + 0.5))
    scaled = pygame.transform.smoothscale(img, (nw, nh))
    if not cover:
        return scaled
    out = pygame.Surface((w, h), 0, 32)
    out.blit(scaled, ((w - nw) // 2, (h - nh) // 2))
    return out


class Pictures(object):
    """Posters and backdrops through the engine, decoded and scaled in two worker threads."""
    LIMIT = 260

    def __init__(self, app):
        self.app = app
        self.cache = collections.OrderedDict()
        self.pending = set()
        self.jobs = queue.Queue()
        for _ in range(2):
            threading.Thread(target=self._work, daemon=True).start()

    def get(self, url, size, cover=True):
        """The picture at this size, or None until it has loaded (the screen redraws then)."""
        if not url:
            return None
        key = (url, size, cover)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key] or None
        if key not in self.pending:
            self.pending.add(key)
            self.jobs.put(key)
        return None

    def _work(self):
        while True:
            key = self.jobs.get()
            surface = None
            try:
                data = self.app.backend.image(key[0])
                if data:
                    surface = fit_surface(pygame.image.load(io.BytesIO(data), 'picture.jpg'), key[1], key[2])
            except Exception as e:  # noqa: BLE001 - a picture that fails is left out
                log('picture %s: %r' % (key[0], e))
            self.app.tasks.done.put(((True, (key, surface)), self._loaded, None))

    def _loaded(self, result):
        key, surface = result
        self.pending.discard(key)
        self.cache[key] = surface.convert() if surface else False
        while len(self.cache) > self.LIMIT:
            self.cache.popitem(last=False)
        self.app.dirty = True


class Fonts(object):
    def __init__(self):
        self.fonts = {}
        self.rendered = collections.OrderedDict()
        self.fitted = {}

    def font(self, size, bold=False):
        key = (size, bold)
        if key not in self.fonts:
            path = os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')
            self.fonts[key] = pygame.font.Font(path if os.path.isfile(path) else None, size)
        return self.fonts[key]

    def render(self, text, size, color, bold=False):
        key = (text, size, color, bold)
        surface = self.rendered.get(key)
        if surface is None:
            surface = self.font(size, bold).render(text, True, color)
            self.rendered[key] = surface
            if len(self.rendered) > 2000:
                self.rendered.popitem(last=False)
        return surface

    def fit(self, text, size, width, bold=False):
        """`text`, cut short with an ellipsis to fit `width` pixels."""
        key = (text, size, width, bold)
        if key in self.fitted:
            return self.fitted[key]
        font = self.font(size, bold)
        out = text
        if font.size(text)[0] > width:
            while out and font.size(out + '…')[0] > width:
                out = out[:-1]
            out = out.rstrip() + '…'
        if len(self.fitted) > 4000:
            self.fitted.clear()
        self.fitted[key] = out
        return out

    def wrap(self, text, size, width, max_lines, bold=False):
        font = self.font(size, bold)
        words = (text or '').split()
        lines, line = [], ''
        for i, word in enumerate(words):
            candidate = (line + ' ' + word).strip()
            if font.size(candidate)[0] <= width:
                line = candidate
                continue
            if line:
                lines.append(line)
            line = word
            if len(lines) == max_lines:
                lines[-1] = self.fit(lines[-1] + ' ' + ' '.join(words[i:]), size, width, bold)
                return lines
        if line:
            lines.append(line)
        if len(lines) > max_lines:
            lines = lines[:max_lines - 1] + [' '.join(lines[max_lines - 1:])]
        # A word wider than the line is cut short too.
        return [self.fit(l, size, width, bold) for l in lines]


class Controls(object):
    """Controllers, with RetroPie's mapping of each (es_input.cfg) or a generic one."""

    def __init__(self):
        self.sticks = []
        self.binds = []
        self.axes = {}
        self.held = None
        self.next_repeat = 0
        try:
            pygame.joystick.init()
            known = self._es_mappings()
            for i in range(pygame.joystick.get_count()):
                stick = pygame.joystick.Joystick(i)
                stick.init()
                self.sticks.append(stick)
                self.binds.append(known.get(stick.get_name()) or GENERIC_PAD)
                log('controller %d: %s (%s)' % (i, stick.get_name(), 'RetroPie mapping' if stick.get_name() in known else 'generic'))
        except pygame.error as e:
            log('controllers: %s' % e)

    @staticmethod
    def _es_mappings():
        out = {}
        try:
            root = ElementTree.parse(ES_INPUT).getroot()
        except (OSError, ElementTree.ParseError):
            return out
        for cfg in root.findall('inputConfig'):
            if cfg.get('type') != 'joystick':
                continue
            binds = []
            for item in cfg.findall('input'):
                action = ES_ACTIONS.get(item.get('name'))
                if action:
                    try:
                        binds.append((item.get('type'), int(item.get('id')), int(item.get('value')), action))
                    except (TypeError, ValueError):
                        pass
            out[cfg.get('deviceName')] = binds
        return out

    def action(self, event):
        """The action a controller event starts, or None (releases and repeats are handled here)."""
        if event.joy >= len(self.binds):
            return None
        binds = self.binds[event.joy]
        if event.type == pygame.JOYBUTTONDOWN:
            for kind, index, value, action in binds:
                if kind == 'button' and index == event.button:
                    return self._press(action)
        elif event.type == pygame.JOYBUTTONUP:
            self.held = None
        elif event.type == pygame.JOYHATMOTION:
            x, y = event.value
            mask = (1 if y > 0 else 4 if y < 0 else 0) | (2 if x > 0 else 8 if x < 0 else 0)
            if not mask:
                self.held = None
            for kind, index, value, action in binds:
                if kind == 'hat' and index == event.hat and mask & value:
                    return self._press(action)
        elif event.type == pygame.JOYAXISMOTION:
            direction = 1 if event.value > 0.6 else -1 if event.value < -0.6 else 0
            key = (event.joy, event.axis)
            if direction == self.axes.get(key, 0):
                return None
            self.axes[key] = direction
            if not direction:
                self.held = None
                return None
            for kind, index, value, action in binds:
                if kind == 'axis' and index == event.axis and (value > 0) == (direction > 0):
                    return self._press(action)
        return None

    def _press(self, action):
        self.held = action if action in DIRECTIONS else None
        self.next_repeat = time.time() + 0.45
        return action

    def repeat(self):
        """A held direction, again, once it has been held long enough."""
        if self.held and time.time() >= self.next_repeat:
            self.next_repeat = time.time() + 0.11
            return self.held
        return None


# ---------------------------------------------------------------- screens

class Screen(object):
    """One page of the app. `animating` keeps redrawing while something moves on it."""
    animating = False
    text_input = False

    def __init__(self, app):
        self.app = app
        self.closed = False

    def enter(self):
        pass

    def resume(self):
        pass

    def leave(self):
        pass

    def on_action(self, action):
        if action == 'b':
            self.app.pop()

    def on_text(self, char):
        pass

    def on_event(self, name, payload):
        pass

    def tick(self):
        pass

    def draw(self, s):
        pass

    def call(self, name, args, then=None, fail=None):
        """An engine command whose answer reaches this screen only while it is open."""
        def done(value):
            if not self.closed and then:
                then(value)

        def failed(error):
            log('%s failed: %s' % (name, error))
            if not self.closed and fail:
                fail(error)
        self.app.tasks.run(self.app.backend.rpc, (name,) + tuple(args), done, failed)


def draw_header(app, s, crumb=''):
    app.text(s, 'TORFLIX', MARGIN, 26, 30, ACCENT, True)
    if crumb:
        app.text(s, crumb, MARGIN + 170, 34, 20, MUTED)


def draw_hints(app, s, hints, y=H - 40):
    x = W - MARGIN
    for key, label in reversed(hints):
        text = app.fonts.render(label, 16, MUTED)
        x -= text.get_width()
        s.blit(text, (x, y))
        badge = app.fonts.render(key, 15, TEXT, True)
        bw = badge.get_width() + 14
        x -= bw + 8
        pygame.draw.rect(s, SURFACE_3, (x, y - 3, bw, 24))
        s.blit(badge, (x + 7, y - 1))
        x -= 26


def draw_focus(s, rect, width=4):
    pygame.draw.rect(s, TEXT, rect.inflate(width * 2, width * 2), width)


def draw_button(app, s, x, y, label, focused, primary=False):
    text = app.fonts.render(label, 22, (0, 0, 0) if focused else TEXT, True)
    rect = pygame.Rect(x, y, text.get_width() + 48, 52)
    pygame.draw.rect(s, TEXT if focused else (ACCENT if primary else SURFACE_3), rect)
    s.blit(text, (x + 24, y + 13))
    return rect.right + 16


def draw_spinner(s, cx, cy, r=18):
    t = time.time() * 6
    for i in range(8):
        a = t + i * 0.785
        shade = 70 + 23 * i
        pygame.draw.circle(s, (shade, shade, shade), (int(cx + r * math.cos(a)), int(cy + r * math.sin(a))), 4)


class BrowseScreen(Screen):
    """Rows of what performs best on the swarm, with the focused title shown large above them."""
    animating = False

    def __init__(self, app):
        Screen.__init__(self, app)
        self.rows = []
        self.row = 0
        self.cols = {}
        self.nav = [('Search', lambda: app.push(SearchScreen(app))),
                    ('Continue watching', lambda: app.push(LibraryScreen(app))),
                    ('Settings', lambda: app.push(SettingsScreen(app)))]
        self.nav_col = 0
        self.loading = True
        self.error = None

    def enter(self):
        self.load()

    def resume(self):
        self.call('browseVisible', [True])

    def leave(self):
        self.call('browseVisible', [False])

    def load(self, refresh=False):
        self.loading = True
        self.call('browseRows', [{'refresh': refresh}], self.got_rows, self.failed)
        self.call('browseVisible', [True])

    def failed(self, error):
        self.loading = False
        self.error = str(error)
        self.app.dirty = True

    def got_rows(self, value):
        if not value:
            return
        focused = self.focused()
        rows = [r for r in value.get('rows') or [] if r.get('id') not in HIDDEN_ROWS and r.get('items')]
        self.rows = rows
        self.loading = False
        self.error = value.get('error') if not rows else None
        if value.get('disabled'):
            self.error = 'Browse is turned off in Settings.'
        # Keep the focus on the same title when rows are rebuilt.
        if focused:
            for ri, row in enumerate(rows):
                for ci, item in enumerate(row['items']):
                    if item.get('key') == focused.get('key'):
                        self.row, self.cols[row['id']] = ri, ci
        self.row = min(self.row, len(rows) - 1) if rows else 0
        self.app.dirty = True

    def on_event(self, name, payload):
        if name == 'browse-rows':
            self.got_rows(payload)
        elif name == 'title-meta' and payload:
            for row in self.rows:
                for item in row['items']:
                    if item.get('key') == payload.get('key'):
                        item['meta'] = payload.get('meta')
            self.app.dirty = True

    def col(self, row=None):
        row = self.row if row is None else row
        if not self.rows or row < 0:
            return 0
        return min(self.cols.get(self.rows[row]['id'], 0), len(self.rows[row]['items']) - 1)

    def focused(self):
        if self.row < 0 or not self.rows:
            return None
        return self.rows[self.row]['items'][self.col()]

    def shown(self):
        if not self.rows:
            return None
        row = max(self.row, 0)
        return self.rows[row]['items'][self.col(row)]

    def on_action(self, action):
        if action == 'b':
            self.app.push(QuitScreen(self.app))
        elif action == 'start':
            self.app.push(SettingsScreen(self.app))
        elif action == 'x':
            self.app.push(SearchScreen(self.app))
        elif self.row < 0:
            if action == 'left':
                self.nav_col = max(0, self.nav_col - 1)
            elif action == 'right':
                self.nav_col = min(len(self.nav) - 1, self.nav_col + 1)
            elif action == 'down' and self.rows:
                self.row = 0
            elif action == 'a':
                self.nav[self.nav_col][1]()
        elif action == 'up':
            self.row -= 1
        elif action == 'down':
            self.row = min(len(self.rows) - 1, self.row + 1)
        elif action in ('left', 'right', 'pageup', 'pagedown') and self.rows:
            step = {'left': -1, 'right': 1, 'pageup': -6, 'pagedown': 6}[action]
            row = self.rows[self.row]
            self.cols[row['id']] = max(0, min(len(row['items']) - 1, self.col() + step))
        elif action == 'a' and self.focused():
            self.app.push(TitleScreen(self.app, self.focused()))
        elif action == 'a' and not self.rows and not self.loading:
            self.load(refresh=True)
        self.app.dirty = True

    def draw(self, s):
        app = self.app
        item = self.shown()
        meta = (item or {}).get('meta') or {}
        # The focused title, large, with its picture behind the right side.
        art = app.pictures.get(meta.get('backdrop') or meta.get('image'), (860, 400))
        if art:
            s.blit(art, (W - 860, 0))
            s.blit(app.fade_left, (W - 860, 0))
            s.blit(app.fade_down, (W - 860, 400 - app.fade_down.get_height()))
        draw_header(app, s)
        x = 0
        for i, (label, _) in enumerate(self.nav):
            focused = self.row < 0 and i == self.nav_col
            text = app.fonts.render(label, 20, (0, 0, 0) if focused else MUTED, focused)
            rx = MARGIN + 220 + x
            if focused:
                pygame.draw.rect(s, TEXT, (rx - 14, 26, text.get_width() + 28, 36))
            s.blit(text, (rx, 33))
            x += text.get_width() + 44
        if item:
            title = meta.get('title') or item.get('title') or ''
            app.text(s, app.fonts.fit(title, 40, 640, True), MARGIN, 104, 40, TEXT, True)
            facts = [str(meta.get('year') or item.get('year') or '')]
            facts.append('Series' if item.get('kind') == 'tv' else 'Film')
            facts += (meta.get('genres') or [])[:3]
            if meta.get('rating'):
                facts.append('★ %s' % meta['rating'])
            app.text(s, '  ·  '.join(f for f in facts if f), MARGIN, 160, 20, MUTED)
            best = item.get('best') or {}
            line = '%d seeders' % (item.get('seeders') or 0)
            if best.get('quality', {}).get('label'):
                line = best['quality']['label'] + '  ·  ' + line
            app.text(s, line, MARGIN, 192, 20, GREEN)
            for i, text in enumerate(app.fonts.wrap(meta.get('overview') or '', 20, 600, 4)):
                app.text(s, text, MARGIN, 236 + i * 28, 20, TEXT)
        if self.loading and not self.rows:
            draw_spinner(s, W // 2, 520)
            app.text(s, 'Finding what the swarm has…', W // 2, 560, 20, MUTED, align='center')
        elif self.error and not self.rows:
            for i, text in enumerate(app.fonts.wrap(self.error, 20, 900, 3)):
                app.text(s, text, MARGIN, 470 + i * 28, 20, YELLOW)
            app.text(s, 'Press A to try again.', MARGIN, 560, 20, MUTED)
        # Two rows: the focused one, and the top of the next.
        top = max(self.row, 0)
        for slot, ri in enumerate(range(top, min(top + 2, len(self.rows)))):
            self.draw_row(s, ri, 390 + slot * 270)
        draw_hints(app, s, [('A', 'Open'), ('X', 'Search'), ('B', 'Quit')], y=36)

    def draw_row(self, s, ri, y):
        app = self.app
        row = self.rows[ri]
        app.text(s, row.get('title') or '', MARGIN, y, 22, TEXT, True)
        col = self.col(ri)
        visible = (W - MARGIN) // (POSTER[0] + CARD_GAP)
        first = max(0, min(col - 2, len(row['items']) - visible)) if ri == self.row else 0
        x = MARGIN
        for ci in range(first, min(len(row['items']), first + visible + 1)):
            item = row['items'][ci]
            rect = pygame.Rect(x, y + 36, POSTER[0], POSTER[1])
            meta = item.get('meta') or {}
            poster = app.pictures.get(meta.get('poster') or meta.get('image'), POSTER)
            if poster:
                s.blit(poster, rect)
            else:
                pygame.draw.rect(s, SURFACE_2, rect)
                for i, text in enumerate(app.fonts.wrap(meta.get('title') or item.get('title') or '', 17, POSTER[0] - 20, 5, True)):
                    app.text(s, text, x + 10, y + 50 + i * 22, 17, TEXT, True)
            if ri == self.row and ci == col:
                draw_focus(s, rect)
            x += POSTER[0] + CARD_GAP


class TitleScreen(Screen):
    """A film or series: its picture, facts and overview; Play, Episodes and other copies."""

    def __init__(self, app, item):
        Screen.__init__(self, app)
        self.item = item
        self.req = {'key': item['key'], 'kind': item.get('kind') or 'movie', 'title': item['title'],
                    'year': item.get('year')}
        self.page = None
        self.error = None
        self.buttons = []
        self.focus = 0
        self.warm = False

    def enter(self):
        self.call('titlePage', [self.req], self.got_page, self.failed)

    def resume(self):
        # Back from playing: the resume point and watched state have changed.
        self.call('titlePage', [self.req], self.got_page)

    def leave(self):
        if self.warm:
            self.call('coolDownTitle', [self.req['key']])

    def failed(self, error):
        self.error = str(error)
        self.app.dirty = True

    def got_page(self, page):
        self.page = page
        self.buttons = []
        resume = (page.get('progress') or {}).get('resume')
        copy = pick_copy(page)
        if resume and resume.get('source'):
            label = 'Resume %s' % fmt_time(resume.get('positionSecs'))
            if episode_label(resume):
                label += ' · ' + episode_label(resume)
            self.buttons.append((label, lambda: self.play_request(resume, resume.get('title'))))
        if copy:
            label = 'Play' + (' ' + episode_label(copy) if episode_label(copy) else '')
            self.buttons.append((label, lambda: self.play_copy(copy)))
        if page.get('kind') == 'tv' and (page.get('info') or {}).get('seasons'):
            self.buttons.append(('Episodes', lambda: self.app.push(EpisodesScreen(self.app, self.req, page))))
        if len(page.get('torrents') or []) > 1:
            self.buttons.append(('Other copies', lambda: self.app.push(CopiesScreen(self.app, page))))
        self.focus = min(self.focus, max(0, len(self.buttons) - 1))
        # Get the copy ready while the viewer reads, as the other apps do (Settings → Playback).
        settings = self.app.settings or {}
        if copy and not self.warm and (settings.get('playback') or {}).get('warmUp', True):
            self.warm = True
            self.call('warmUpTitle', [{'title': self.req, 'link': copy.get('link'), 'infoHash': copy.get('infoHash'),
                                       'pick': {'season': copy['season'], 'episode': copy['episode']}
                                       if copy.get('season') is not None and copy.get('episode') is not None else None}])
        self.app.dirty = True

    def play_copy(self, copy):
        req = {'source': copy.get('link'), 'infoHash': copy.get('infoHash')}
        if copy.get('season') is not None and copy.get('episode') is not None:
            req['pick'] = {'season': copy['season'], 'episode': copy['episode']}
        self.app.push(PlayerScreen(self.app, req, self.title_text(), copy_line(copy)))

    def play_request(self, saved, name):
        req = {'source': saved.get('source'), 'infoHash': saved.get('infoHash'), 'fileIndex': saved.get('fileIndex')}
        self.app.push(PlayerScreen(self.app, req, self.title_text(), name or ''))

    def title_text(self):
        info = (self.page or {}).get('info') or {}
        return info.get('title') or self.item.get('title')

    def on_action(self, action):
        if action == 'b':
            self.app.pop()
        elif action == 'left':
            self.focus = max(0, self.focus - 1)
        elif action == 'right':
            self.focus = min(len(self.buttons) - 1, self.focus + 1)
        elif action == 'a' and self.buttons:
            self.buttons[self.focus][1]()
        self.app.dirty = True

    def draw(self, s):
        app = self.app
        info = (self.page or {}).get('info') or self.item.get('meta') or {}
        art = app.pictures.get(info.get('backdrop') or info.get('image'), (W, H))
        if art:
            s.blit(art, (0, 0))
            s.blit(app.dim, (0, 0))
        draw_header(app, s, 'Series' if self.req['kind'] == 'tv' else 'Film')
        poster = app.pictures.get(info.get('poster') or info.get('image'), (260, 390))
        rect = pygame.Rect(MARGIN, 110, 260, 390)
        if poster:
            s.blit(poster, rect)
        else:
            pygame.draw.rect(s, SURFACE_2, rect)
        x = MARGIN + 300
        app.text(s, app.fonts.fit(info.get('title') or self.item['title'], 40, W - x - MARGIN, True), x, 110, 40, TEXT, True)
        facts = [str(info.get('year') or self.item.get('year') or '')]
        if info.get('runtimeMins'):
            facts.append('%d min' % info['runtimeMins'])
        facts += (info.get('genres') or [])[:3]
        if info.get('rating'):
            facts.append('★ %s' % info['rating'])
        if info.get('network'):
            facts.append(info['network'])
        app.text(s, '  ·  '.join(f for f in facts if f), x, 166, 20, MUTED)
        if self.error:
            app.text(s, self.error, x, 220, 20, YELLOW)
        elif not self.page:
            draw_spinner(s, x + 20, 240)
            return
        copy = pick_copy(self.page)
        if copy:
            line = copy_line(copy)
            if not pi_plays(copy.get('quality')):
                line += '  ·  may not play on a Raspberry Pi'
            app.text(s, line, x, 200, 20, GREEN if pi_plays(copy.get('quality')) else YELLOW)
        else:
            app.text(s, 'No copy found on the swarm right now.', x, 200, 20, YELLOW)
        for i, text in enumerate(app.fonts.wrap(info.get('overview') or info.get('description') or '', 21, W - x - MARGIN, 7)):
            app.text(s, text, x, 246 + i * 30, 21, TEXT)
        bx = x
        for i, (label, _) in enumerate(self.buttons):
            bx = draw_button(app, s, bx, 520, label, i == self.focus, i == 0)
        cast = ', '.join(c.get('name') for c in (info.get('cast') or [])[:5] if c.get('name'))
        if cast:
            app.text(s, app.fonts.fit('With ' + cast, 18, W - x - MARGIN), x, 600, 18, DIM)
        draw_hints(app, s, [('A', 'Choose'), ('B', 'Back')])


class ListScreen(Screen):
    """A list to pick from: each entry `(title, detail, tone, on_pick)`."""
    crumb = ''
    empty = 'Nothing here yet.'

    def __init__(self, app):
        Screen.__init__(self, app)
        self.entries = []
        self.focus = 0
        self.loading = False
        self.message = None

    def on_action(self, action):
        if action == 'b':
            self.app.pop()
        elif action in ('up', 'down', 'pageup', 'pagedown') and self.entries:
            step = {'up': -1, 'down': 1, 'pageup': -8, 'pagedown': 8}[action]
            self.focus = max(0, min(len(self.entries) - 1, self.focus + step))
        elif action == 'a' and self.entries:
            self.entries[self.focus][3]()
        else:
            self.other_action(action)
        self.app.dirty = True

    def other_action(self, action):
        pass

    def draw(self, s):
        app = self.app
        draw_header(app, s, self.crumb)
        self.draw_list(s, MARGIN, 100, W - 2 * MARGIN, 10)
        draw_hints(app, s, [('A', 'Choose'), ('B', 'Back')])

    def draw_list(self, s, x, y, width, rows, focused=True):
        app = self.app
        if self.loading:
            draw_spinner(s, x + 20, y + 30)
        if self.message:
            for i, text in enumerate(app.fonts.wrap(self.message, 20, width, 3)):
                app.text(s, text, x + (50 if self.loading else 0), y + 18 + i * 28, 20, MUTED)
            y += 100
        if not self.entries:
            if not self.loading and not self.message:
                app.text(s, self.empty, x, y + 18, 20, MUTED)
            return
        first = max(0, min(self.focus - rows // 2, len(self.entries) - rows))
        for i in range(first, min(len(self.entries), first + rows)):
            title, detail, tone, _ = self.entries[i]
            rect = pygame.Rect(x, y, width, 54)
            on = focused and i == self.focus
            pygame.draw.rect(s, TEXT if on else SURFACE, rect)
            app.text(s, app.fonts.fit(title, 21, width - 40, True), x + 20, y + 6, 21, (0, 0, 0) if on else TEXT, True)
            if detail:
                color = (60, 60, 60) if on else (GREEN if tone == 'ok' else YELLOW if tone == 'warn' else MUTED)
                app.text(s, app.fonts.fit(detail, 16, width - 40), x + 20, y + 32, 16, color)
            y += 60


class CopiesScreen(ListScreen):
    crumb = 'Copies on the swarm'

    def __init__(self, app, page):
        ListScreen.__init__(self, app)
        title = (page.get('info') or {}).get('title') or page.get('title')
        for t in page.get('torrents') or []:
            plays = pi_plays(t.get('quality'))
            detail = copy_line(t) + ('' if plays else '  ·  may not play on a Raspberry Pi')
            self.entries.append((t.get('title') or '', detail, 'ok' if plays else 'warn', self._player(t, title)))

    def _player(self, t, title):
        def play():
            req = {'source': t.get('link'), 'infoHash': t.get('infoHash')}
            if t.get('season') is not None and t.get('episode') is not None:
                req['pick'] = {'season': t['season'], 'episode': t['episode']}
            self.app.push(PlayerScreen(self.app, req, title, copy_line(t)))
        return play


class EpisodesScreen(ListScreen):
    crumb = 'Episodes'

    def __init__(self, app, req, page):
        ListScreen.__init__(self, app)
        self.req = req
        self.page = page
        self.seasons = [s for s in (page.get('info') or {}).get('seasons') or [] if s.get('number') is not None]
        self.season = len(self.seasons) - 1 if self.seasons else 0
        watched = (page.get('progress') or {}).get('episodes') or {}
        self.watched = watched
        self.build()

    def build(self):
        self.entries = []
        if not self.seasons:
            return
        season = self.seasons[self.season]
        number = season['number']
        for e in range(1, (season.get('episodeCount') or 0) + 1):
            state = self.watched.get('%d:%d' % (number, e)) or self.watched.get('s%de%d' % (number, e))
            detail = 'Watched' if state is True or (isinstance(state, dict) and state.get('watched')) else ''
            self.entries.append(('Episode %d' % e, detail, 'ok' if detail else None, self._player(number, e)))
        self.focus = min(self.focus, max(0, len(self.entries) - 1))

    def _player(self, season, episode):
        def find():
            self.loading = True
            self.message = 'Finding season %d, episode %d on the swarm…' % (season, episode)
            self.call('titleEpisode', [self.req, season, episode], lambda v: self._found(v, season, episode), self._missing)
        return find

    def _found(self, value, season, episode):
        self.loading = False
        self.message = None
        if not value or not value.get('source'):
            self._missing(None)
            return
        req = {'source': value['source'], 'infoHash': value.get('infoHash'), 'fileIndex': value.get('fileIndex'),
               'pick': value.get('pick')}
        title = (self.page.get('info') or {}).get('title') or self.req['title']
        self.app.push(PlayerScreen(self.app, req, title, 'S%d E%d · %s' % (season, episode, value.get('title') or '')))

    def _missing(self, error):
        self.loading = False
        self.message = str(error) if error else 'No copy of that episode on the swarm right now.'
        self.app.dirty = True

    def other_action(self, action):
        if action in ('left', 'right') and self.seasons:
            self.season = max(0, min(len(self.seasons) - 1, self.season + (1 if action == 'right' else -1)))
            self.focus = 0
            self.message = None
            self.build()

    def draw(self, s):
        app = self.app
        draw_header(app, s, 'Episodes')
        if self.seasons:
            season = self.seasons[self.season]
            name = season.get('name') or ''
            label = 'Season %d' % season['number'] + ('  ·  ' + name if name and not name.startswith('Season') else '')
            app.text(s, ('◀  ' if self.season > 0 else '    ') + label + ('  ▶' if self.season < len(self.seasons) - 1 else ''),
                     MARGIN, 100, 24, TEXT, True)
        self.draw_list(s, MARGIN, 150, W - 2 * MARGIN, 8)
        draw_hints(app, s, [('◀▶', 'Season'), ('A', 'Play'), ('B', 'Back')])


class LibraryScreen(ListScreen):
    crumb = 'Continue watching'
    empty = 'Nothing watched yet. What you play shows up here, to pick up where you left off.'

    def enter(self):
        self.loading = True
        self.call('libraryItems', [], self.got)

    resume = enter

    def got(self, items):
        self.loading = False
        self.entries = []
        for it in sorted(items or [], key=lambda i: -(i.get('updatedAtSecs') or 0)):
            done = it.get('completed') or (it.get('durationSecs') and (it.get('positionSecs') or 0) >= it['durationSecs'] - 60)
            if it.get('durationSecs'):
                detail = 'Watched' if done else '%s of %s' % (fmt_time(it.get('positionSecs')), fmt_time(it['durationSecs']))
            else:
                detail = ''
            self.entries.append((it.get('title') or it.get('torrentName') or '', detail, 'ok' if done else None, self._player(it)))
        self.focus = min(self.focus, max(0, len(self.entries) - 1))
        self.app.dirty = True

    def _player(self, it):
        def play():
            req = {'source': it.get('source'), 'infoHash': it.get('infoHash'), 'fileIndex': it.get('fileIndex')}
            self.app.push(PlayerScreen(self.app, req, it.get('title') or it.get('torrentName') or '', it.get('torrentName') or ''))
        return play


KEYBOARD = ['abcdefghi', 'jklmnopqr', 'stuvwxyz0', '123456789']


class SearchScreen(Screen):
    """Type a title (a keyboard, or the on-screen one with a controller); results play directly."""
    text_input = True
    animating = True

    def __init__(self, app):
        Screen.__init__(self, app)
        self.query = ''
        self.zone = 'keys'
        self.kx = self.ky = 0
        self.results = []
        self.focus = 0
        self.search_id = None
        self.status = 'Type what you want to watch.'
        self.searching = False

    def leave(self):
        if self.searching:
            self.call('cancelSearch', [])

    def run(self):
        if not self.query.strip():
            return
        self.results = []
        self.focus = 0
        self.searching = True
        self.status = 'Searching…'
        self.call('searchTorrents', [self.query.strip()], self.started, self.failed)

    def started(self, search_id):
        self.search_id = search_id

    def failed(self, error):
        self.searching = False
        self.status = str(error)
        self.app.dirty = True

    def on_event(self, name, payload):
        if name != 'search-progress' or not payload or payload.get('searchId') != self.search_id:
            return
        progress = payload.get('progress') or {}
        response = progress.get('response') or {}
        self.results = response.get('results') or []
        if progress.get('done'):
            self.searching = False
            if progress.get('error') and not self.results:
                self.status = progress['error']
            else:
                self.status = '%d results' % len(self.results) if self.results else 'Nothing found.'
            if self.results and self.zone == 'keys':
                self.zone = 'results'
        else:
            self.status = 'Searching… %d of %d sources' % (progress.get('completed') or 0, progress.get('total') or 0)
        self.focus = min(self.focus, max(0, len(self.results) - 1))
        self.app.dirty = True

    def keys(self):
        rows = [list(r) for r in KEYBOARD] + [['space', 'delete', 'search']]
        return rows

    def on_text(self, char):
        if char in ('\r', '\n'):
            self.run()
        elif char == '\x08':
            self.query = self.query[:-1]
        elif char.isprintable() and len(self.query) < 80:
            self.query += char
        self.app.dirty = True

    def on_action(self, action):
        rows = self.keys()
        if action == 'b':
            self.app.pop()
        elif action == 'y':
            self.query = self.query[:-1]
        elif action == 'start':
            self.run()
        elif self.zone == 'keys':
            if action == 'up':
                self.ky = max(0, self.ky - 1)
            elif action == 'down':
                self.ky = min(len(rows) - 1, self.ky + 1)
            elif action == 'left':
                self.kx = max(0, self.kx - 1)
            elif action == 'right':
                if self.kx >= len(rows[self.ky]) - 1 and self.results:
                    self.zone = 'results'
                else:
                    self.kx = min(len(rows[self.ky]) - 1, self.kx + 1)
            elif action == 'a':
                key = rows[self.ky][min(self.kx, len(rows[self.ky]) - 1)]
                if key == 'space':
                    self.query += ' '
                elif key == 'delete':
                    self.query = self.query[:-1]
                elif key == 'search':
                    self.run()
                else:
                    self.query += key
            self.kx = min(self.kx, len(rows[self.ky]) - 1)
        else:
            if action == 'left':
                self.zone = 'keys'
            elif action in ('up', 'down', 'pageup', 'pagedown'):
                step = {'up': -1, 'down': 1, 'pageup': -6, 'pagedown': 6}[action]
                self.focus = max(0, min(len(self.results) - 1, self.focus + step))
            elif action == 'a' and self.results:
                r = self.results[self.focus]
                self.app.push(PlayerScreen(self.app, {'source': r.get('link'), 'infoHash': r.get('infoHash')},
                                           r.get('title') or '', copy_line(r)))
        self.app.dirty = True

    def draw(self, s):
        app = self.app
        draw_header(app, s, 'Search')
        box = pygame.Rect(MARGIN, 96, 430, 56)
        pygame.draw.rect(s, SURFACE_2, box)
        caret = '|' if int(time.time() * 2) % 2 == 0 else ''
        app.text(s, app.fonts.fit(self.query, 26, 380) + caret, MARGIN + 18, 108, 26, TEXT)
        rows = self.keys()
        for y, row in enumerate(rows):
            x = MARGIN
            for i, key in enumerate(row):
                wide = len(key) > 1
                kw = 136 if wide else 40
                rect = pygame.Rect(x, 176 + y * 54, kw, 46)
                on = self.zone == 'keys' and y == self.ky and i == self.kx
                pygame.draw.rect(s, TEXT if on else SURFACE_2, rect)
                label = app.fonts.render(key, 20 if wide else 22, (0, 0, 0) if on else TEXT, True)
                s.blit(label, (rect.centerx - label.get_width() // 2, rect.centery - label.get_height() // 2))
                x += kw + 7
        app.text(s, 'A keyboard works too: type, then Enter.', MARGIN, 470, 17, DIM)
        rx = MARGIN + 470
        if self.searching:
            draw_spinner(s, rx + 18, 120)
        app.text(s, self.status, rx + (46 if self.searching else 0), 108, 20, MUTED)
        y = 150
        first = max(0, min(self.focus - 4, len(self.results) - 8))
        for i in range(first, min(len(self.results), first + 8)):
            r = self.results[i]
            on = self.zone == 'results' and i == self.focus
            rect = pygame.Rect(rx, y, W - MARGIN - rx, 56)
            pygame.draw.rect(s, TEXT if on else SURFACE, rect)
            title = ('★ ' if r.get('bestPick') else '') + (r.get('title') or '')
            app.text(s, app.fonts.fit(title, 19, rect.width - 30, True), rx + 14, y + 6, 19, (0, 0, 0) if on else TEXT, True)
            plays = pi_plays(r.get('quality'))
            detail = copy_line(r) + ('' if plays else '  ·  may not play on a Raspberry Pi')
            color = (60, 60, 60) if on else (GREEN if plays else YELLOW)
            app.text(s, app.fonts.fit(detail, 16, rect.width - 30), rx + 14, y + 32, 16, color)
            y += 62
        draw_hints(app, s, [('A', 'Choose'), ('Y', 'Delete'), ('Start', 'Search'), ('B', 'Back')])


class SettingsScreen(ListScreen):
    crumb = 'Settings'
    SPEEDS = [0, 1024, 2048, 4096, 8192]
    CACHES = [2, 4, 8, 16, 32, None]

    def enter(self):
        self.build()

    def build(self):
        settings = self.app.settings or {}
        bandwidth = settings.get('bandwidth') or {}
        storage = settings.get('storage') or {}
        playback = settings.get('playback') or {}
        limit = bandwidth.get('downloadLimitKib') or 0
        cache = storage.get('cacheLimitGb')
        self.entries = [
            ('Download speed: %s' % ('no limit' if not limit else '%g MB/s' % (limit / 1024.0)),
             '◀ ▶ to change. A Raspberry Pi 3 plays most smoothly at 2 MB/s: faster downloads keep its processor too busy.',
             None, lambda: self.cycle('speed', 1)),
            ('Space for videos: %s' % ('no limit' if cache is None else '%d GB' % cache),
             '◀ ▶ to change. Older videos are deleted to stay under it. Saved in %s.' % DOWNLOAD_DIR,
             None, lambda: self.cycle('cache', 1)),
            ('Subtitles: %s' % ('on' if playback.get('subtitlesByDefault') else 'off'),
             'Whether a film starts with subtitles shown. X turns them on and off while it plays.',
             None, lambda: self.cycle('subs', 1)),
            ('About Torflix', 'Torflix %s for Raspberry Pi · github.com/gary23w/torflix' % VERSION, None, lambda: None),
        ]
        self.app.dirty = True

    def other_action(self, action):
        if action in ('left', 'right'):
            self.cycle(['speed', 'cache', 'subs', None][self.focus], 1 if action == 'right' else -1)

    def cycle(self, which, step):
        settings = self.app.settings or {}
        if which == 'speed':
            now = (settings.get('bandwidth') or {}).get('downloadLimitKib') or 0
            options = self.SPEEDS
            i = options.index(now) if now in options else 2
            patch = {'bandwidth': {'downloadLimitKib': options[(i + step) % len(options)]}}
        elif which == 'cache':
            now = (settings.get('storage') or {}).get('cacheLimitGb')
            options = self.CACHES
            i = options.index(now) if now in options else 1
            patch = {'storage': {'cacheLimitGb': options[(i + step) % len(options)]}}
        elif which == 'subs':
            patch = {'playback': {'subtitlesByDefault': not (settings.get('playback') or {}).get('subtitlesByDefault')}}
        else:
            return
        self.call('updateSettings', [patch], self.app.got_settings_update, self.failed)

    def failed(self, error):
        self.message = str(error)
        self.app.dirty = True

    def on_event(self, name, payload):
        if name == 'settings-changed':
            self.build()

    def draw(self, s):
        app = self.app
        draw_header(app, s, self.crumb)
        y = 110
        for i, (title, detail, _, _) in enumerate(self.entries):
            on = i == self.focus
            rect = pygame.Rect(MARGIN, y, W - 2 * MARGIN, 76)
            pygame.draw.rect(s, TEXT if on else SURFACE, rect)
            app.text(s, title, MARGIN + 22, y + 10, 23, (0, 0, 0) if on else TEXT, True)
            app.text(s, app.fonts.fit(detail, 17, rect.width - 44), MARGIN + 22, y + 44, 17, (60, 60, 60) if on else MUTED)
            y += 88
        if self.message:
            app.text(s, self.message, MARGIN, y + 10, 20, YELLOW)
        draw_hints(app, s, [('◀▶', 'Change'), ('B', 'Back')])


class QuitScreen(Screen):
    def on_action(self, action):
        if action == 'a':
            self.app.running = False
        elif action == 'b':
            self.app.pop()

    def draw(self, s):
        app = self.app
        s.blit(app.dim, (0, 0))
        app.text(s, 'Quit Torflix?', W // 2, 300, 36, TEXT, True, align='center')
        app.text(s, 'A to quit, B to stay.', W // 2, 360, 22, MUTED, align='center')


class PlayerScreen(Screen):
    """Starts the stream, plays it in omxplayer above everything, and saves where it stopped."""
    REPORT_EVERY = 10

    def __init__(self, app, req, title, detail=''):
        Screen.__init__(self, app)
        self.req = {k: v for k, v in req.items() if v is not None}
        self.title = title or ''
        self.detail = detail or ''
        self.info = None
        self.stats = None
        self.player = None
        self.error = None
        self.position = 0.0
        self.duration = 0.0
        self.started = False
        self.last_report = 0
        self.last_stats = 0
        self.lock = threading.Lock()
        self.subtitles = None

    @property
    def animating(self):
        return not self.started and not self.error

    def enter(self):
        self.call('startStream', [self.req], self.got_stream, self.failed)

    def failed(self, error):
        self.error = str(error) or 'This video would not start.'
        self.app.dirty = True

    def got_stream(self, info):
        self.info = info
        if info.get('kind') not in (None, 'video'):
            self.error = '%s is not a video Torflix can play.' % info.get('fileName')
            return
        start = info.get('resumePositionSecs') or 0
        # Above this app's own picture, which SDL puts on layer 10000.
        argv = ['omxplayer', '-b', '--layer', '20000', '-o', 'both', '--timeout', '60', '-s', '-I']
        if start > 5:
            start = int(start)
            argv += ['--pos', '%02d:%02d:%02d' % (start // 3600, start // 60 % 60, start % 60)]
            self.position = start
        sub = self.subtitle_file(info)
        if sub:
            argv += ['--subtitles', sub, '--align', 'center', '--no-ghost-box']
        argv.append(info['url'])
        log('play %s from %ds' % (info.get('fileName'), start))
        try:
            self.player = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           env=CHILD_ENV)
        except OSError as e:
            self.error = 'Could not start omxplayer: %s' % e
            return
        threading.Thread(target=self._read_player, args=(self.player,), daemon=True).start()
        self.app.dirty = True

    def subtitle_file(self, info):
        """The torrent's subtitles in the viewer's language, saved where omxplayer can read them."""
        subs = [t for t in info.get('subtitles') or [] if t.get('url')]
        if not subs:
            return None
        choice = next((t for t in subs if t.get('matched')), subs[0])
        path = os.path.join(DATA_DIR, 'subtitles.srt')
        try:
            c = http.client.HTTPConnection('127.0.0.1', int(re.search(r':(\d+)/', choice['url']).group(1)), timeout=20)
            c.request('GET', choice['url'][choice['url'].index('/', 8):])
            r = c.getresponse()
            data = r.read()
            c.close()
            if r.status != 200 or not data:
                return None
            with open(path, 'wb') as f:
                f.write(data)
        except (OSError, http.client.HTTPException, AttributeError) as e:
            log('subtitles: %r' % e)
            return None
        self.subtitles = choice
        return path

    def _read_player(self, player):
        buf = b''
        while True:
            data = player.stdout.read1(4096) if hasattr(player.stdout, 'read1') else player.stdout.read(256)
            if not data:
                break
            buf += data
            parts = re.split(br'[\r\n]', buf)
            buf = parts.pop()
            for part in parts:
                line = part.decode('utf-8', 'replace')
                m = re.match(r'M:\s*(\d+)', line)
                if m:
                    with self.lock:
                        self.position = int(m.group(1)) / 1e6
                        if not self.started:
                            self.started = True
                            self.app.dirty = True
                    continue
                m = re.search(r'Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)', line)
                if m and not self.duration:
                    self.duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                if line.strip():
                    log('omxplayer: ' + line.strip()[:200])

    def report(self, ended=False):
        if not self.info or not self.duration:
            return
        with self.lock:
            position = self.position
        self.app.tasks.run(self.app.backend.rpc, ('reportPlayback', self.info['streamId'],
                                                  {'positionSecs': position, 'durationSecs': self.duration, 'ended': ended}))

    def tick(self):
        now = time.time()
        if self.player is None:
            return
        if self.player.poll() is not None:
            self.finish()
            return
        if not self.started and self.info and now - self.last_stats > 1:
            self.last_stats = now
            self.call('streamStats', [self.info['streamId']], self._stats)
        if self.started and now - self.last_report > self.REPORT_EVERY:
            self.last_report = now
            self.report()
        if self.started and self.subtitles is not None and not (self.app.settings or {}).get('playback', {}).get('subtitlesByDefault'):
            # omxplayer shows the subtitles it was given; the viewer asked for them hidden.
            self.send(b's')
            self.subtitles = None

    def _stats(self, stats):
        self.stats = stats
        self.app.dirty = True

    def finish(self):
        code = self.player.returncode
        self.player = None
        ended = bool(self.duration) and self.position >= self.duration - 60
        self.report(ended=ended)
        if self.info:
            self.call('stopStream', [self.info['streamId']])
        if not self.started and code not in (0, None):
            self.error = 'omxplayer could not play this video (exit code %s). It plays H.264 up to 1080p; try another copy.' % code
            self.app.dirty = True
            return
        self.app.pop()

    def send(self, key):
        try:
            self.player.stdin.write(key)
            self.player.stdin.flush()
        except (OSError, ValueError, AttributeError):
            pass

    def on_action(self, action):
        if self.player:
            key = PLAYER_KEYS.get(action)
            if key:
                self.send(key)
        elif action in ('a', 'b'):
            if self.info and not self.player:
                self.call('stopStream', [self.info['streamId']])
            self.app.pop()

    def leave(self):
        if self.player and self.player.poll() is None:
            self.send(b'q')
            try:
                self.player.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.player.kill()

    def draw(self, s):
        app = self.app
        if self.started and self.player:
            # The video is on top; below it, nothing but black, like omxplayer's own bars.
            s.fill((0, 0, 0))
            return
        draw_header(app, s, 'Playing')
        app.text(s, app.fonts.fit(self.title, 40, W - 2 * MARGIN, True), MARGIN, 150, 40, TEXT, True)
        app.text(s, app.fonts.fit(self.detail, 20, W - 2 * MARGIN), MARGIN, 206, 20, MUTED)
        if self.error:
            for i, text in enumerate(app.fonts.wrap(self.error, 22, W - 2 * MARGIN, 4)):
                app.text(s, text, MARGIN, 280 + i * 32, 22, YELLOW)
            app.text(s, 'Press A or B to go back.', MARGIN, 420, 20, MUTED)
            return
        if not self.started or not self.player:
            draw_spinner(s, MARGIN + 20, 300)
            st = self.stats or {}
            line = 'Connecting to peers…'
            if self.info:
                line = 'Getting %s ready' % (self.info.get('fileName') or 'the video')
            app.text(s, app.fonts.fit(line, 22, W - 2 * MARGIN - 60), MARGIN + 56, 286, 22, TEXT)
            if st:
                app.text(s, '%d peers  ·  %.1f MB/s' % (st.get('peersLive') or 0, (st.get('downloadBps') or 0) / 1e6),
                         MARGIN + 56, 324, 20, MUTED)
        hints =[('A', 'Pause'), ('◀▶', '30 s'), ('▲▼', '10 min'), ('X', 'Subtitles'), ('Y', 'Audio'), ('B', 'Stop')]
        y = 420
        for key, label in hints:
            app.text(s, key, MARGIN, y, 20, TEXT, True)
            app.text(s, label, MARGIN + 80, y, 20, MUTED)
            y += 32


# ---------------------------------------------------------------- the app

class App(object):
    def __init__(self):
        self.backend = Backend()
        self.tasks = Tasks()
        self.fonts = Fonts()
        self.pictures = None
        self.controls = None
        self.stack = []
        self.running = True
        self.dirty = True
        self.screen = None
        self.settings = None
        self.remote = queue.Queue()

    def open_display(self):
        forced = os.environ.get('TORFLIX_VIDEODRIVER')
        error = None
        for driver in ([forced] if forced else ['dispmanx', 'fbcon']):
            # RetroPie's SDL 1.2 reads SDL1_VIDEODRIVER.
            os.environ['SDL_VIDEODRIVER'] = os.environ['SDL1_VIDEODRIVER'] = driver
            try:
                pygame.display.init()
                if driver == 'dispmanx':
                    self.screen = pygame.display.set_mode((W, H), pygame.FULLSCREEN)
                else:
                    self.screen = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
                log('display: %s %dx%d' % (pygame.display.get_driver(), self.screen.get_width(), self.screen.get_height()))
                break
            except pygame.error as e:
                log('display: %s failed: %s' % (driver, e))
                error = e
                pygame.display.quit()
        else:
            raise RuntimeError('no display: %s' % error)
        pygame.mouse.set_visible(False)
        pygame.key.set_repeat(400, 90)
        pygame.font.init()
        # A screen that is not 1280×720 (the console framebuffer) draws into one and scales it.
        self.canvas = pygame.Surface((W, H)).convert() if self.screen.get_size() != (W, H) else self.screen
        self.fade_left = self._gradient((520, 400), horizontal=True)
        self.fade_down = self._gradient((860, 160), horizontal=False)
        self.dim = pygame.Surface((W, H), pygame.SRCALPHA)
        self.dim.fill((20, 20, 20, 200))

    @staticmethod
    def _gradient(size, horizontal):
        """BG, fading to clear from left to right (or top to bottom, to clear at the top)."""
        w, h = size
        g = pygame.Surface(size, pygame.SRCALPHA)
        steps = w if horizontal else h
        for i in range(steps):
            alpha = 255 - int(255 * i / float(steps)) if horizontal else int(255 * i / float(steps))
            if horizontal:
                pygame.draw.line(g, BG + (alpha,), (i, 0), (i, h))
            else:
                pygame.draw.line(g, BG + (alpha,), (0, i), (w, i))
        return g

    def text(self, s, text, x, y, size, color, bold=False, align='left'):
        if not text:
            return 0
        surface = self.fonts.render(text, size, color, bold)
        if align == 'center':
            x -= surface.get_width() // 2
        s.blit(surface, (x, y))
        return surface.get_width()

    def push(self, screen):
        self.stack.append(screen)
        screen.enter()
        self.dirty = True

    def pop(self):
        if not self.stack:
            return
        screen = self.stack.pop()
        screen.closed = True
        screen.leave()
        if self.stack:
            self.stack[-1].resume()
        else:
            self.running = False
        self.dirty = True

    def got_settings(self, view):
        if view and 'settings' in view:
            self.settings = view['settings']
            self.dirty = True

    def got_settings_update(self, view):
        self.got_settings(view)
        for screen in self.stack:
            screen.on_event('settings-changed', view)

    def got_first_settings(self, view):
        self.got_settings_update(view)

    def handle(self, event):
        action = None
        top = self.stack[-1] if self.stack else None
        if event.type == pygame.QUIT:
            self.running = False
            return
        if event.type == pygame.KEYDOWN:
            if top and top.text_input and event.key not in (pygame.K_UP, pygame.K_DOWN, pygame.K_LEFT, pygame.K_RIGHT,
                                                            pygame.K_ESCAPE, pygame.K_TAB, pygame.K_F1):
                if event.key == pygame.K_BACKSPACE:
                    top.on_text('\x08')
                elif event.key in (pygame.K_RETURN, pygame.K_KP_ENTER):
                    if getattr(top, 'zone', None) == 'results':
                        top.on_action('a')
                    else:
                        top.on_text('\n')
                elif event.unicode:
                    top.on_text(event.unicode)
                self.dirty = True
                return
            action = KEYS.get(event.key)
            if action is None and event.key == pygame.K_SPACE:
                action = 'a'
            if action is None and event.unicode in ('s', 'S'):
                action = 'x'
            if action is None and event.unicode in ('-', '+', '='):
                action = 'pageup' if event.unicode == '-' else 'pagedown'
        elif event.type in (pygame.JOYBUTTONDOWN, pygame.JOYBUTTONUP, pygame.JOYHATMOTION, pygame.JOYAXISMOTION):
            action = self.controls.action(event)
        if action and top:
            top.on_action(action)
            self.dirty = True
        elif action == 'b' and self.backend.failed:
            self.running = False

    def _read_remote(self, path):
        """Test hook: actions written one per line to the FIFO at TORFLIX_TV_KEYS (`text:…` types,
        `quit` leaves)."""
        while True:
            try:
                with open(path) as f:
                    for line in f:
                        self.remote.put(line.strip())
            except OSError:
                time.sleep(1)

    def run(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        if os.path.isfile(LOG_FILE) and os.path.getsize(LOG_FILE) > 1000000:
            os.remove(LOG_FILE)
        log('Torflix %s starting' % VERSION)
        self.open_display()
        self.controls = Controls()
        self.pictures = Pictures(self)
        self.backend.start()
        if os.environ.get('TORFLIX_TV_KEYS'):
            threading.Thread(target=self._read_remote, args=(os.environ['TORFLIX_TV_KEYS'],), daemon=True).start()
        clock = pygame.time.Clock()
        try:
            while self.running:
                for event in pygame.event.get():
                    self.handle(event)
                repeat = self.controls.repeat()
                if repeat and self.stack:
                    self.stack[-1].on_action(repeat)
                    self.dirty = True
                while not self.remote.empty():
                    action = self.remote.get()
                    log('remote: %r' % action)
                    if action == 'quit':
                        self.running = False
                    elif self.stack and action.startswith('text:'):
                        for char in action[5:]:
                            self.stack[-1].on_text(char)
                    elif self.stack and action:
                        self.stack[-1].on_action(action)
                    self.dirty = True
                self.tasks.dispatch()
                while True:
                    try:
                        name, payload = self.backend.events.get_nowait()
                    except queue.Empty:
                        break
                    if name == 'settings-changed':
                        self.got_settings(payload)
                    for screen in list(self.stack):
                        screen.on_event(name, payload)
                if not self.stack and self.backend.port:
                    self.tasks.run(self.backend.rpc, ('getSettings',), self.got_first_settings)
                    self.push(BrowseScreen(self))
                top = self.stack[-1] if self.stack else None
                if top:
                    top.tick()
                if self.dirty or (top and top.animating) or not top:
                    self.draw(top)
                    self.dirty = False
                # While a video plays, this app only waits for keys: the Pi's processor is the engine's.
                clock.tick(8 if isinstance(top, PlayerScreen) and top.started else 30)
        finally:
            for screen in reversed(self.stack):
                screen.closed = True
                screen.leave()
            self.draw_message('Closing Torflix…')
            self.backend.stop()
            pygame.display.quit()
            log('Torflix closed')

    def draw(self, top):
        c = self.canvas
        c.fill(BG)
        if top:
            # A dialog draws over the screen below it.
            if isinstance(top, QuitScreen) and len(self.stack) > 1:
                self.stack[-2].draw(c)
            top.draw(c)
        elif self.backend.failed:
            self.text(c, 'TORFLIX', W // 2, 260, 48, ACCENT, True, align='center')
            for i, text in enumerate(self.fonts.wrap(self.backend.failed, 20, 1000, 3)):
                self.text(c, text, W // 2, 340 + i * 28, 20, YELLOW, align='center')
            self.text(c, 'Press B to leave.', W // 2, 440, 20, MUTED, align='center')
        else:
            self.text(c, 'TORFLIX', W // 2, 300, 56, ACCENT, True, align='center')
            draw_spinner(c, W // 2, 420)
        self.present()

    def draw_message(self, message):
        try:
            self.canvas.fill(BG)
            self.text(self.canvas, message, W // 2, 340, 28, MUTED, align='center')
            self.present()
        except pygame.error:
            pass

    def present(self):
        if self.canvas is not self.screen:
            pygame.transform.scale(self.canvas, self.screen.get_size(), self.screen)
        pygame.display.flip()


def main():
    app = App()
    # Ended from outside (a dashboard, RetroPie, a closed terminal): leave the way Quit does,
    # so the place in the video is saved and the engine stops.
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: setattr(app, 'running', False))
    try:
        app.run()
    except Exception:  # noqa: BLE001 - logged for the viewer to send in
        log(traceback.format_exc())
        app.backend.stop()
        raise


if __name__ == '__main__':
    main()
