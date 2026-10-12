// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "glyphs.hpp"
#include "mosaic.hpp"
#include <algorithm>
#include <map>
#include <vector>

namespace bf {
    namespace {
        const std::map<char, std::array<uint8_t, 7>> glyphs{
            {'B', {30, 17, 17, 30, 17, 17, 30}},
            {'I', {31, 4, 4, 4, 4, 4, 31}},
            {'T', {31, 4, 4, 4, 4, 4, 4}},
            {'F', {31, 16, 16, 30, 16, 16, 16}},
            {'R', {30, 17, 17, 30, 20, 18, 17}},
            {'O', {14, 17, 17, 17, 17, 17, 14}},
            {'S', {15, 16, 16, 14, 1, 1, 30}},
            {'0', {14, 17, 19, 21, 25, 17, 14}},
            {'1', {4, 12, 4, 4, 4, 4, 14}},
            {'2', {14, 17, 1, 2, 4, 8, 31}},
            {'3', {30, 1, 1, 14, 1, 1, 30}},
            {'4', {2, 6, 10, 18, 31, 2, 2}},
            {'5', {31, 16, 16, 30, 1, 1, 30}},
            {'6', {14, 16, 16, 30, 17, 17, 14}},
            {'7', {31, 1, 2, 4, 8, 8, 8}},
            {'8', {14, 17, 17, 14, 17, 17, 14}},
            {'9', {14, 17, 17, 15, 1, 1, 14}},
            {'.', {0, 0, 0, 0, 0, 12, 12}}
        };
        const std::map<char, std::array<uint8_t, 5>> small_glyphs{
            {'0', {7, 5, 5, 5, 7}},
            {'1', {2, 6, 2, 2, 7}},
            {'2', {7, 1, 7, 4, 7}},
            {'3', {7, 1, 7, 1, 7}},
            {'4', {5, 5, 7, 1, 1}},
            {'5', {7, 4, 7, 1, 7}},
            {'6', {7, 4, 7, 5, 7}},
            {'7', {7, 1, 1, 1, 1}},
            {'8', {7, 5, 7, 5, 7}},
            {'9', {7, 5, 7, 1, 7}},
            {'.', {0, 0, 0, 0, 2}}
        };
        // Small caps: B and F are full height, the rest are one cell shorter and share the baseline.
        const std::map<char, std::vector<uint8_t>> bold_glyphs{
            {'B', {62, 62, 51, 51, 62, 62, 51, 51, 62, 62}},
            {'F', {63, 63, 48, 48, 62, 62, 48, 48, 48, 48}},
            {'I', {63, 63, 12, 12, 12, 12, 63, 63}},
            {'T', {63, 63, 12, 12, 12, 12, 12, 12}},
            {'R', {62, 62, 51, 51, 62, 62, 54, 51}},
            {'O', {30, 30, 51, 51, 51, 51, 30, 30}},
            {'S', {31, 31, 48, 30, 30, 3, 62, 62}}
        };
    }

    int pixel_text_width(std::string_view text, int scale, PixelFont font) {
        int advance = font == PixelFont::Small ? 4 : font == PixelFont::Bold ? 7 : 6;
        return std::max(0, int(text.size()) * advance - 1) * scale;
    }

    int pixel_text_height(int scale, PixelFont font) {
        return (font == PixelFont::Small ? 5 : font == PixelFont::Bold ? 10 : 7) * scale;
    }

    int compact_logo(Grid &grid, int x, int y, int width) {
        constexpr std::string_view text = "BITFROST";
        int columns = std::min(6, (2 * width - int(text.size()) + 1) / int(text.size()));
        if (columns < 3) {
            grid.text(x + std::max(0, (width - 8) / 2), y, "BitFrost", blue, black, width);
            return 1;
        }
        int pixels = int(text.size()) * (columns + 1) - 1;
        int cells = (pixels + 1) / 2;
        x += (width - cells) / 2;
        // The SVG uses these same small caps. Pair the repeated vertical pixels and pack
        // two columns per cell with quadrant blocks so the wordmark fits the sidebar.
        auto ink = [&](int px, int py) {
            int letter = px / (columns + 1), column = px % (columns + 1);
            if (px >= pixels || column == columns || py >= 5) {
                return false;
            }
            const auto &glyph = bold_glyphs.at(text[size_t(letter)]);
            int row = py * 2 - (10 - int(glyph.size()));
            int source_column = (2 * column + 1) * 6 / (2 * columns);
            return row >= 0 && (glyph[size_t(row)] & (1u << (5 - source_column))) != 0;
        };
        constexpr std::string_view
            blocks[]{" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"};
        for (int row = 0; row < 3; ++row) {
            for (int column = 0; column < cells; ++column) {
                int mask = 0;
                for (int dy = 0; dy < 2; ++dy) {
                    for (int dx = 0; dx < 2; ++dx) {
                        if (ink(column * 2 + dx, row * 2 + dy)) {
                            mask |= 1 << (dy * 2 + dx);
                        }
                    }
                }
                if (mask) {
                    grid.put(x + column, y + row, std::string(blocks[mask]), mosaic(column * 2, row * 2, 0, 3));
                }
            }
        }
        return 3;
    }

    void pixel_text(
        Grid &grid,
        int x,
        int pixel_y,
        std::string_view text,
        int scale,
        double time,
        double opacity,
        PixelFont font
    ) {
        int columns = font == PixelFont::Small ? 3 : font == PixelFont::Bold ? 6 : 5;
        int rows = pixel_text_height(1, font);
        for (char character : text) {
            auto large = glyphs.find(character);
            auto small = small_glyphs.find(character);
            auto bold = bold_glyphs.find(character);
            bool found = font == PixelFont::Small  ? small != small_glyphs.end()
                         : font == PixelFont::Bold ? bold != bold_glyphs.end()
                                                   : large != glyphs.end();
            if (found) {
                int glyph_rows = font == PixelFont::Bold ? int(bold->second.size()) : rows;
                for (int row = rows - glyph_rows; row < rows; ++row) {
                    size_t index = size_t(row - (rows - glyph_rows));
                    uint8_t bits = font == PixelFont::Small  ? small->second[index]
                                   : font == PixelFont::Bold ? bold->second[index]
                                                             : large->second[index];
                    for (int column = 0; column < columns; ++column) {
                        if (!(bits & (1u << (columns - column - 1)))) {
                            continue;
                        }
                        for (int offset_y = 0; offset_y < scale; ++offset_y) {
                            for (int offset_x = 0; offset_x < scale; ++offset_x) {
                                int px = x + column * scale + offset_x;
                                int py = pixel_y + row * scale + offset_y;
                                if (px > 1 && px < grid.width - 2 && py > 3 && py < (grid.height - 2) * 2) {
                                    grid.pixel(px, py, blend(mosaic(px, py, time, 3), opacity));
                                }
                            }
                        }
                    }
                }
            }
            x += (columns + 1) * scale;
        }
    }
}
