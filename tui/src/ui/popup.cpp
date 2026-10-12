// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "popup.hpp"

namespace bf {
    void popup_frame(Grid &grid, const Popup &popup, std::string_view title) {
        grid.rect(popup.x, popup.y, popup.width, popup.height, black);
        grid.box(popup.x, popup.y, popup.width, popup.height);
        grid.text(popup.x + 2, popup.y + 1, ellipsis(title, popup.width - 4));
    }

    void popup_footer(Grid &grid, const Popup &popup, std::string_view text) {
        grid.text(popup.x + 2, popup.y + popup.height - 2, text, dim, black, popup.width - 4);
    }
}
