"""Isolated, deterministic PTY fixture. No shell, files or real agent sessions."""
import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import tty


def emit(text):
    os.write(1, text.encode())


def tui():
    tty.setraw(0)
    emit("\x1b[?2004h")
    menu = False

    def home():
        emit("\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[2J\x1b[H")
        emit("Terminal experience spike — local PTY fixture\r\n")
        emit("https://example.com/plain\r\n")
        emit("\x1b]8;;https://example.com/osc8\x1b\\Named hyperlink\x1b]8;;\x1b\\\r\n")
        emit("Select this sentence with the mouse.\r\n")
        emit("Unicode: café λ 中文 | \x1b[31mred\x1b[0m | ┌─┐\r\n")
        emit("h: 140 history lines   m: mouse menu   r: reset fixture\r\n")
        emit("Type freely; keys are echoed here. No shell commands run.\r\n")

    home()
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        if data == b'h' and not menu:
            for n in range(140):
                emit(f"HISTORY {n:03d}: preserved output from the PTY\r\n")
            emit("HISTORY END — scroll up with the wheel; r resets the fixture.\r\n")
        elif data == b'm' and not menu:
            menu = True
            emit("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h")
            emit("Mouse-enabled TUI: click option 1 or use the keyboard.\r\n")
            emit("q: leave menu\r\n\r\n\r\n")
            emit("[1] First option\r\n[2] Second option\r\n")
        elif data == b'q' and menu or data == b'r' and not menu:
            menu = False
            home()
        elif menu:
            for button, x, y, kind in re.findall(rb'\x1b\[<(\d+);(\d+);(\d+)([Mm])', data):
                if kind == b'M' and button == b'0' and int(y) in (5, 6):
                    emit(f"\x1b[9;1HSELECTED {int(y) - 4} by mouse ({int(x)}, {int(y)})\x1b[K")
            if data in (b'1', b'2'):
                emit(f"\x1b[10;1HSELECTED {data.decode()} by keyboard\x1b[K")
        else:
            # Render controls visibly; never interpret pasted content as commands.
            text = data.decode('utf-8', errors='replace').replace('\x1b', '<ESC>').replace('\r', '\r\n')
            emit(text)


def bridge():
    pid, master = pty.fork()
    if pid == 0:
        try:
            tui()
        finally:
            os._exit(0)

    def send(obj):
        print(json.dumps(obj), flush=True)

    pending = b''
    try:
        while True:
            readable, _, _ = select.select([master, 0], [], [])
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                send({'type': 'output', 'data': base64.b64encode(data).decode()})
            if 0 in readable:
                chunk = os.read(0, 65536)
                if not chunk:
                    break
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    msg = json.loads(line)
                    if msg['type'] == 'input':
                        data = base64.b64decode(msg['data'], validate=True)
                        os.write(master, data)
                        send({'type': 'input', 'data': data.decode('utf-8', errors='replace')})
                    elif msg['type'] == 'resize':
                        cols, rows = int(msg['cols']), int(msg['rows'])
                        if not (2 <= cols <= 500 and 2 <= rows <= 200):
                            continue
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                        actual = struct.unpack('HHHH', fcntl.ioctl(master, termios.TIOCGWINSZ, b'\0' * 8))
                        send({'type': 'resize', 'cols': actual[1], 'rows': actual[0]})
    finally:
        os.close(master)
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)


if __name__ == '__main__':
    bridge()
