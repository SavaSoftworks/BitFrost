// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "color.hpp"
#include <algorithm>
#include <cmath>

namespace bf {
    Color blend(Color color, double opacity) {
        opacity = std::clamp(opacity, 0.0, 1.0);
        return {uint8_t(color.r * opacity), uint8_t(color.g * opacity), uint8_t(color.b * opacity)};
    }

    int quantize(Color color) {
        constexpr int levels[] = {0, 95, 135, 175, 215, 255};
        auto nearest = [&](int intensity) {
            int best = 0;
            for (int index = 1; index < 6; ++index) {
                if (std::abs(levels[index] - intensity) < std::abs(levels[best] - intensity)) {
                    best = index;
                }
            }
            return best;
        };
        return 16 + 36 * nearest(color.r) + 6 * nearest(color.g) + nearest(color.b);
    }
}
