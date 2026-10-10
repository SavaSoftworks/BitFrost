<!-- Copyright (C) 2026 Nick Germaine
SPDX-License-Identifier: GPL-3.0-only

BitFrost is free software: you can share and change it under the GNU General
Public License, version 3 only. It comes with no warranty. See LICENSE. -->

# BitFrost TUI

How do I build it? From the repository root:

    cmake -S tui -B tui/build -DCMAKE_BUILD_TYPE=Release
    cmake --build tui/build --parallel 8

How do I run it with the fake broker?

    BITFROST_TUI_BROKER="node $PWD/tui/tests/fake-broker.mjs" tui/build/bitfrost-tui

How do I run the tests?

    tui/build/bitfrost-tui --selftest
    ctest --test-dir tui/build --output-on-failure
    python3 tui/tests/pty_smoke.py tui/build/bitfrost-tui --measure

The native build requires C++20 and CMake. PTY tests use Python and Node.
Use --no-anim to disable animation. Use -DBITFROST_STATIC=ON for static linking.
Use --resume to open the completed home screen without its intro, and
--message=text to set the initial status message.

Home checks for a newer version once after it appears. When an update is
available, its button is in the bottom right. Right from the menu or Down from
Status focuses it. Left returns to the previous menu item; Up returns to Status.
Enter/E or a click starts the simulated installer. The menu remains usable.
Progress and button layout are kept together in src/pages/update.cpp.

To try the simulated update through the normal launcher:

    BITFROST_PRETEND_VERSION=0.9.0 bitfrost

After completion the TUI reloads through BITFROST_LAUNCHER without leaving the
alternate screen. It preserves the original terminal settings for the resumed
process to restore on exit. If the launcher is missing or fails, the TUI stays
open with a restart message. The simulation does not download or install files.

On animated Home, moving the mouse above the menu attracts the logo particles.
Their velocity turns smoothly while preserving speed, lifetime and fade. Menu
particles keep their usual drift. Leaving the logo area restores the usual motion.
Mouse clicks, wheel scrolling and label hover work on all pages, including with
--no-anim. Click an already selected list row again to activate it, or double
click a row. Click outside a popup to close it. The wheel scrolls the list under
the pointer without changing its selection. A click in an editor moves its caret.

Every page shows [Tab] - Controls in its status bar. Tab or a click on that hint
opens the controls overlay without closing a picker or editor underneath it.
Tab or Esc closes the overlay. Shift+Tab switches Enabled/All model sections.
On Linux, the left shoulder button (L, LB or L1) also opens Controls; the right
shoulder switches model sections. Connected controllers appear by name at the
bottom of the overlay, with their button labels in the mappings and status hint.
The Control and Keyboard & Mouse columns list actions and right-aligned mappings.
Connecting a controller adds • Gamepad to the heading and • button mappings to
the rows immediately, including when the overlay is already open. Disconnecting
removes those additions.
Small terminals can scroll the controls with arrows, the wheel or the right stick.

Use --no-mouse or BITFROST_NO_MOUSE=1 for keyboard-only input. This sends no mouse
modes. Otherwise SGR and any-motion reporting stay enabled for the session, with
restoration on suspend, exit and signal cleanup, and re-enabling on resume.

The PTY measurement compares a parked pointer inside and outside the logo area
at 120x40, with two ten-second samples of each after particle warmup, followed by
a ten-second sample moving across the logo and menu at up to 100 reports per
second. It uses the fake broker and does not contact the running helper.
