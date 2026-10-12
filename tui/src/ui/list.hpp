// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"
#include "term/input.hpp"
#include <span>

namespace bf {
    struct ListRow {
        std::string_view label;
        bool active = false;
        bool muted = false;
        std::string_view tag{};
        std::string_view state{};
    };
    void navigate(int &position, Key key, size_t count, int page_rows);
    bool list_navigation(Key key);
    bool select_first_visible(int &selected, Key key, int first, int visible, std::span<const int> selectable);
    class ListView {
        int first = 0;
        bool following = true;

      public:
        int first_row(int selected, int count, int visible);
        void input(int &selected, Key key, int count, int visible);
        void scroll(int delta, int count, int visible);
        void follow() {
            following = true;
        }
        void reset() {
            first = 0;
            following = true;
        }
    };
    void list_text(Grid &grid, int x, int y, std::string_view text, Color color, int width, bool underline = false);
    void highlight(
        Grid &grid,
        int x,
        int y,
        int width,
        std::string_view text,
        double time,
        double opacity = 1,
        int padding = 1
    );
    void list_item(Grid &grid, int x, int y, int width, const ListRow &row, double time);
    void property_row(
        Grid &grid,
        int x,
        int y,
        int width,
        std::string_view label,
        std::string_view value,
        bool active,
        double time
    );
}
