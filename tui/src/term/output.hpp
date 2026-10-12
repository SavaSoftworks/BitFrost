// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"

namespace bf {
    class Diff {
        Grid previous;
        bool invalid = true, truecolor;

      public:
        explicit Diff(bool truecolor = true)
            : truecolor(truecolor) {}
        void reset() {
            invalid = true;
        }
        std::string frame(const Grid &grid);
    };
    bool write_all(int descriptor, std::string_view bytes);
    inline constexpr std::string_view mouse_enable = "\033[?1006h\033[?1003h";
    inline constexpr std::string_view mouse_disable = "\033[?1003l\033[?1006l";
    inline constexpr std::string_view terminal_restore =
        "\033[?1003l\033[?1006l\033[?1004l\033[?2026l\033[0m\033[?25h\033[?1049l";
    inline constexpr std::string_view keyboard_restore = "\033[?1004l\033[?2026l\033[0m\033[?25h\033[?1049l";
    class MouseReporting {
        bool enabled = false;

      public:
        std::string_view update(bool wanted) {
            if (wanted == enabled) {
                return {};
            }
            enabled = wanted;
            return enabled ? mouse_enable : mouse_disable;
        }
    };
}
