// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include <cstdint>

namespace bf {
    struct Color {
        uint8_t r = 0, g = 0, b = 0;
        bool operator==(const Color &) const = default;
    };
    inline constexpr Color black{}, blue{78, 173, 245}, dim{62, 78, 94}, white{182, 197, 210};
    Color blend(Color c, double alpha);
    int quantize(Color c);
}
