# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

import argparse
import codecs
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import resource
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unicodedata


def terminal_settings(fd):
    settings = termios.tcgetattr(fd)
    # BSD sets PENDIN when restoring ICANON, even with an empty input queue.
    # It is kernel bookkeeping; all actual mode flags, speeds and cc values must match.
    settings[3] &= ~getattr(termios, "PENDIN", 0)
    return settings


def assert_terminal_restored(fd, expected, message):
    actual = terminal_settings(fd)
    assert actual == expected, f"{message}: expected {expected!r}, got {actual!r}"


def wait_stopped(process, drain):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        pid, status = os.waitpid(process.pid, os.WNOHANG | os.WUNTRACED)
        if pid:
            if os.WIFSTOPPED(status):
                assert os.WSTOPSIG(status) == signal.SIGSTOP, "UI stopped on an unexpected signal"
                drain(0.02)
                return
            process.returncode = os.waitstatus_to_exitcode(status)
            raise AssertionError("UI exited instead of suspending")
        drain(0.02)
    raise AssertionError("UI did not stop after suspend")


def wait_exited(process, master, output, timeout=3):
    # Waiting without reading can fill Darwin's PTY queue while a frame or the
    # signal handler's terminal restoration sequence is still being written.
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, timeout)
        if select.select([master], [], [], min(0.05, remaining))[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            output.extend(chunk)
    # poll() may observe exit before the final restoration bytes were consumed.
    while select.select([master], [], [], 0)[0]:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        output.extend(chunk)
    return process.returncode


def cleanup_process(process, master):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        os.kill(process.pid, signal.SIGCONT)
    except ProcessLookupError:
        pass
    # A resumed TUI may be writing its new frame. Keep the PTY flowing so the
    # event loop can handle SIGTERM, and preserve the assertion if cleanup stalls.
    deadline = time.monotonic() + 3
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
    if process.poll() is None:
        process.kill()
    process.wait(timeout=3)


class Screen:
    def __init__(self, width=120, height=40):
        self.width, self.height = width, height
        self.cells = [[(" ", (78, 173, 245), (0, 0, 0)) for _ in range(width)] for _ in range(height)]
        self.x = self.y = 0
        self.fg, self.bg = (78, 173, 245), (0, 0, 0)
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        pos = 0
        while pos < len(self.pending):
            c = self.pending[pos]
            if c == "\x1b":
                match = re.match(r"\x1b\[([0-9;?]*)([@-~])", self.pending[pos:])
                if not match:
                    break
                args, command = match.groups()
                pos += len(match.group())
                if args.startswith("?"):
                    continue
                values = [int(v or 0) for v in args.split(";")]
                if command == "H":
                    self.y = (values[0] or 1) - 1
                    self.x = (values[1] if len(values) > 1 and values[1] else 1) - 1
                elif command in ("A", "B", "C", "D"):
                    count = values[0] or 1
                    if command == "A":
                        self.y = max(0, self.y - count)
                    elif command == "B":
                        self.y = min(self.height - 1, self.y + count)
                    elif command == "C":
                        self.x = min(self.width - 1, self.x + count)
                    else:
                        self.x = max(0, self.x - count)
                elif command == "J" and values[0] == 2:
                    self.cells = [
                        [(" ", self.fg, self.bg) for _ in range(self.width)] for _ in range(self.height)
                    ]
                elif command == "m":
                    i = 0
                    while i < len(values):
                        if values[i] in (38, 48) and i + 4 < len(values) and values[i + 1] == 2:
                            color = tuple(values[i + 2 : i + 5])
                            if values[i] == 38:
                                self.fg = color
                            else:
                                self.bg = color
                            i += 5
                        elif values[i] in (38, 48) and i + 2 < len(values) and values[i + 1] == 5:
                            index = max(0, values[i + 2] - 16)
                            levels = [0, 95, 135, 175, 215, 255]
                            color = (levels[min(5, index // 36)], levels[(index // 6) % 6], levels[index % 6])
                            if values[i] == 38:
                                self.fg = color
                            else:
                                self.bg = color
                            i += 3
                        else:
                            i += 1
                continue
            pos += 1
            if ord(c) < 32:
                continue
            width = (
                0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1
            )
            if 0 <= self.x < self.width and 0 <= self.y < self.height:
                self.cells[self.y][self.x] = (c, self.fg, self.bg)
            self.x += width
        self.pending = self.pending[pos:]

    def text(self):
        return "\n".join("".join(c[0] for c in row) for row in self.cells)

    def selected(self, left=0, right=None, top=0, bottom=None):
        return "\n".join(
            "".join(
                glyph if fg == (0, 0, 0) and bg != (0, 0, 0) else " " for glyph, fg, bg in row[left:right]
            )
            for row in self.cells[top:bottom]
        )

    def status_bar(self, sidebar=False):
        row = self.height - 5
        assert all(cell[0] == "─" for cell in self.cells[row][2:-2]), "Status rule is not full width"
        assert "[Tab] - Controls" in "".join(c[0] for c in self.cells[row + 2]), "Controls hint missing"
        if sidebar:
            divider = max(16, min(27, self.width // 5)) + 1
            assert self.cells[row - 1][divider][0] == "│", "Sidebar divider missing"
            assert self.cells[row + 1][divider][0] != "│", "Sidebar extends into status message"
            assert self.cells[row + 2][divider][0] != "│", "Sidebar extends into key hints"

    def save(self, directory, name):
        if not directory:
            return
        destination = Path(directory)
        destination.mkdir(parents=True, exist_ok=True)
        (destination / (name + ".txt")).write_text(self.text())
        try:
            from PIL import Image, ImageDraw, ImageFont
        except ImportError:
            return
        font_path = "/usr/share/fonts/TTF/DejaVuSansMono.ttf"
        if not Path(font_path).exists():
            font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
        if not Path(font_path).exists():
            return
        font = ImageFont.truetype(font_path, 19)
        image = Image.new("RGB", (self.width * 12, self.height * 24))
        draw = ImageDraw.Draw(image)
        for y, row in enumerate(self.cells):
            for x, (glyph, fg, bg) in enumerate(row):
                px, py = x * 12, y * 24
                draw.rectangle((px, py, px + 11, py + 23), fill=bg)
                if glyph in ("▀", "▄"):
                    top = 0 if glyph == "▀" else 12
                    draw.rectangle((px, py + top, px + 11, py + top + 11), fill=fg)
                else:
                    draw.text((px, py), glyph, font=font, fill=fg)
        image.save(destination / (name + ".png"))


def run(binary, broker, measure=False, snapshots=None, no_anim=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    original = terminal_settings(slave)
    screen = Screen()
    output = bytearray()
    with tempfile.TemporaryDirectory(prefix="bitfrost-tui-test-") as temporary:
        log = Path(temporary) / "requests.ndjson"
        env = dict(
            os.environ,
            TERM="xterm-256color",
            COLORTERM="truecolor",
            BITFROST_TUI_BROKER="node " + str(broker),
            BITFROST_FAKE_LOG=str(log),
        )
        env.pop("BITFROST_NO_ANIM", None)
        env.pop("BITFROST_NO_MOUSE", None)
        env.pop("BITFROST_PRETEND_VERSION", None)
        process = subprocess.Popen(
            [str(binary)] + (["--no-anim"] if no_anim else []),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
        )

        def drain(seconds, moving=False):
            deadline = time.monotonic() + seconds
            next_motion = time.monotonic()
            motion = 0
            while time.monotonic() < deadline:
                now = time.monotonic()
                if moving and now >= next_motion:
                    points = ((31, 20), (60, 27), (60, 29), (60, 31), (80, 35))
                    x, y = points[motion % len(points)]
                    os.write(master, ("\x1b[<35;" + str(x) + ";" + str(y) + "M").encode())
                    motion += 1
                    next_motion = now + 0.01
                wake = min(deadline, next_motion) if moving else deadline
                ready, _, _ = select.select([master], [], [], max(0, wake - time.monotonic()))
                if ready:
                    data = os.read(master, 65536)
                    output.extend(data)
                    screen.feed(data)

        def key(data, delay=0.12):
            os.write(master, data)
            drain(delay)
            assert process.poll() is None, "UI exited while navigating"

        def wait_for(predicate, message, timeout=3):
            deadline = time.monotonic() + timeout
            while not predicate() and time.monotonic() < deadline:
                drain(min(0.02, max(0, deadline - time.monotonic())))
                assert process.poll() is None, "UI exited while waiting for rendering"
            assert predicate(), message

        def stats():
            if not Path("/proc").exists():
                return None
            fields = Path("/proc/" + str(process.pid) + "/stat").read_text().split()
            ticks = int(fields[13]) + int(fields[14])
            status = Path("/proc/" + str(process.pid) + "/status").read_text()
            rss = int(re.search(r"VmRSS:\s+(\d+)", status).group(1))
            return ticks, rss

        def chart_bars():
            return "".join(cell[0] for row in screen.cells[32:34] for cell in row[64:116])

        def visible_model_rows():
            return tuple(
                "".join(" " if c[0] in ("▀", "▄") else c[0] for c in row[27:115])
                for row in screen.cells[5:21]
            )

        def no_subpage_particles():
            assert all(row[2][0] == " " for row in screen.cells[2:-5]), "Sidebar particles remain"
            assert all(row[26][0] == " " for row in screen.cells[4:22]), "Model list particles remain"
            assert all(row[-1][0] == " " for row in screen.cells), "Page drawing escaped the right border"
            assert all(row[0][0] == " " for row in screen.cells), "Page drawing escaped the left border"

        try:
            drain(0.35)
            assert b"\x1b[?1049h" in output and b"\x1b[?25l" in output, "No alternate screen or hidden cursor"
            assert all(label in screen.text() for label in ("Models", "Settings", "Status")), "Home menu missing"
            for y, label in ((24, "Models"), (26, "Settings"), (28, "Status")):
                assert "".join(cell[0] for cell in screen.cells[y][56:56 + len(label)]) == label, "Home labels are not two rows apart"
            assert screen.cells[23][54][0] == "▄" and screen.cells[25][54][0] == "▀", "Home highlight half rows are wrong"
            enabled = b"\x1b[?1006h\x1b[?1003h"
            disabled = b"\x1b[?1003l\x1b[?1006l"
            assert enabled in output, "Session mouse reporting mode is wrong"
            key(b"\x1b[<35;31;")
            key(b"20M\x1b[<32;32;20M\x1b[<35;33;20M")
            assert "Models" in screen.selected(), "Mouse motion changed home selection"
            key(b"\x1b[<qwasde\x1b;1;2M")
            assert "Models" in screen.selected(), "Malformed mouse report triggered a shortcut"
            for action in (signal.SIGTSTP, b"\x1a"):
                before = len(output)
                if isinstance(action, bytes):
                    os.write(master, action)
                else:
                    os.kill(process.pid, action)
                wait_stopped(process, drain)
                assert disabled in output[before:], "Home suspend did not disable mouse"
                assert_terminal_restored(slave, original, "Home suspend did not restore terminal")
                before = len(output)
                os.kill(process.pid, signal.SIGCONT)
                drain(0.12)
                assert enabled in output[before:], "Resume did not restore mouse reporting"
            screen.status_bar()
            key(b"w")
            assert "Status" in screen.selected(), "Home does not wrap upward"
            key(b"s")
            assert "Models" in screen.selected(), "Home does not wrap downward"
            screen.save(snapshots, "home-static" if no_anim else "home")
            start = stats()
            started = time.monotonic()
            byte_start = len(output)
            drain(5.0 if measure else 0.15)
            seconds = time.monotonic() - started
            end = stats()
            metrics = {
                "idle_seconds": round(seconds, 3),
                "idle_output_bytes": len(output) - byte_start,
                "idle_bytes_per_second": round((len(output) - byte_start) / seconds, 1),
            }
            if start and end:
                cpu = (end[0] - start[0]) / os.sysconf("SC_CLK_TCK")
                metrics.update(
                    cpu_seconds=round(cpu, 4),
                    cpu_percent_one_core=round(100 * cpu / seconds, 3),
                    rss_kib=end[1],
                )
            if no_anim:
                assert metrics["idle_output_bytes"] == 0, "Static mode redraws while idle"
            if measure:
                metrics["mouse_idle"] = {}
                for name, report in (
                    ("outside", b"\x1b[<35;31;30M"),
                    ("inside", b"\x1b[<35;31;20M"),
                    ("outside_repeat", b"\x1b[<35;31;30M"),
                    ("inside_repeat", b"\x1b[<35;31;20M"),
                ):
                    key(report, 2.0)
                    screen.save(snapshots, "home-mouse-" + name)
                    start, started, byte_start = stats(), time.monotonic(), len(output)
                    drain(10.0)
                    seconds, end = time.monotonic() - started, stats()
                    sample = {"bytes_per_second": round((len(output) - byte_start) / seconds, 1)}
                    if start and end:
                        cpu = (end[0] - start[0]) / os.sysconf("SC_CLK_TCK")
                        sample["cpu_percent_one_core"] = round(100 * cpu / seconds, 3)
                    metrics["mouse_idle"][name] = sample
                start, started, byte_start = stats(), time.monotonic(), len(output)
                drain(10.0, moving=True)
                seconds, end = time.monotonic() - started, stats()
                sample = {"bytes_per_second": round((len(output) - byte_start) / seconds, 1)}
                if start and end:
                    cpu = (end[0] - start[0]) / os.sysconf("SC_CLK_TCK")
                    sample["cpu_percent_one_core"] = round(100 * cpu / seconds, 3)
                metrics["mouse_idle"]["moving_100hz"] = sample
            key(b"\x1b[F\r", 0.7)
            assert output.rfind(enabled) > output.rfind(disabled), "Subpage disabled session mouse reporting"
            assert all(
                label in screen.text() for label in ("Sessions", "Running", "Recent")
            ), "Status overview missing"
            assert (
                "reviewer" in screen.text() and "Codex gpt-6.1-sol" in screen.text()
            ), "Subagent fallback name or model missing"
            screen.status_bar(sidebar=True)
            key(b"\r")
            assert "Build Status page" in screen.selected(left=27), "Running subagent is not selected"
            first_tokens = "".join(cell[0] for cell in screen.cells[7][100:110])
            first_duration = "".join(cell[0] for cell in screen.cells[7][90:100])
            start, started, byte_start = stats(), time.monotonic(), len(output)
            drain(5.0 if measure else 2.2)
            seconds, end = time.monotonic() - started, stats()
            metrics["status_idle_bytes_per_second"] = round((len(output) - byte_start) / seconds, 1)
            if start and end:
                cpu = (end[0] - start[0]) / os.sysconf("SC_CLK_TCK")
                metrics["status_cpu_percent_one_core"] = round(100 * cpu / seconds, 3)
            assert first_tokens != "".join(
                cell[0] for cell in screen.cells[7][100:110]
            ), "Subagent live update did not change tokens without a keypress"
            assert first_duration != "".join(
                cell[0] for cell in screen.cells[7][90:100]
            ), "Running duration did not tick without a keypress"
            assert "Build Status page" in screen.selected(left=27), "Live update moved the selection"
            assert all(
                row[2][0] == " " and row[26][0] == " " for row in screen.cells[4:35]
            ), "Status has particles"
            screen.save(snapshots, "status-overview")
            key(b"w")
            assert "See all" in screen.selected(left=27), "Subagent overview did not wrap over headers"
            key(b"s")
            assert "Build Status page" in screen.selected(left=27), "Subagent overview down did not wrap"
            key(b"\x1b[6~")
            assert "See all" in screen.selected(left=27), "Subagent Page Down failed"
            key(b"\x1b[5~")
            assert "Build Status page" in screen.selected(left=27), "Subagent Page Up failed"
            key(b"\x1b[F\r", 0.2)
            assert all(
                label in screen.text() for label in ("Session history", "Today", "Yesterday")
            ), "See all did not show day segments"
            screen.save(snapshots, "status-history")
            key(b"\x1b[F")
            assert (
                "Review configuration 5000" in screen.selected(left=27)
            ), "History End did not select an older subagent"
            screen.save(snapshots, "status-history-older")
            key(b"s")
            assert "Build Status page" in screen.selected(left=27), "History did not wrap to the newest session"
            key(b"\x1b[H")
            key(b"\x1b[6~")
            assert "Review configuration" in screen.selected(left=27), "History Page Down selected a header"
            key(b"\x1b[5~\x1b[H")
            assert "Build Status page" in screen.selected(left=27), "History Home failed"
            key(b"q")
            assert (
                "See all" in screen.selected(left=27) and "Recent" in screen.text()
            ), "History back lost overview selection"
            key(b"qsd", 0.2)
            assert all(
                label in screen.text() for label in ("PID", "4242", "listed ")
            ), "Helper status missing"
            assert all(
                label in screen.text() for label in ("/tmp/bitfrost-fake.sock", "workstation", "Expires in")
            ), "Helper paths or leases missing"
            assert "".join(c[0] for c in screen.cells[5][28:34]) == "Helper", "Helper group heading missing"
            wait_for(lambda: screen.cells[5][28][1] == (182, 197, 210), "Helper heading did not finish fading in")
            assert screen.cells[5][28][1] == (182, 197, 210), "Helper heading is not white"
            assert screen.cells[6][28][1] == (78, 173, 245) and screen.cells[6][37][1] == (62, 78, 94), (
                "Helper label/value colors are not blue/dim"
            )
            assert "Models:" in screen.text() and "Location:" in screen.text(), "Helper app groups lack their fields"
            screen.save(snapshots, "status-helper")
            start, started, byte_start = stats(), time.monotonic(), len(output)
            drain(5.0 if measure else 3.2)
            seconds, end = time.monotonic() - started, stats()
            metrics["helper_idle_bytes_per_second"] = round((len(output) - byte_start) / seconds, 1)
            if start and end:
                cpu = (end[0] - start[0]) / os.sysconf("SC_CLK_TCK")
                metrics["helper_cpu_percent_one_core"] = round(100 * cpu / seconds, 3)
            requests = [json.loads(line) for line in log.read_text().splitlines()]
            assert sum(r["method"] == "status.get" for r in requests) >= 2, "Helper did not refresh while idle"
            key(b"qq", 0.3)
            requests = [json.loads(line) for line in log.read_text().splitlines()]
            assert sum(
                r["method"] == "unwatch" and r["params"]["what"] == "subagents" for r in requests
            ) == 1, "Leaving Status did not unwatch once"
            key(b"\x1b[H")
            key(b"\r", 0.7)
            assert "Providers" in screen.text(), "Models page missing"
            assert "All models" in "".join(
                c[0] for c in screen.cells[16]
            ), "All models header moved unexpectedly"
            assert not "".join(
                c[0] for c in screen.cells[15][27:115]
            ).strip(), "Enabled section has no blank separator"
            categories = ((6, "codex"), (13, "neuralwatt"), (17, "codex"))
            wait_for(
                lambda: all(
                    "".join(c[0] for c in screen.cells[y][28:28 + len(category)]) == category
                    and all(c[1] == (182, 197, 210) for c in screen.cells[y][28:28 + len(category)])
                    for y, category in categories
                ),
                "Model category headings did not finish fading in",
            )
            for y, category in categories:
                assert "".join(c[0] for c in screen.cells[y][28:28 + len(category)]) == category, (
                    "Category heading moved unexpectedly"
                )
                assert all(c[1] == (182, 197, 210) for c in screen.cells[y][28:28 + len(category)]), (
                    "Category heading is not white: " + str(screen.cells[y][28:28 + len(category)])
                )
            assert not "".join(c[0] for c in screen.cells[12][27:115]).strip(), (
                "Category groups have no blank separator"
            )
            assert "".join(c[0] for c in screen.cells[7][28:37]) == "  model-1", (
                "Grouped model moved unexpectedly or lacks its two-space indentation"
            )
            assert "codex/model-1" not in screen.text(), "Grouped model label retains its category prefix"
            screen.status_bar(sidebar=True)
            key(b"w")
            assert "Crush" in screen.selected(right=25), "Provider sidebar does not wrap upward"
            key(b"s")
            assert "Codex" in screen.selected(right=25), "Provider sidebar does not wrap downward"
            key(b"\x1b[F")
            assert "Crush" in screen.selected(right=25), "Sidebar End failed"
            key(b"\x1b[H")
            assert "Codex" in screen.selected(right=25), "Sidebar Home failed"
            key(b"\x1b[6~")
            assert "Crush" in screen.selected(right=25), "Sidebar Page Down failed"
            key(b"\x1b[5~")
            assert "Codex" in screen.selected(right=25), "Sidebar Page Up failed"
            key(b"\x1b[Fw", 0.3)
            key(b"\r")
            assert "None yet" in screen.text(), "Empty Enabled section placeholder missing"
            assert not "".join(
                c[0] for c in screen.cells[7][27:115]
            ).strip(), "None yet has no blank separator"
            key(b"\x1b[Z")
            assert "model-1" in screen.selected(left=27, bottom=22), "Tab selected an empty section"
            key(b"q\x1b[H")
            key(b"ss", 0.3)
            key(b"\r")
            assert (
                "Enabled" in screen.text() and "Anthropic, never offered" not in screen.text()
            ), "Enabled section includes blocked models"
            key(b"\x1b[Z")
            assert "All models" in screen.text(), "Tab did not jump to All models"
            key(b"w")
            assert (
                "page-model-40" in screen.selected(left=27, bottom=22)
            ), "Up selected a section header"
            key(b"s")
            assert (
                "deepseek-v4.1-flash" in screen.selected(left=27, bottom=22)
            ), "Down selected a section header"
            key(b"\x1b[Z")
            assert "Enabled" in screen.text(), "Shift-Tab did not jump to Enabled"
            key(b"\x1b[Z")
            assert "All models" in screen.text(), "Shift-Tab did not return to All models"
            assert "Anthropic, never offered" in screen.text(), "Anthropic row reason missing"
            assert "off" in screen.text() and "on" in screen.text(), "Model state columns missing"
            assert (
                "Avg. session time" in screen.text() and "62m" in screen.text()
            ), "Bottom stats panel missing"
            assert (
                "Example" in "".join(c[0] for c in screen.cells[23][27:62])
                and "Default: high" in screen.text()
                and "Company:" not in screen.text()
            ), "Model facts missing"
            for tab, label in enumerate(("Today", "7 days", "30 days", "All time")):
                assert label in "".join(c[0] for c in screen.cells[23][64 + tab * 13 : 77 + tab * 13]), (
                    "Four stats tab labels are missing or misplaced"
                )
            assert "Today" in screen.selected(top=23, bottom=24), "Today is not the default tab"
            today_chart = chart_bars()
            assert any(c in "▁▂▃▄▅▆▇█" for c in today_chart), "Usage chart bars missing"
            assert (
                "96.0k" in screen.text() and "most 8.0k   avg 4.0k   least 0" in screen.text()
            ), "Today does not show today's totals and all 24 hourly entries"
            assert "▀" not in today_chart, "Chart uses moving mosaic pixels"
            no_subpage_particles()
            assert "[Tab] - Controls" in screen.text(), "Controls hint missing"
            key(b"\t")
            assert "Switch model section" in screen.text() and "Shift+Tab" in screen.text(), "Model controls missing"
            assert "Switch stats period" in screen.text(), "Stats controls missing"
            key(b"\t")
            screen.save(snapshots, "models-states")
            selected_before = screen.selected(left=27, bottom=22)
            tab_before = screen.selected(top=23, bottom=24)
            visible_before = visible_model_rows()
            drain(3.2)
            assert "352.2k" in screen.text(), "Live stats did not update Today without a keypress"
            assert "most 256.2k   avg 14.7k   least 0" in screen.text(), "Live stats did not update hourly chart"
            assert selected_before == screen.selected(left=27, bottom=22), "Live stats moved selection"
            assert tab_before == screen.selected(top=23, bottom=24), "Live stats changed tab"
            assert visible_before == visible_model_rows(), "Live stats moved scroll"
            today_chart = chart_bars()
            screen.save(snapshots, "models-live-stats")
            key(b"\x1b[H")
            key(b"w")
            assert (
                "page-model-40" in screen.selected(left=27, bottom=22)
            ), "Models do not wrap upward"
            assert (
                "Page Model 40" in screen.text() and "Never" in screen.text()
            ), "Highlighted unused model stats missing"
            assert (
                not chart_bars().strip() and "most 0   avg 0   least 0" in screen.text()
            ), "Unused model chart is not empty"
            for row in screen.cells[30:32]:
                assert "".join(c[0] for c in row[65:117]).rstrip().endswith("-"), "Empty average missing dash"
            key(b"s")
            assert (
                "deepseek-v4.1-flash" in screen.selected(left=27, bottom=22)
            ), "Models do not wrap downward"
            key(b"\x1b[6~")
            assert (
                "page-model-7" in screen.selected(left=27, bottom=22)
            ), "Model Page Down did not jump 16 grouped rows"
            key(b"\x1b[5~")
            assert (
                "deepseek-v4.1-flash" in screen.selected(left=27, bottom=22)
            ), "Model Page Up failed"
            assert "Enabled" in "".join(c[0] for c in screen.cells[5][27:116]) and (
                "opencode-go" in "".join(c[0] for c in screen.cells[6][27:116])
            ), "Page Up did not restore the Enabled and category headings at row zero"
            key(b"\x1b[F")
            assert "page-model-40" in screen.selected(left=27, bottom=22), "Model End failed"
            key(b"\x1b[H")
            assert "Enabled" in "".join(c[0] for c in screen.cells[5][27:116]), "End then Home did not reach row zero"
            assert "".join(c[0] for c in screen.cells[6][28:39]) == "opencode-go", "Home hid the first category heading"
            assert "".join(c[0] for c in screen.cells[7][28:49]) == "  deepseek-v4.1-flash", "Home lost the model indent"
            key(b"\x1b[Z")
            key(b"w")
            assert "page-model-40" in screen.selected(left=27, bottom=22), "Up did not cross back into Enabled"
            assert "All models" in "".join(c[0] for c in screen.cells[7][27:116]) and (
                "opencode-go" in "".join(c[0] for c in screen.cells[8][27:116])
            ), "Up from the first All models row hid its title or category heading"
            key(b"\x1b[H")
            key(b"\x1b[C")
            assert (
                "7 days" in screen.selected(top=23, bottom=24) and "606.2k" in screen.text()
            ), "Week tab failed"
            week_chart = chart_bars()
            assert (
                week_chart != today_chart and "most 295.2k   avg 88.6k   least 0" in screen.text()
            ), "Chart did not select last seven days"
            key(b"d")
            assert (
                "30 days" in screen.selected(top=23, bottom=24) and "512.4k" in screen.text()
            ), "Month tab failed"
            assert (
                chart_bars() != week_chart and "most 295.2k   avg 72.2k   least 0" in screen.text()
            ), "Chart did not select last thirty days"
            key(b"\x1b[C")
            assert (
                "All time" in screen.selected(top=23, bottom=24)
                and "1.8M" in screen.text()
                and "most 295.2k   avg 65.5k   least 0" in screen.text()
            ), "All time did not select total usage and every daily entry"
            key(b"d")
            assert (
                "Today" in screen.selected(top=23, bottom=24)
                and "352.2k" in screen.text()
                and chart_bars() == today_chart
            ), "Right did not wrap All time back to Today and its hourly chart"
            key(b"dd")
            key(b"s")
            assert (
                "Kimi K2.7" in screen.text() and "256.2k" in screen.text()
            ), "Stats did not follow selection and retain tab"
            key(b"a")
            assert "7 days" in screen.selected(top=23, bottom=24), "A tab shortcut failed"
            key(b"\x1b[D")
            assert (
                "Today" in screen.selected(top=23, bottom=24)
                and "96.0k" in screen.text()
                and "most 8.0k   avg 4.0k   least 0" in screen.text()
            ), "Left tab failed"
            key(b"a")
            assert (
                "All time" in screen.selected(top=23, bottom=24) and "1.5M" in screen.text()
            ), "Left did not wrap Today back to All time"
            key(b"a")
            assert "30 days" in screen.selected(top=23, bottom=24), "Tabs do not wrap"
            screen.save(snapshots, "models-stats")
            no_subpage_particles()
            if measure:
                start, started, byte_start = stats(), time.monotonic(), len(output)
                drain(5.0)
                seconds, end = time.monotonic() - started, stats()
                metrics["models_idle_bytes_per_second"] = round((len(output) - byte_start) / seconds, 1)
                if start and end:
                    cpu = (end[0] - start[0]) / os.sysconf("SC_CLK_TCK")
                    metrics["models_cpu_percent_one_core"] = round(100 * cpu / seconds, 3)
            key(b"d")
            requests = [json.loads(line) for line in log.read_text().splitlines()]
            assert all(r["params"].get("model") for r in requests if r["method"] == "models.stats"), (
                "Stats request omitted the highlighted model"
            )
            key(b"s\r", 0.2)
            assert "> Disable" in screen.text(), "Model action popup missing"
            popup_text = "\n".join("".join(c[0] for c in row[39:81]) for row in screen.cells[4:11])
            assert "Sessions" not in popup_text and "Tokens" not in popup_text, "Popup still contains stats"
            screen.status_bar(sidebar=True)
            screen.save(snapshots, "models-popup")
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 80, 0, 0))
            screen = Screen(80, 28)
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.12)
            assert (
                "Avg. session time" in screen.text() and "most " not in screen.text()
            ), "Chart was not dropped before stats rows"
            for tab, label in enumerate(("Today", "7d", "30d", "All")):
                assert label == "".join(c[0] for c in screen.cells[14][48 + tab * 7 : 48 + tab * 7 + len(label)]), (
                    "Narrow tab label was truncated or overlapped"
                )
            assert "All" in screen.selected(top=14, bottom=15), "Narrow active tab highlight is missing"
            screen.status_bar(sidebar=True)
            screen.save(snapshots, "models-stats-no-chart")
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            screen = Screen(80, 24)
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.12)
            assert "Sessions" in screen.text() and "Tokens" in screen.text(), "Compact stats panel missing"
            assert "Avg. session time" not in screen.text(), "Short terminal kept full stats panel"
            for tab, label in enumerate(("Today", "7d", "30d", "All")):
                assert label == "".join(c[0] for c in screen.cells[17][49 + tab * 7 : 49 + tab * 7 + len(label)]), (
                    "Compact stats tab label was truncated or overlapped"
                )
            assert "All" in screen.selected(top=17, bottom=18), "Compact active tab highlight is missing"
            screen.status_bar(sidebar=True)
            screen.save(snapshots, "models-popup-compact")
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            screen = Screen()
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.12)
            key(b"\r", 0.2)
            assert "Saved" in "".join(c[0] for c in screen.cells[36]), "Saved message is not on status line"
            key(b"\r", 0.2)
            assert "> Enable" in screen.text(), "Model toggle did not update action"
            key(b"\r", 0.2)
            assert (
                "All models" in screen.text() and "glm-5.2" in screen.selected(left=27, bottom=22)
            ), "Enabling moved the cursor out of All models"
            key(b"\x1b[Zss")
            assert (
                "glm-5.2" in screen.selected(left=27, bottom=22)
            ), "Enabled duplicate did not update"
            assert "on" in screen.selected(left=27, bottom=22), "Enabled duplicate has stale state"
            key(b"\x1b[Zss")
            assert "glm-5.2" in screen.selected(left=27, bottom=22), "All models duplicate moved"
            assert "on" in screen.selected(left=27, bottom=22), "All models duplicate has stale state"
            key(b"\r")
            key(b"q")
            key(b"\x1b[H\x1b[Zsssssss\r", 0.2)
            assert (
                "Anthropic, never offered" in screen.text() and "Avg. session time" in screen.text()
            ), "Blocked model reason or bottom stats missing"
            assert (
                "> Enable" not in screen.text() and "> Disable" not in screen.text()
            ), "Blocked popup exposes a toggle"
            screen.save(snapshots, "anthropic-popup")
            writes_before = sum(
                json.loads(line)["method"] == "models.set" for line in log.read_text().splitlines()
            )
            key(b"\r")
            writes_after = sum(
                json.loads(line)["method"] == "models.set" for line in log.read_text().splitlines()
            )
            assert writes_before == writes_after, "Blocked model wrote config"
            key(b"q")
            key(b"s\r", 0.2)
            assert (
                "Anthropic, never offered" in screen.text() and "Avg. session time" in screen.text()
            ), "Blocked row reason or bottom stats missing"
            assert (
                "> Enable" not in screen.text() and "> Disable" not in screen.text()
            ), "Blocked model popup exposes a toggle"
            key(b"q")
            key(b"q")
            key(b"q", 0.3)
            assert "Settings" in screen.text() and "Models" in screen.text(), "Home return failed"
            if not no_anim:
                assert output.rfind(enabled) > output.rfind(disabled), "Returning home did not enable mouse"
            key(b"s\r", 0.7)
            assert "Sections" in screen.text(), "Settings page missing"
            screen.status_bar(sidebar=True)
            key(b"w")
            assert "Harnesses" in screen.selected(right=25), "Settings sidebar does not wrap upward"
            key(b"s")
            assert "General" in screen.selected(right=25), "Settings sidebar does not wrap downward"
            key(b"\x1b[F\x1b[5~")
            assert "General" in screen.selected(right=25), "Settings sidebar End and Page Up failed"
            key(b"\x1b[6~")
            assert "Harnesses" in screen.selected(right=25), "Settings sidebar Page Down failed"
            assert "".join(c[0] for c in screen.cells[5][28:33]) == "Codex", "Harness heading moved unexpectedly"
            wait_for(lambda: screen.cells[5][28][1] == (182, 197, 210), "Harness heading did not finish fading in")
            assert screen.cells[5][28][1] == (182, 197, 210) and screen.cells[6][28][1] == (78, 173, 245), (
                "Harness headings and inactive labels have the wrong colors"
            )
            assert screen.cells[7][38][1] == (62, 78, 94), "Harness values are not dim"
            assert any(
                path + " (found automatically)" in screen.text()
                for path in ("/usr/local/bin/codex", "/opt/detected/bin/codex")
            ), "Found harness location missing"
            selection_before_detection = screen.selected()
            drain(1.1)
            assert "/opt/detected/bin/codex (found automatically)" in screen.text(), "Late harness detection did not refresh"
            assert screen.selected() == selection_before_detection, "Late harness detection moved the selection"
            assert "Location: not found" in screen.text(), "Missing harness location did not say not found"
            assert not "".join(c[0] for c in screen.cells[8][27:115]).strip(), "Harness groups have no blank separator"
            key(b"\r")
            before = screen.selected(left=27)
            key(b"\x1b[<0;31;6M")
            assert screen.selected(left=27) == before, "Harness heading click changed selection"
            key(b"w")
            assert "Location: not found" in screen.selected(left=27) and (
                "".join(c[0] for c in screen.cells[25][28:33]) == "Crush"
            ), "Settings items do not wrap upward to Crush Location"
            key(b"s")
            assert "Status: Enabled" in screen.selected(left=27) and (
                "".join(c[0] for c in screen.cells[5][28:33]) == "Codex"
            ), "Settings items do not wrap downward to Codex Status"
            key(b"\x1b[F")
            assert "Location: not found" in screen.selected(left=27), "Settings items End failed"
            key(b"\x1b[H")
            assert "Codex" in "".join(c[0] for c in screen.cells[5][27:116]), "Settings Home hid the first heading"
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 80, 0, 0))
            screen = Screen(80, 20)
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.12)
            key(b"\x1b[6~")
            assert (
                "Location: not found" in screen.selected(left=19, bottom=14)
                and "opencode" in "".join(c[0] for c in screen.cells[11][19:76])
            ), "Settings Page Down did not jump nine grouped rows to opencode Location"
            key(b"\x1b[5~")
            assert "Status: Enabled" in screen.selected(left=19, bottom=14) and (
                "Codex" in "".join(c[0] for c in screen.cells[5][19:76])
            ), "Settings Page Up failed to restore Codex and its first item"
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            screen = Screen()
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.12)
            key(b"q\x1b[H")
            screen.save(snapshots, "settings")
            assert "Claude profiles" in screen.text() and "Allowed: ~/.claude, ~/.claude-work" in screen.text(), (
                "General settings did not show their group and joined list values"
            )
            key(b"\r\r")
            key(b"w")
            assert "+ Add item" in screen.selected(left=28), "List picker does not wrap upward"
            key(b"s")
            assert "Remove: ~/.claude" in screen.selected(left=28), "List picker does not wrap downward"
            key(b"\x1b[F")
            assert "+ Add item" in screen.selected(left=28), "List picker End failed"
            key(b"\x1b[H\x1b[6~")
            assert "+ Add item" in screen.selected(left=28), "List picker Page Down failed"
            key(b"\x1b[5~")
            assert "Remove: ~/.claude" in screen.selected(left=28), "List picker Page Up failed"
            key(b"\r", 0.2)
            key(b"\r")
            key(b"s\r")
            key(b"profilewasdeq\r", 0.2)
            key(b"q")
            key(b"s\r")
            key(b"\r", 0.2)
            key(b"\r", 0.2)
            key(b"s\r")
            key(b"\x1b[F")
            last_option = screen.selected(left=28)
            key(b"s")
            first_option = screen.selected(left=28)
            assert last_option != first_option, "Choice picker does not wrap downward"
            key(b"w")
            assert screen.selected(left=28) == last_option, "Choice picker does not wrap upward"
            key(b"\x1b[H")
            assert screen.selected(left=28) == first_option, "Choice picker Home failed"
            key(b"\x1b[6~")
            assert screen.selected(left=28) == last_option, "Choice picker Page Down failed"
            key(b"\x1b[5~")
            assert screen.selected(left=28) == first_option, "Choice picker Page Up failed"
            key(b"s\r", 0.2)
            key(b"s\r")
            key(b"w\r", 0.2)
            key(b"q")
            key(b"s\r")
            key(b"\r")
            key(b"\x1b[H\x1b[3~\x1b[3~45\r", 0.2)
            key(b"q")
            key(b"s\r")
            key(b"s\r")
            key(b"/opt/wasdeq\r", 0.2)
            assert "/opt/wasdeq (set by you)" in screen.text(), "Explicit harness location did not say set by you"
            requests = [json.loads(line) for line in log.read_text().splitlines()]
            writes = [r for r in requests if r["method"] == "settings.set"]
            assert any(
                r["params"]["value"] == ["~/.claude-work", "profilewasdeq"] for r in writes
            ), "List editor shortcut letters failed"
            assert any(r["params"]["key"] == "handback.model" for r in writes), "Model picker failed"
            assert any(r["params"]["value"] == "/opt/wasdeq" for r in writes), "Text editor failed"
            assert any(r["params"]["value"] == 45 for r in writes), "Number editor failed"
            assert any(r["params"]["key"] == "handback.effort" for r in writes), "Choice picker failed"
            assert any(r["method"] == "models.set" for r in requests), "Model toggle failed"
            assert all(r["params"].get("model") for r in requests if r["method"] == "models.stats"), (
                "Stats request omitted the highlighted model"
            )
            assert sum(
                r["method"] == "models.stats" and r["params"]["provider"] == "codex" for r in requests
            ) >= 2, "Returning to a provider didn't ask for fresh stats (live updates would stay on the old one)"
            assert (
                sum(r["method"] == "models.list" and r["params"]["provider"] == "opencode" for r in requests)
                >= 2
            ), "Pending discovery did not refresh"
            os.kill(process.pid, signal.SIGTSTP)
            wait_stopped(process, drain)
            assert_terminal_restored(slave, original, "Suspend did not restore terminal")
            os.kill(process.pid, signal.SIGCONT)
            drain(0.15)
            assert terminal_settings(slave) != original, "Continue did not reenter raw mode"
            os.write(master, b"\x1a")
            wait_stopped(process, drain)
            assert_terminal_restored(slave, original, "Ctrl-Z did not restore terminal")
            os.kill(process.pid, signal.SIGCONT)
            drain(0.15)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.12)
            key(b"q")
            key(b"q", 0.3)
            os.write(master, b"q")
            wait_exited(process, master, output)
            drain(0.05)
            assert process.returncode == 0, "UI did not exit cleanly"
            assert_terminal_restored(slave, original, "Terminal settings were not restored")
            assert b"\x1b[?25h\x1b[?1049l" in output, "Cursor or alternate screen was not restored"
            assert disabled in output and output.rfind(disabled) > output.rfind(enabled), "Exit did not disable mouse"
            metrics.update(
                binary_bytes=binary.stat().st_size,
                rpc_requests=len(requests),
                settings_writes=len(writes),
                terminal_restored=True,
                exit_code=process.returncode,
            )
            print(json.dumps(metrics, indent=2))
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)


