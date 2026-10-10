// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "fx/mosaic.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <cmath>

namespace bf {
    void App::draw_update(Grid &grid, int menu_width, double opacity) {
        if (update.version.empty()) {
            return;
        }
        constexpr int button_width = 10;
        constexpr double button_fade_seconds = 0.22;
        int right = grid.width - 3;
        int bottom = grid.height - 7;
        int left = grid.width / 2 + menu_width / 2 + 3;
        int width = right - left;
        auto button = [&](double fade) {
            int x = right - button_width;
            if (update.focused || update.busy) {
                highlight(grid, x, bottom, button_width, "Update", clock, fade, 2);
                for (int column = x; column < right; ++column) {
                    grid.put(column, bottom - 1, "▄", blend(mosaic(column, bottom * 2 - 1, clock, 1), fade));
                    grid.put(column, bottom + 1, "▀", blend(mosaic(column, bottom * 2 + 2, clock, 1), fade));
                }
                if (animations && fade > 0) {
                    emitters.push_back({x, bottom * 2 - 1, 4, fade, inner_region(grid)});
                }
            } else {
                grid.text(x + 2, bottom, "Update", blend(blue, fade));
            }
        };
        if (!update.busy) {
            std::string notice = ellipsis("New version available: " + update.version, width);
            grid.text(right - text_width(notice), bottom - 2, notice, blend(dim, opacity));
            button(opacity);
            hits.add(
                {right - button_width, bottom - (update.focused ? 1 : 0), button_width, update.focused ? 3 : 1},
                HitKind::Update
            );
            return;
        }
        if (animations && update.age < button_fade_seconds && !update.finished) {
            button(opacity * (1 - update.age / button_fade_seconds));
            return;
        }
        if (update.finished) {
            std::string text = ellipsis("Updated to " + update.version + ". Restarting...", width);
            grid.text(right - text_width(text), bottom, text, blend(blue, opacity));
            return;
        }
        int top = std::clamp(logo_boundary.bottom / 2, 2, bottom);
        int count = std::min(int(update.steps.size()), bottom - top + 1);
        int first = int(update.steps.size()) - count;
        constexpr std::array<std::string_view, 4> spinner{"◴", "◷", "◶", "◵"};
        for (int row = 0; row < count; ++row) {
            const UpdateStep &step = update.steps[size_t(first + row)];
            if (step.label.empty()) {
                continue;
            }
            int y = bottom - count + 1 + row;
            std::string label = ellipsis(step.label, std::max(1, width - 3));
            std::string detail = ellipsis(step.detail, std::max(0, width - text_width(label) - 4));
            int x = right - 2 - text_width(label) - (detail.empty() ? 0 : 2 + text_width(detail));
            constexpr Color amber{230, 180, 80}, red{230, 105, 105};
            bool running = step.state == "running";
            auto symbol = running                ? spinner[size_t(int(update.age * 8) % 4)]
                          : step.state == "warn" ? std::string_view("!")
                          : step.state == "fail" ? std::string_view("✗")
                          : step.state == "note" ? std::string_view("-")
                                                 : std::string_view("✓");
            Color color = running                ? mosaic_palette[size_t(int(update.age * 8) % 3)]
                          : step.state == "warn" ? amber
                          : step.state == "fail" ? red
                          : step.state == "note" ? dim
                                                 : blue;
            grid.text(x, y, symbol, blend(color, opacity));
            grid.text(x + 2, y, label, blend(blue, opacity));
            grid.text(x + 4 + text_width(label), y, detail, blend(dim, opacity));
        }
    }
}
