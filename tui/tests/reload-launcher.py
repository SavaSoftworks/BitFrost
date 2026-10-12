#!/usr/bin/env python3
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

import json
import os
import sys

assert sys.argv[1] == "config"
assert sys.argv[2:] == ["--resume", "--message=Updated to 0.9.2"]
with open(os.environ["BITFROST_FAKE_LAUNCH_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
os.environ.pop("BITFROST_PRETEND_VERSION", None)
binary = os.environ["BITFROST_TEST_BINARY"]
os.execv(binary, [binary, *sys.argv[2:]])