def check_error_page_and_signals(binary):
    env = dict(
        os.environ,
        TERM="xterm-256color",
        COLORTERM="truecolor",
        TERM_PROGRAM="Apple_Terminal",
        BITFROST_NO_ANIM="1",
        BITFROST_NO_MOUSE="1",
    )
    for name in ("BITFROST_TUI_BROKER", "BITFROST_NODE", "BITFROST_ENTRY"):
        env.pop(name, None)
    for action in (b"\x1b", b"\x03", signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        original = terminal_settings(slave)
        process = subprocess.Popen([str(binary)], stdin=slave, stdout=slave, stderr=slave, env=env)
        data = bytearray()
        try:
            deadline = time.monotonic() + 0.3
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if ready:
                    data.extend(os.read(master, 65536))
            assert b"BitFrost helper not found" in data, "Missing-helper error page absent"
            assert b"\x1b[?1003h" not in data and b"\x1b[?1006h" not in data, "Environment static mode enabled mouse"
            assert b"\x1b[38;5;" in data, "Apple Terminal did not use color fallback"
            assert b"\x1b[38;2;" not in data, "Apple Terminal used unsupported RGB output"
            if isinstance(action, bytes):
                os.write(master, action)
            else:
                os.kill(process.pid, action)
            wait_exited(process, master, data)
            assert process.returncode == 0, "Signal or escape did not exit cleanly"
            assert_terminal_restored(slave, original, "Signal or escape did not restore terminal")
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)
    print("Missing-helper page, escape deadline, Ctrl-C, signal cleanup and Apple color fallback passed")


