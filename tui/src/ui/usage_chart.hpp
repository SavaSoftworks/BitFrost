// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"
#include "rpc/json.hpp"

namespace bf {
    struct UsageChart {
        std::vector<double> tokens;
        std::vector<int> levels;
        double most = 0, average = 0, least = 0;
    };
    UsageChart usage_chart(const Json &daily, int days, int width, int height);
    void draw_usage_chart(Grid &grid, int x, int y, int width, int height, const Json &daily, int days);
}
