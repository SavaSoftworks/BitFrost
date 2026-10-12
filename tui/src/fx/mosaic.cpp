// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "mosaic.hpp"
#include <cmath>

namespace bf {
    uint32_t tile_hash(uint32_t value) {
        value ^= value >> 16;
        value *= 0x7feb352d;
        value ^= value >> 15;
        value *= 0x846ca68b;
        return value ^ (value >> 16);
    }

    Color mosaic(int x, int pixel_y, double time, int tile) {
        int world_x = int(std::floor((x + time * 3.0) / tile));
        int world_y = int(std::floor(double(pixel_y) / tile));
        return mosaic_palette[tile_hash(uint32_t(world_x) ^ (uint32_t(world_y) * 0x9e3779b9)) % mosaic_palette.size()];
    }
}
