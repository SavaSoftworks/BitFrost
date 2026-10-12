# Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import errno
import os
import select
import subprocess
import sys
import time
import tty
import unittest
from unittest.mock import Mock, patch

from pty_smoke import cleanup_process, open_pty, read_pty, wait_exited, write_pty


class PtyIOTest(unittest.TestCase):
    def test_empty_master_never_blocks_and_child_slave_stays_blocking(self):
        master, slave = open_pty()
        try:
            self.assertFalse(os.get_blocking(master))
            self.assertTrue(os.get_blocking(slave))
            self.assertEqual(read_pty(master), b"")
        finally:
            os.close(master)
            os.close(slave)

    def test_eof_and_platform_hangup_results(self):
        with patch("pty_smoke.os.read", return_value=b""):
            self.assertEqual(read_pty(123), b"")
        for code in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EIO):
            with self.subTest(code=code), patch("pty_smoke.os.read", side_effect=OSError(code, "PTY not ready")):
                self.assertEqual(read_pty(123), b"")
        with patch("pty_smoke.os.read", side_effect=OSError(errno.EBADF, "Closed descriptor")):
            with self.assertRaises(OSError):
                read_pty(123)

    def test_exit_deadline_survives_false_readiness(self):
        master, slave = open_pty()
        process = Mock(args=["still-running"], returncode=None)
        process.poll.return_value = None
        try:
            with patch("pty_smoke.select.select", return_value=([master], [], [])):
                with self.assertRaises(subprocess.TimeoutExpired):
                    wait_exited(process, master, bytearray(), timeout=0.02)
        finally:
            os.close(master)
            os.close(slave)

    def test_final_output_is_drained_and_eof_ends_the_loop(self):
        reader, writer = os.pipe()
        os.set_blocking(reader, False)
        restoration = b"\x1b[?25h\x1b[?1049l"
        os.write(writer, restoration)
        os.close(writer)
        process = Mock(args=["exited"], returncode=0)
        process.poll.return_value = 0
        output = bytearray()
        try:
            self.assertEqual(wait_exited(process, reader, output), 0)
            self.assertEqual(output, restoration)
        finally:
            os.close(reader)

    def test_input_retries_backpressure_and_partial_writes_without_losing_bytes(self):
        blocked = BlockingIOError(errno.EAGAIN, "Input queue full")
        would_block = BlockingIOError(errno.EWOULDBLOCK, "Input queue full")
        drain = Mock()
        with patch("pty_smoke.os.write", side_effect=[blocked, 2, would_block, 1, 2]) as write:
            with patch("pty_smoke.select.select", return_value=([], [123], [])):
                write_pty(123, b"abcde", drain)
        self.assertEqual([bytes(call.args[1]) for call in write.call_args_list],
                         [b"abcde", b"abcde", b"cde", b"cde", b"de"])
        self.assertEqual(drain.call_count, 2)

    def test_input_deadline_survives_false_writability(self):
        with patch("pty_smoke.os.write", side_effect=BlockingIOError(errno.EAGAIN, "Input queue full")):
            with patch("pty_smoke.select.select", return_value=([], [123], [])):
                with self.assertRaisesRegex(TimeoutError, "PTY input stalled with 3 bytes unsent"):
                    write_pty(123, b"abc", Mock(), timeout=0.02)

    def test_input_propagates_unexpected_write_errors(self):
        for code in (errno.EBADF, errno.EIO):
            with self.subTest(code=code), patch("pty_smoke.os.write", side_effect=OSError(code, "Closed PTY")):
                with self.assertRaises(OSError) as raised:
                    write_pty(123, b"abc", Mock())
                self.assertEqual(raised.exception.errno, code)

    def test_saturated_input_and_output_queues_make_progress_together(self):
        master, slave = open_pty()
        tty.setraw(slave)
        # The child fills output before reading input. Sending more than the
        # input queue holds requires the parent to drain output during retries.
        script = """import os, sys
sys.stdout.buffer.write(b'output' * 16384)
sys.stdout.buffer.flush()
expected = b'input' * 16384
received = bytearray()
while len(received) < len(expected):
    received.extend(os.read(0, len(expected) - len(received)))
assert received == expected
sys.stdout.buffer.write(b'done')
sys.stdout.buffer.flush()
"""
        process = subprocess.Popen([sys.executable, "-c", script], stdin=slave, stdout=slave, stderr=slave)
        output = bytearray()
        drains = 0

        def drain(seconds):
            nonlocal drains
            drains += 1
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                    output.extend(read_pty(master))

        try:
            write_pty(master, b"input" * 16384, drain)
            self.assertEqual(wait_exited(process, master, output), 0)
            self.assertGreater(drains, 0, "The test did not saturate the input queue")
            self.assertEqual(output, b"output" * 16384 + b"done")
        finally:
            cleanup_process(process, master)
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    unittest.main()
