// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include <chrono>
#include <optional>
#include <string>
#include <vector>

namespace bf {
    enum class Key {
        Up,
        Down,
        Left,
        Right,
        Enter,
        Back,
        Interrupt,
        Suspend,
        Backspace,
        Delete,
        Home,
        End,
        PageUp,
        PageDown,
        Tab,
        BackTab,
        Controls,
        Text,
        Mouse,
        FocusIn,
        FocusOut,
        // One row of view scrolling that leaves the selection alone, from the right stick.
        ScrollUp,
        ScrollDown
    };
    struct MousePosition {
        int x = 0;
        int y = 0;
        bool operator==(const MousePosition &) const = default;
    };
    enum class MouseKind { Click, Wheel };
    struct MouseEvent {
        MousePosition position;
        MouseKind kind = MouseKind::Click;
        int delta = 0;
    };
    struct Input {
        Key key;
        std::string text;
        std::optional<MouseEvent> mouse{};
    };
    class InputParser {
        std::string pending;
        std::optional<std::chrono::steady_clock::time_point> escape_at;
        std::optional<std::chrono::steady_clock::time_point> mouse_at;
        bool mouse_sequence = false, mouse_overflow = false;
        std::string mouse_report;
        std::string interrupted_sequence;
        std::optional<MousePosition> mouse;

      public:
        std::vector<Input> feed(std::string_view bytes, bool editing = false);
        std::vector<Input> expire();
        int timeout_ms() const;
        std::optional<MousePosition> take_mouse();
    };
}
