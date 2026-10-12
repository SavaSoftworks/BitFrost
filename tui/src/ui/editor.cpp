// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "editor.hpp"
#include <algorithm>

namespace bf {
    void TextEditor::reset(std::string text) {
        value = std::move(text);
        cursor = value.size();
    }

    void TextEditor::previous() {
        if (cursor == 0) {
            return;
        }
        --cursor;
        while (cursor && (static_cast<unsigned char>(value[cursor]) & 0xc0) == 0x80) {
            --cursor;
        }
    }

    void TextEditor::next() {
        if (cursor >= value.size()) {
            return;
        }
        ++cursor;
        while (cursor < value.size() && (static_cast<unsigned char>(value[cursor]) & 0xc0) == 0x80) {
            ++cursor;
        }
    }

    void TextEditor::input(const Input &event) {
        switch (event.key) {
        case Key::Left:
            previous();
            break;
        case Key::Right:
            next();
            break;
        case Key::Home:
            cursor = 0;
            break;
        case Key::End:
            cursor = value.size();
            break;
        case Key::Backspace: {
            size_t old_cursor = cursor;
            previous();
            value.erase(cursor, old_cursor - cursor);
            break;
        }
        case Key::Delete: {
            size_t old_cursor = cursor;
            next();
            value.erase(old_cursor, cursor - old_cursor);
            cursor = old_cursor;
            break;
        }
        case Key::Text:
            if (value.size() + event.text.size() <= 4096) {
                value.insert(cursor, event.text);
                cursor += event.text.size();
            }
            break;
        default:
            break;
        }
    }

    void TextEditor::click(int column, int width) {
        int offset = std::max(0, text_width(std::string_view(value).substr(0, cursor)) - width + 3);
        int skipped = 0;
        size_t position = 0;
        for (const Rune &rune : runes(value)) {
            if (skipped < offset) {
                skipped += rune.width;
                position += rune.bytes.size();
                continue;
            }
            if (column - 1 < rune.width / 2.0) {
                break;
            }
            column -= rune.width;
            position += rune.bytes.size();
        }
        cursor = position;
    }

    void TextEditor::draw(Grid &grid, int x, int y, int width) const {
        grid.rect(x, y, width, 1, {10, 27, 40});
        auto prefix = std::string_view(value).substr(0, cursor);
        int offset = std::max(0, text_width(prefix) - width + 3);
        std::string visible;
        int skipped = 0;
        for (auto &rune : runes(value)) {
            if (skipped < offset) {
                skipped += rune.width;
                continue;
            }
            visible += rune.bytes;
        }
        grid.text(x + 1, y, ellipsis(visible, width - 2), white, {10, 27, 40});
        int cursor_column = std::clamp(text_width(prefix) - skipped + 1, 1, width - 2);
        auto index = size_t(y * grid.width + x + cursor_column);
        if (grid.writable(x + cursor_column, y)) {
            auto &cell = grid.cells[index];
            cell.bg = blue;
            cell.fg = black;
        }
    }
}
