// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"

namespace bf {
    struct PageLayout {
        int sidebar_width;
        int main_x;
        int main_width;
        int visible_rows;
        int sidebar_y;
        int sidebar_rows;
    };
    PageLayout sidebar_layout(Grid &grid, std::string_view sidebar_title, std::string_view page_title);
    int status_row(const Grid &grid);
    void status_bar(
        Grid &grid,
        std::string_view message,
        std::string_view hints,
        std::string_view version = {},
        double fade = 1
    );
}