def check_mouse_signal_cleanup(binary):
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
    for name in ("BITFROST_TUI_BROKER", "BITFROST_NODE", "BITFROST_ENTRY", "BITFROST_NO_ANIM", "BITFROST_NO_MOUSE"):
        env.pop(name, None)
    for action in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGABRT, signal.SIGSEGV,
                   signal.SIGBUS, signal.SIGILL, signal.SIGFPE):
        master, slave = pty.openpty()
        original = terminal_settings(slave)
        process = subprocess.Popen(
            [str(binary)], stdin=slave, stdout=slave, stderr=slave, env=env,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_CORE, (0, 0)),
        )
        data = bytearray()
        try:
            deadline = time.monotonic() + 0.15
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if ready:
                    data.extend(os.read(master, 65536))
            assert b"\x1b[?1006h\x1b[?1003h" in data, "Animated home did not enable mouse before signal"
            os.kill(process.pid, action)
            try:
                wait_exited(process, master, data)
            except subprocess.TimeoutExpired as error:
                raise AssertionError(f"UI did not exit after {signal.Signals(action).name}") from error
            while select.select([master], [], [], 0)[0]:
                data.extend(os.read(master, 65536))
            assert b"\x1b[?1003l\x1b[?1006l" in data, "Signal did not disable mouse"
            assert b"\x1b[?25h\x1b[?1049l" in data, "Signal did not restore cursor and screen"
            assert_terminal_restored(slave, original, "Signal did not restore termios")
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)
    print("Animated mouse signal and crash cleanup passed")


