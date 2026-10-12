// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "sidebar.hpp"
#include "fx/glyphs.hpp"
#include <algorithm>

namespace bf {
    int status_row(const Grid &grid) {
        return grid.height - 5;
    }

    void
    status_bar(Grid &grid, std::string_view message, std::string_view hints, std::string_view version, double fade) {
        if (grid.width < 8 || grid.height < 8) {
            return;
        }
        int row = status_row(grid);
        grid.rect(2, row, grid.width - 4, 3, black);
        for (int x = 2; x < grid.width - 2; ++x) {
            grid.put(x, row, "─", blue);
        }
        grid.text(3, row + 1, ellipsis(message, grid.width - 6), blend(white, fade));
        // The version sits right aligned on the hints row, and the hints give way to it.
        int version_width = version.empty() ? 0 : text_width(version) + 2;
        if (version_width && version_width < grid.width - 6) {
            grid.text(grid.width - 3 - text_width(version), row + 2, version, dim);
        } else {
            version_width = 0;
        }
        grid.text(3, row + 2, ellipsis(hints, grid.width - 6 - version_width), dim);
    }

    PageLayout sidebar_layout(Grid &grid, std::string_view sidebar_title, std::string_view page_title) {
        int width = std::clamp(grid.width / 5, 16, 27);
        for (int row = 2; row < status_row(grid); ++row) {
            grid.put(width + 1, row, "│", blue);
        }
        int sidebar_y = 5;
        if (grid.height >= 24) {
            int logo_rows = compact_logo(grid, 3, 3, width - 3);
            sidebar_y = 6 + logo_rows;
        } else {
            grid.text(3, 2, "BitFrost", blue, black, width - 3);
        }
        grid.text(3, sidebar_y - 2, sidebar_title, dim, black, width - 3);
        grid.text(width + 3, 3, page_title);
        return {width, width + 3, grid.width - width - 7, grid.height - 10, sidebar_y, status_row(grid) - sidebar_y};
    }
}
