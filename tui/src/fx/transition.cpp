// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "transition.hpp"
#include <algorithm>

namespace bf {
    double ease_out(double progress) {
        progress = std::clamp(progress, 0.0, 1.0);
        return 1 - (1 - progress) * (1 - progress) * (1 - progress);
    }

    void fade_slide(Grid &grid, double progress) {
        double opacity = ease_out(progress);
        int shift = int((1 - opacity) * 4);
        Grid faded(grid.width, grid.height);
        for (int y = 2; y < grid.height - 2; ++y) {
            for (int x = 2; x < grid.width - 2 - shift; ++x) {
                if (x + 1 < grid.width && grid.cells[size_t(y * grid.width + x + 1)].continuation &&
                    x + 1 >= grid.width - 2 - shift) {
                    continue;
                }
                Cell cell = grid.cells[size_t(y * grid.width + x)];
                cell.fg = blend(cell.fg, opacity);
                cell.bg = blend(cell.bg, opacity);
                faded.cells[size_t(y * grid.width + x + shift)] = std::move(cell);
            }
        }
        grid = std::move(faded);
    }
}