def check_mouse_opt_out(binary):
    for arguments, variables in ((["--no-mouse"], {}), ([], {"BITFROST_NO_MOUSE": "1"}),
                                  (["--no-mouse", "--no-anim"], {}),
                                  (["--no-mouse", "--no-anim", "--resume"], {})):
        master, slave = pty.openpty()
        original = terminal_settings(slave)
        env = dict(os.environ, TERM="xterm-256color")
        for name in ("BITFROST_TUI_BROKER", "BITFROST_NODE", "BITFROST_ENTRY", "BITFROST_NO_MOUSE", "BITFROST_NO_ANIM"):
            env.pop(name, None)
        env.update(variables)
        process = subprocess.Popen([str(binary)] + arguments, stdin=slave, stdout=slave, stderr=slave, env=env)
        data = bytearray()

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if ready:
                    data.extend(os.read(master, 65536))

        try:
            drain(0.15)
            if "--resume" in arguments:
                assert b"\x1b[2J" not in data and b"\x1b[?1049h" in data, "Standalone resume cleared instead of drawing its frame"
            os.kill(process.pid, signal.SIGTSTP)
            wait_stopped(process, drain)
            assert_terminal_restored(slave, original, "Mouse opt-out suspend did not restore terminal")
            os.kill(process.pid, signal.SIGCONT)
            drain(0.12)
            os.kill(process.pid, signal.SIGTERM)
            wait_exited(process, master, data)
            drain(0.05)
            assert_terminal_restored(slave, original, "Mouse opt-out exit did not restore terminal")
            assert b"\x1b[?1003" not in data and b"\x1b[?1006" not in data, "Mouse opt-out sent mouse modes"
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)
    print("Mouse opt-out flag, environment and static mode passed")


