// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "grid.hpp"
#include <algorithm>

namespace bf {
    Grid::Grid(int columns, int rows)
        : width(std::clamp(columns, 1, 1000)),
          height(std::clamp(rows, 1, 500)),
          cells(size_t(width * height)) {}

    void Grid::clear() {
        std::fill(cells.begin(), cells.end(), Cell{});
    }

    void
    Grid::put(int x, int y, std::string glyph, Color foreground, Color background, bool continuation, bool underline) {
        if (writable(x, y)) {
            cells[size_t(y * width + x)] = {std::move(glyph), foreground, background, continuation, underline};
        }
    }

    void
    Grid::text(int x, int y, std::string_view text, Color foreground, Color background, int max_width, bool underline) {
        int end_column = max_width < 0 ? width : std::min(width, x + max_width);
        int previous_column = -1;
        for (auto &rune : runes(text)) {
            if (rune.width == 0) {
                if (writable(previous_column, y)) {
                    cells[size_t(y * width + previous_column)].glyph += rune.bytes;
                }
                continue;
            }
            if (x + rune.width > end_column) {
                break;
            }
            if (writable(x, y) && writable(x + rune.width - 1, y)) {
                put(x, y, rune.bytes, foreground, background, false, underline);
                if (rune.width == 2) {
                    put(x + 1, y, "", foreground, background, true, underline);
                }
                previous_column = x;
            }
            x += rune.width;
        }
    }

    void Grid::rect(int x, int y, int rect_width, int rect_height, Color background) {
        for (int row = std::max(0, y); row < std::min(height, y + rect_height); ++row) {
            for (int column = std::max(0, x); column < std::min(width, x + rect_width); ++column) {
                put(column, row, " ", blue, background);
            }
        }
    }

    void Grid::box(int x, int y, int box_width, int box_height, Color foreground) {
        if (box_width < 2 || box_height < 2) {
            return;
        }
        for (int offset_x = 1; offset_x < box_width - 1; ++offset_x) {
            put(x + offset_x, y, "─", foreground);
            put(x + offset_x, y + box_height - 1, "─", foreground);
        }
        for (int offset_y = 1; offset_y < box_height - 1; ++offset_y) {
            put(x, y + offset_y, "│", foreground);
            put(x + box_width - 1, y + offset_y, "│", foreground);
        }
        put(x, y, "┌", foreground);
        put(x + box_width - 1, y, "┐", foreground);
        put(x, y + box_height - 1, "└", foreground);
        put(x + box_width - 1, y + box_height - 1, "┘", foreground);
    }

    void Grid::pixel(int x, int y, Color color) {
        if (y < 0 || !writable(x, y / 2)) {
            return;
        }
        auto &cell = cells[size_t((y / 2) * width + x)];
        Color top = black, bottom = black;
        if (cell.glyph == "▀") {
            top = cell.fg;
            bottom = cell.bg;
        } else if (cell.glyph == "▄") {
            bottom = cell.fg;
            top = cell.bg;
        }
        if (y % 2) {
            bottom = color;
        } else {
            top = color;
        }
        cell = {"▀", top, bottom, false};
    }
}
