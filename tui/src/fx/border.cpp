// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "border.hpp"
#include "mosaic.hpp"
#include <cmath>

namespace bf {
    void border(Grid &grid, double time) {
        if (grid.width < 4 || grid.height < 4) {
            return;
        }
        grid.box(1, 1, grid.width - 2, grid.height - 2);
        auto shade = [&](int x, int y) {
            double angle = std::atan2((y - grid.height / 2.0) * 2, x - grid.width / 2.0) + time * 0.10;
            double phase = (angle / (2 * 3.141592653589793) + 1) * 3;
            phase -= std::floor(phase / 3) * 3;
            int palette_index = int(phase);
            double fraction = phase - palette_index;
            auto start_color = mosaic_palette[size_t(palette_index)],
                 end_color = mosaic_palette[size_t((palette_index + 1) % 3)];
            grid.cells[size_t(y * grid.width + x)].fg = {
                uint8_t(start_color.r * (1 - fraction) + end_color.r * fraction),
                uint8_t(start_color.g * (1 - fraction) + end_color.g * fraction),
                uint8_t(start_color.b * (1 - fraction) + end_color.b * fraction)
            };
        };
        for (int x = 1; x < grid.width - 1; ++x) {
            shade(x, 1);
            shade(x, grid.height - 2);
        }
        for (int y = 2; y < grid.height - 2; ++y) {
            shade(1, y);
            shade(grid.width - 2, y);
        }
    }
}