def run_mouse_path(binary, no_anim):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    original = terminal_settings(slave)
    screen, output = Screen(), bytearray()
    with tempfile.TemporaryDirectory(prefix="bitfrost-tui-mouse-") as temporary:
        log = Path(temporary) / "requests.ndjson"
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor",
                   BITFROST_TUI_BROKER="node " + str(Path(__file__).with_name("fake-broker.mjs").resolve()),
                   BITFROST_FAKE_LOG=str(log))
        env.pop("BITFROST_NO_ANIM", None)
        env.pop("BITFROST_NO_MOUSE", None)
        env.pop("BITFROST_PRETEND_VERSION", None)
        process = subprocess.Popen([str(binary)] + (["--no-anim"] if no_anim else []),
                                   stdin=slave, stdout=slave, stderr=slave, env=env)

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if ready:
                    data = os.read(master, 65536)
                    output.extend(data)
                    screen.feed(data)

        def report(button, x, y, delay=0.15):
            os.write(master, ("\x1b[<" + str(button) + ";" + str(x + 1) + ";" + str(y + 1) + "M").encode())
            if button == 0:
                os.write(master, ("\x1b[<0;" + str(x + 1) + ";" + str(y + 1) + "m").encode())
            drain(delay)

        def selected_model_row():
            for y, row in enumerate(screen.selected(left=27, bottom=22).splitlines()):
                if row.strip():
                    return y
            raise AssertionError("No selected model row")

        def back(delay=0.4):
            text = "".join(cell[0] for cell in screen.cells[37])
            x = text.find("[Tab]")
            assert x >= 0, "No clickable Controls hint"
            report(0, x + 1, 37, 0.1)
            assert "Keyboard & Mouse" in screen.text() and "Navigation" in screen.text(), "Controls hint did not open its overlay"
            report(0, x + 1, 37, 0.1)
            os.write(master, b"\x1b")
            drain(delay)

        try:
            drain(0.35)
            report(0, 56, 24, 0.7)
            assert "Providers" in screen.text(), "Mouse home click did not open Models"
            report(0, 5, 11, 0.4)
            assert "OpenCode" in screen.selected(right=25), "Mouse did not select provider"
            report(0, 32, 6)
            assert "> Disable" not in screen.text(), "Category heading click opened a model popup"
            report(0, 32, 7)
            assert "> Disable" in screen.text(), "Mouse model click did not open popup"
            report(0, 45, 7, 0.3)
            requests = [json.loads(line) for line in log.read_text().splitlines()]
            assert any(r["method"] == "models.set" and r["params"]["enabled"] is False for r in requests), "Mouse Disable did not write"
            report(0, 32, selected_model_row())
            assert "> Enable" in screen.text(), "Selected model click did not reopen popup"
            report(0, 2, 2)
            assert "> Enable" not in screen.text(), "Outside popup click did not close it"
            before = ["".join(c[0] for c in row[27:116]) for row in screen.cells[5:22]]
            stats_before = "".join(c[0] for c in screen.cells[23][27:60])
            report(65, 32, 7)
            after = ["".join(c[0] for c in row[27:116]) for row in screen.cells[5:22]]
            assert after[0][:-2] == before[3][:-2], "Wheel did not scroll the view by three rows"
            assert stats_before == "".join(c[0] for c in screen.cells[23][27:60]), "Wheel changed selected model stats"
            for _ in range(80):
                report(65, 32, 7, 0)
            drain(0.2)
            last = ["".join(c[0] for c in row[27:116]) for row in screen.cells[5:22]]
            report(65, 32, 7)
            assert ["".join(c[0] for c in row[27:116]) for row in screen.cells[5:22]] == last, "Wheel wrapped at list end"
            for _ in range(120):
                report(64, 32, 7, 0)
            drain(0.2)
            top = screen.selected(left=27, bottom=22)
            assert "Enabled" in "".join(c[0] for c in screen.cells[5][27:116]), "Wheel did not restore row zero"
            assert "opencode-go" in "".join(c[0] for c in screen.cells[6][27:116]), "Wheel hid the first category"
            assert "kimi-k2.7-code" in "".join(c[0] for c in screen.cells[7][27:116]), "Wheel did not show the first Enabled model"
            report(64, 32, 7)
            assert screen.selected(left=27, bottom=22) == top, "Wheel wrapped at the grouped top"
            tab = screen.selected(top=23, bottom=24)
            report(65, 90, 23)
            assert screen.selected(top=23, bottom=24) == tab, "Wheel changed stats tabs"
            back()
            back()
            assert "Models" in screen.text() and "Providers" not in screen.text(), "Mouse Back did not return home"
            back(0.05)
            wait_exited(process, master, output)
            drain(0.05)
            assert process.returncode == 0 and terminal_settings(slave) == original, "Mouse path did not restore terminal"
            assert output.rfind(b"\x1b[?1003l\x1b[?1006l") > output.rfind(b"\x1b[?1006h\x1b[?1003h"), "Mouse path exit left reporting on"
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)
    print("Mouse-only home, provider, model action, popup dismissal, wheel and Back path passed")


