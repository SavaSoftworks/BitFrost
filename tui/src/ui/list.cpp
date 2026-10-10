// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "list.hpp"
#include "fx/mosaic.hpp"
#include <algorithm>

namespace bf {
    bool list_navigation(Key key) {
        return key == Key::Up || key == Key::Down || key == Key::PageUp || key == Key::PageDown || key == Key::Home ||
               key == Key::End || key == Key::Tab || key == Key::BackTab;
    }

    bool select_first_visible(int &selected, Key key, int first, int visible, std::span<const int> selectable) {
        if ((key != Key::Up && key != Key::Down) || (selected >= first && selected < first + visible)) {
            return false;
        }
        auto top = std::lower_bound(selectable.begin(), selectable.end(), first);
        if (top == selectable.end() || *top >= first + visible) {
            return false;
        }
        selected = *top;
        return true;
    }

    void ListView::input(int &selected, Key key, int count, int visible) {
        int top = first_row(selected, count, visible);
        const int selectable[]{top};
        if (!following && count > 0 && select_first_visible(selected, key, top, visible, selectable)) {
            return;
        }
        navigate(selected, key, size_t(count), visible);
        if (list_navigation(key)) {
            follow();
        }
    }

    int ListView::first_row(int selected, int count, int visible) {
        visible = std::max(1, visible);
        first = std::clamp(first, 0, std::max(0, count - visible));
        if (following) {
            if (selected < first) {
                first = selected;
            } else if (selected >= first + visible) {
                first = selected - visible + 1;
            }
        }
        return first = std::clamp(first, 0, std::max(0, count - visible));
    }

    void ListView::scroll(int delta, int count, int visible) {
        following = false;
        first = std::clamp(first + delta, 0, std::max(0, count - std::max(1, visible)));
    }

    namespace {
        void
        row_text(Grid &grid, int x, int y, std::string_view text, Color foreground, int width, bool underline = false) {
            int previous_column = -1;
            for (const Rune &rune : runes(ellipsis(text, width))) {
                if (rune.width == 0) {
                    if (grid.writable(previous_column, y)) {
                        grid.cells[size_t(y * grid.width + previous_column)].glyph += rune.bytes;
                    }
                    continue;
                }
                if (grid.writable(x, y) && grid.writable(x + rune.width - 1, y)) {
                    const Cell &cell = grid.cells[size_t(y * grid.width + x)];
                    Color background = cell.glyph == "▀" ? cell.fg : cell.bg;
                    grid.put(x, y, rune.bytes, foreground, background, false, underline);
                    if (rune.width == 2) {
                        grid.put(x + 1, y, "", foreground, background, true, underline);
                    }
                    previous_column = x;
                }
                x += rune.width;
            }
        }
    }

    void list_text(Grid &grid, int x, int y, std::string_view text, Color color, int width, bool underline) {
        row_text(grid, x, y, text, color, width, underline);
    }

    void navigate(int &position, Key key, size_t count, int page_rows) {
        if (!count) {
            position = 0;
            return;
        }
        int last = int(count) - 1;
        switch (key) {
        case Key::Up:
            position = position ? position - 1 : last;
            break;
        case Key::Down:
            position = position == last ? 0 : position + 1;
            break;
        case Key::Home:
            position = 0;
            break;
        case Key::End:
            position = last;
            break;
        case Key::PageUp:
            position = std::max(0, position - std::max(1, page_rows));
            break;
        case Key::PageDown:
            position = std::min(last, position + std::max(1, page_rows));
            break;
        default:
            break;
        }
    }

    void
    highlight(Grid &grid, int x, int y, int width, std::string_view text, double time, double opacity, int padding) {
        for (int column = 0; column < width; ++column) {
            grid.put(
                x + column,
                y,
                "▀",
                blend(mosaic(x + column, y * 2, time, 1), opacity),
                blend(mosaic(x + column, y * 2 + 1, time, 1), opacity)
            );
        }
        row_text(grid, x + padding, y, text, black, width - padding * 2);
    }

    void property_row(
        Grid &grid,
        int x,
        int y,
        int width,
        std::string_view label,
        std::string_view value,
        bool active,
        double time
    ) {
        if (active) {
            highlight(grid, x, y, width, "", time);
        }
        std::string caption = std::string(label) + ":";
        int label_width = std::min(text_width(caption), std::max(0, width - 3));
        list_text(grid, x + 1, y, caption, active ? black : blue, label_width);
        list_text(
            grid,
            x + label_width + 2,
            y,
            middle_ellipsis(value, width - label_width - 3),
            active ? black : dim,
            width - label_width - 3
        );
    }

    void list_item(Grid &grid, int x, int y, int width, const ListRow &row, double time) {
        if (y < 3 || y >= grid.height - 3) {
            return;
        }
        Color foreground = row.muted ? dim : blue;
        if (row.active) {
            highlight(grid, x, y, width, "", time, row.muted ? 0.35 : 1);
            foreground = black;
        }
        int state_width = row.state.empty() ? 0 : 5;
        int tag_width = std::min(text_width(row.tag), std::max(0, width - 18));
        int label_width = std::max(0, width - 2 - state_width - (tag_width ? tag_width + 2 : 0));
        row_text(grid, x + 1, y, row.label, foreground, label_width);
        if (tag_width) {
            row_text(grid, x + width - state_width - tag_width - 1, y, row.tag, foreground, tag_width);
        }
        if (state_width) {
            row_text(grid, x + width - text_width(row.state) - 1, y, row.state, foreground, 3);
        }
    }
}
