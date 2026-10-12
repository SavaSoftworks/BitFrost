// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "hit.hpp"
#include <algorithm>

namespace bf {
    void HitMap::clear(int width, int height) {
        targets.clear();
        scroll_regions.clear();
        popup.reset();
        bounds = {2, 2, width - 4, height - 4};
    }

    void HitMap::add(Rect rect, HitKind kind, int index) {
        targets.push_back({rect, kind, index});
    }

    void HitMap::scroll(Rect rect, HitKind kind) {
        scroll_regions.push_back({rect, kind, 0});
    }

    void HitMap::modal(Rect rect) {
        targets.clear();
        scroll_regions.clear();
        popup = rect;
    }

    void HitMap::shift(int columns) {
        for (auto *entries : {&targets, &scroll_regions}) {
            for (Hit &hit : *entries) {
                hit.rect.x += columns;
            }
        }
        if (popup) {
            popup->x += columns;
        }
    }

    std::optional<Hit> HitMap::at(MousePosition point, bool wheel) const {
        // The persistent Controls hint remains clickable above any modal popup.
        if (!wheel && bounds.contains(point)) {
            for (auto hit = targets.rbegin(); hit != targets.rend(); ++hit) {
                if (hit->kind == HitKind::Controls && hit->rect.contains(point)) {
                    return *hit;
                }
            }
        }
        if (popup && !popup->contains(point)) {
            return wheel ? std::nullopt : std::optional<Hit>{{bounds, HitKind::Back, 0}};
        }
        if (!bounds.contains(point)) {
            return std::nullopt;
        }
        const auto &entries = wheel ? scroll_regions : targets;
        for (auto hit = entries.rbegin(); hit != entries.rend(); ++hit) {
            if (hit->rect.contains(point)) {
                return *hit;
            }
        }
        return std::nullopt;
    }

    void HitMap::hover(Grid &grid, std::optional<MousePosition> point) const {
        auto target = point ? at(*point) : std::nullopt;
        if (!target || (popup && !popup->contains(*point) && target->kind != HitKind::Controls) ||
            target->kind == HitKind::Editor) {
            return;
        }
        const Rect &rect = target->rect;
        for (int y = std::max(2, rect.y); y < std::min(grid.height - 2, rect.y + rect.height); ++y) {
            for (int x = std::max(2, rect.x); x < std::min(grid.width - 2, rect.x + rect.width); ++x) {
                Cell &cell = grid.cells[size_t(y * grid.width + x)];
                if (target->kind == HitKind::Setting && cell.fg == dim) {
                    continue;
                }
                if (cell.fg != black && cell.glyph != " " && cell.glyph != "▀" && cell.glyph != "▄") {
                    cell.fg = {210, 225, 240};
                }
            }
        }
    }
}