def run_update_path(binary, no_anim, failure=None, no_mouse=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    original = terminal_settings(slave)
    screen, output = Screen(), bytearray()
    seen_steps = set()
    labels = ["Release", "Checksum", "Unpacked", "BitFrost TUI", "Command",
              "Kept your config", "Claude Code plugin", "Helper"]
    with tempfile.TemporaryDirectory(prefix="bitfrost-tui-update-") as temporary:
        log = Path(temporary) / "requests.ndjson"
        events = Path(temporary) / "events.ndjson"
        launches = Path(temporary) / "launches.ndjson"
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor",
                   BITFROST_TUI_BROKER="node " + str(Path(__file__).with_name("fake-broker.mjs").resolve()),
                   BITFROST_FAKE_LOG=str(log), BITFROST_FAKE_EVENT_LOG=str(events),
                   BITFROST_PRETEND_VERSION="0.9.0", BITFROST_TEST_BINARY=str(binary),
                   BITFROST_FAKE_LAUNCH_LOG=str(launches),
                   BITFROST_LAUNCHER=str(Path(__file__).with_name("reload-launcher.py").resolve()))
        env.pop("BITFROST_NO_MOUSE", None)
        env.pop("BITFROST_TUI_TERMIOS", None)
        env["BITFROST_NO_ANIM"] = "0"
        if failure == "unset":
            env.pop("BITFROST_LAUNCHER", None)
        elif failure == "exec":
            env["BITFROST_LAUNCHER"] = str(Path(temporary) / "missing-launcher")
        arguments = [str(binary)] + (["--no-anim"] if no_anim else []) + (["--no-mouse"] if no_mouse else [])
        process = subprocess.Popen(arguments, stdin=slave, stdout=slave, stderr=slave, env=env)

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if ready:
                    data = os.read(master, 65536)
                    output.extend(data)
                    screen.feed(data)
                    area = "\n".join("".join(c[0] for c in row[69:117]) for row in screen.cells[2:35])
                    seen_steps.update(label for label in labels if label in area)

        def requests():
            return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

        try:
            deadline = time.monotonic() + 3
            while "New version available: 0.9.2" not in screen.text() and time.monotonic() < deadline:
                drain(0.05)
            assert "New version available: 0.9.2" in screen.text(), "Version check did not show the update notice"
            assert "Update" in "".join(c[0] for c in screen.cells[33][107:117]), "Update button moved"
            assert sum(r["method"] == "update.check" for r in requests()) == 1, "Home checked more than once"
            os.write(master, b"\x1b[C")
            drain(0.12)
            assert "Update" in screen.selected(top=33, bottom=34), "Right did not focus Update"
            os.write(master, b"ee")
            drain(0.2)
            assert "Providers" not in screen.text(), "Double press activated the underlying menu"
            os.write(master, b"\x1b[<0;110;34M\x1b[<0;110;34m")
            deadline = time.monotonic() + 9
            expected = "Restart bitfrost to use 0.9.2" if failure else "Updated to 0.9.2"
            while time.monotonic() < deadline:
                drain(0.05)
                status = "".join(c[0] for c in screen.cells[36])
                if expected in status and (failure or "Restarting" not in status):
                    break
            status = "".join(c[0] for c in screen.cells[36])
            assert expected in status and "Restarting" not in status, "Update did not reach its reload or fallback"
            assert seen_steps == set(labels), "Installer did not display all eight steps: " + repr(seen_steps)
            recorded = [json.loads(line) for line in events.read_text().splitlines()]
            progress = [r["params"] for r in recorded if r.get("method") == "update.step"]
            assert [(p["index"], p["state"]) for p in progress] == [
                (i, state) for i in range(8) for state in ("running", "done")
            ], "Simulated installer steps were not running then done in order"
            runs = [r for r in requests() if r["method"] == "update.run"]
            assert len(runs) == 1 and runs[0]["params"] == {"version": "0.9.2"}, "Update guard or update params failed"
            if failure:
                assert not launches.exists(), "Failed launcher unexpectedly executed"
                drain(0.3)
                assert "Restart bitfrost to use 0.9.2" in screen.text(), "Fallback was overwritten"
            else:
                assert json.loads(launches.read_text()) == ["config", "--resume", "--message=Updated to 0.9.2"], "Reload arguments changed"
                assert output.count(b"\x1b[?1049h") == 1 and b"\x1b[?1049l" not in output, "Reload left or re-entered alternate screen"
                assert output.count(b"\x1b[2J") == 1, "Reload cleared the terminal and flashed"
                assert b"\x1b[?1003l" not in output and b"\x1b[?1006l" not in output, "Reload reset mouse modes"
                assert "fake.closed" in [r.get("method") for r in recorded], "First broker did not exit on EOF"
                assert process.poll() is None and terminal_settings(slave) != original, "Resumed TUI is not running in raw mode"
                deadline = time.monotonic() + 2
                while sum(r["method"] == "update.check" for r in requests()) < 2 and time.monotonic() < deadline:
                    drain(0.05)
                assert sum(r["method"] == "update.check" for r in requests()) == 2, "Resumed process did not check once"
                assert "Models" in screen.selected(), "Resume did not open the completed home frame"
                if no_anim:
                    drain(0.15)
                    before = len(output)
                    drain(0.2)
                    assert len(output) == before, "Reload lost the command-line animation opt-out"
            os.write(master, b"q")
            wait_exited(process, master, output)
            drain(0.05)
            assert process.returncode == 0 and terminal_settings(slave) == original, "Update path did not restore original terminal settings"
            if no_mouse:
                assert not any(sequence in output for sequence in
                               (b"\x1b[?1003h", b"\x1b[?1006h", b"\x1b[?1003l", b"\x1b[?1006l")), "Reload lost the command-line mouse opt-out"
            else:
                assert output.rfind(b"\x1b[?1003l\x1b[?1006l") > output.rfind(b"\x1b[?1006h\x1b[?1003h"), "Update path left mouse modes enabled"
            assert output.endswith(b"\x1b[?1049l"), "Update path did not leave alternate screen on quit"
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)
    print("Simulated update " + (failure + " fallback" if failure else "and in-place exec reload") +
          (" with CLI opt-outs" if no_mouse else "") + " passed")


