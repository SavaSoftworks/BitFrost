// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "caps.hpp"
#include <cstdlib>
#include <string_view>

namespace bf {
    bool truecolor_terminal() {
        const char *program = std::getenv("TERM_PROGRAM");
        if (program && std::string_view(program) == "Apple_Terminal") {
            return false;
        }
        const char *colorterm = std::getenv("COLORTERM");
        return colorterm && (std::string_view(colorterm) == "truecolor" || std::string_view(colorterm) == "24bit");
    }
}
