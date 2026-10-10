// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"
#include "term/input.hpp"

namespace bf {
    class TextEditor {
        void previous();
        void next();

      public:
        std::string value;
        size_t cursor = 0;
        void reset(std::string text);
        void input(const Input &event);
        void click(int column, int width);
        void draw(Grid &grid, int x, int y, int width) const;
    };
}
