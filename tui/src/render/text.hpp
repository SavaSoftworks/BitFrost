// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include <string>
#include <string_view>
#include <vector>

namespace bf {
    struct Rune {
        std::string bytes;
        int width;
    };
    std::vector<Rune> runes(std::string_view s);
    int text_width(std::string_view s);
    std::string ellipsis(std::string_view s, int width);
    std::string middle_ellipsis(std::string_view s, int width);
}