def run_configuration_path(binary, no_anim, snapshots=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    original = terminal_settings(slave)
    screen, output = Screen(), bytearray()
    with tempfile.TemporaryDirectory(prefix="bitfrost-tui-configuration-") as temporary:
        log = Path(temporary) / "requests.ndjson"
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor",
                   BITFROST_TUI_BROKER="node " + str(Path(__file__).with_name("fake-broker.mjs").resolve()),
                   BITFROST_FAKE_LOG=str(log), BITFROST_FAKE_NEW_SETTINGS="1")
        env.pop("BITFROST_NO_ANIM", None)
        env.pop("BITFROST_PRETEND_VERSION", None)
        process = subprocess.Popen([str(binary)] + (["--no-anim"] if no_anim else []),
                                   stdin=slave, stdout=slave, stderr=slave, env=env)

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if ready:
                    data = os.read(master, 65536)
                    output.extend(data)
                    screen.feed(data)

        def key(value):
            os.write(master, value)
            drain(0.15)

        try:
            drain(0.5)
            assert "Configure new settings" in screen.text(), "Pending settings action missing"
            key(b"de")
            assert "1 • 2 • 3 • 4 • Confirm" in screen.text(), "Stepper header missing"
            key(b"s")
            assert "Compact" in screen.selected(), "W/S did not choose a wizard option"
            screen.save(snapshots, "configuration-question")
            key(b"e")
            key(b"a")
            assert "Compact" in screen.selected(), "A did not revisit the saved draft"
            key(b"\t")
            assert "Previous / Next step" in screen.text(), "Wizard controls are missing"
            key(b"\t")
            key(b"d")
            key(b"e")
            key(b"e")
            key(b"e")
            assert "Review your choices" in screen.text(), "Wizard recap missing"
            assert "Compact" in screen.text() and "Preview startup" in screen.text(), "Recap omitted answers"
            screen.save(snapshots, "configuration-recap")
            requests = [json.loads(line) for line in log.read_text().splitlines()]
            assert not any(r["method"] == "settings.configure" for r in requests), "Draft was committed early"
            key(b"q")
            assert "Configure new settings" in screen.text(), "Cancel lost pending settings"
            key(b"e")
            for _ in range(4):
                key(b"e")
            key(b"e")
            assert "Configure new settings" not in screen.text(), "Successful recap did not clear pending settings"
            writes = [json.loads(line) for line in log.read_text().splitlines()
                      if json.loads(line)["method"] == "settings.configure"]
            assert len(writes) == 1 and len(writes[0]["params"]["answers"]) == 4, "Recap did not save all four answers together"
            key(b"q")
            wait_exited(process, master, output)
            assert_terminal_restored(slave, original, "Configuration path did not restore terminal")
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)
    print("New settings wizard navigation, recap, cancellation and save passed")


if __name__ == "__main__":
    # A real controller on the test machine must not steer the screens under test.
    os.environ["BITFROST_NO_GAMEPAD"] = "1"
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--measure", action="store_true")
    parser.add_argument("--snapshots")
    parser.add_argument("--no-anim", action="store_true")
    args = parser.parse_args()
    run(
        args.binary.resolve(),
        Path(__file__).with_name("fake-broker.mjs").resolve(),
        args.measure,
        args.snapshots,
        args.no_anim,
    )
    check_error_page_and_signals(args.binary.resolve())
    check_mouse_signal_cleanup(args.binary.resolve())
    check_mouse_opt_out(args.binary.resolve())
    run_mouse_path(args.binary.resolve(), args.no_anim)
    run_configuration_path(args.binary.resolve(), args.no_anim, args.snapshots)
    run_update_path(args.binary.resolve(), args.no_anim)
    run_update_path(args.binary.resolve(), args.no_anim, "unset")
    run_update_path(args.binary.resolve(), args.no_anim, "exec")
    run_update_path(args.binary.resolve(), True, no_mouse=True)
