// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "color.hpp"
#include "text.hpp"

namespace bf {
    struct Cell {
        std::string glyph = " ";
        Color fg = blue, bg = black;
        bool continuation = false;
        bool underline = false;
        bool operator==(const Cell &) const = default;
    };
    class Grid {
        bool inner_clip = false;

      public:
        int width, height;
        std::vector<Cell> cells;
        Grid(int w = 1, int h = 1);
        void clear();
        void clip_inner(bool enabled) {
            inner_clip = enabled;
        }
        bool writable(int x, int y) const {
            int inset = inner_clip ? 2 : 0;
            return x >= inset && y >= inset && x < width - inset && y < height - inset;
        }
        void
        put(int x,
            int y,
            std::string glyph,
            Color fg = blue,
            Color bg = black,
            bool continuation = false,
            bool underline = false);
        void text(
            int x,
            int y,
            std::string_view s,
            Color fg = blue,
            Color bg = black,
            int max_width = -1,
            bool underline = false
        );
        void rect(int x, int y, int w, int h, Color bg);
        void box(int x, int y, int w, int h, Color fg = blue);
        void pixel(int x, int y, Color color);
    };
}
