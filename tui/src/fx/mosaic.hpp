// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"
#include <array>

namespace bf {
    inline constexpr std::array<Color, 3> mosaic_palette{{{76, 181, 246}, {47, 149, 234}, {43, 123, 220}}};
    uint32_t tile_hash(uint32_t value);
    Color mosaic(int x, int pixel_y, double time, int tile = 4);
}
