// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "scrollbar.hpp"
#include <algorithm>
#include <cmath>

namespace bf {
    ScrollThumb scroll_thumb(int height, int total, double first, int visible) {
        if (height <= 0 || visible <= 0 || total <= visible) {
            return {};
        }
        double track = height * 2.0;
        double size = std::clamp(track * visible / total, 1.0, track);
        double top = first >= total - visible ? track - size : track * std::max(0.0, first) / total;
        return {std::clamp(top, 0.0, track - size), size};
    }

    void scrollbar(Grid &grid, int x, int y, int height, ScrollThumb thumb) {
        if (thumb.size <= 0 || height <= 0) {
            return;
        }
        int size = std::clamp(int(std::round(thumb.size)), 1, height * 2);
        int top = std::clamp(int(std::round(thumb.top)), 0, height * 2 - size);
        // A half cell wide thumb with no track, placed by half rows.
        for (int row = 0; row < height; ++row) {
            bool upper = row * 2 >= top && row * 2 < top + size;
            bool lower = row * 2 + 1 >= top && row * 2 + 1 < top + size;
            if (upper || lower) {
                grid.put(x, y + row, upper ? lower ? "▌" : "▘" : "▖", blue);
            }
        }
    }

    double ScrollMotion::value(double now) const {
        double progress = std::clamp((now - started) / 0.15, 0.0, 1.0);
        if (progress >= 1 - 1e-9) {
            return target;
        }
        double ease = 1 - (1 - progress) * (1 - progress) * (1 - progress);
        return origin + (target - origin) * ease;
    }

    double ScrollMotion::update(double top, double now, bool animations) {
        if (!initialized || !animations) {
            origin = target = top;
            initialized = true;
        } else if (target != top) {
            origin = value(now);
            target = top;
            started = now;
        }
        active = true;
        return value(now);
    }

    bool ScrollMotion::moving(double now) const {
        return active && origin != target && now + 1e-9 < started + 0.15;
    }
}
