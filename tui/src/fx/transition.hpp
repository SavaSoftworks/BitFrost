// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"

namespace bf {
    enum class Transition { None, Exit, Enter };
    inline constexpr double home_exit_seconds = 0.42;
    inline constexpr double page_enter_seconds = 0.22;
    double ease_out(double progress);
    void fade_slide(Grid &grid, double progress);
}
