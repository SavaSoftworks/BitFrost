// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"

namespace bf {
    enum class PixelFont { Logo, Bold, Small };
    int pixel_text_width(std::string_view text, int scale, PixelFont font = PixelFont::Logo);
    int pixel_text_height(int scale, PixelFont font = PixelFont::Logo);
    int compact_logo(Grid &grid, int x, int y, int width);
    void pixel_text(
        Grid &grid,
        int x,
        int pixel_y,
        std::string_view text,
        int scale,
        double time,
        double opacity = 1,
        PixelFont font = PixelFont::Logo
    );
}
