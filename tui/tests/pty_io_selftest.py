# Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import errno
import os
import subprocess
import unittest
from unittest.mock import patch

from pty_smoke import open_pty, read_pty, wait_exited


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
        process = unittest.mock.Mock(args=["still-running"], returncode=None)
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
        process = unittest.mock.Mock(args=["exited"], returncode=0)
        process.poll.return_value = 0
        output = bytearray()
        try:
            self.assertEqual(wait_exited(process, reader, output), 0)
            self.assertEqual(output, restoration)
        finally:
            os.close(reader)


if __name__ == "__main__":
    unittest.main()
