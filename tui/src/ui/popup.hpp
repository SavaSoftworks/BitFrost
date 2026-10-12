// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"

namespace bf {
    struct Popup {
        int x;
        int y;
        int width;
        int height;
    };
    void popup_frame(Grid &grid, const Popup &popup, std::string_view title);
    void popup_footer(Grid &grid, const Popup &popup, std::string_view text);
}
