// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"

namespace bf {
    struct ScrollThumb {
        double top = 0, size = 0;
    };
    ScrollThumb scroll_thumb(int height, int total, double first, int visible);
    void scrollbar(Grid &, int x, int y, int height, ScrollThumb);
    class ScrollMotion {
        double origin = 0, target = 0, started = 0;
        bool initialized = false;

      public:
        bool active = false;
        double value(double now) const;
        double update(double top, double now, bool animations);
        bool moving(double now) const;
    };
}
