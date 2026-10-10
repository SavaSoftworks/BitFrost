// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app.hpp"
#include "fx/border.hpp"
#include "rpc/protocol.hpp"
#include "ui/sidebar.hpp"
#include <algorithm>

namespace bf {
    bool App::scrollbars_moving() const {
        return animations && std::any_of(scroll_motions.begin(), scroll_motions.end(), [&](const auto &entry) {
                   return entry.second.moving(clock);
               });
    }

    int App::draw_scrollbar(
        Grid &grid,
        std::string key,
        int x,
        int y,
        int width,
        int height,
        int total,
        int first,
        int visible,
        bool inside
    ) {
        ScrollThumb thumb = scroll_thumb(height, total, first, visible);
        if (thumb.size <= 0) {
            scroll_motions.erase(key);
            return width;
        }
        auto &motion = scroll_motions[key];
        thumb.top = motion.update(thumb.top, clock, animations);
        thumb.top = std::clamp(thumb.top, 0.0, height * 2.0 - thumb.size);
        // The bar sits in the free column right of the content, or inside it within a popup's frame.
        scrollbar(grid, inside ? x + width - 1 : x + width, y, height, thumb);
        return inside ? width - 1 : width;
    }

    void App::render(Grid &grid) {
        for (auto &[key, motion] : scroll_motions) {
            motion.active = false;
        }
        grid.clear();
        grid.clip_inner(true);
        hits.clear(grid.width, grid.height);
        // Home and About shed particles from their wordmark; other pages have none.
        bool shedding = animations && !helper_missing &&
                        (current == Page::Home || (current == Page::Status && status_section == 2 && !status_history));
        if (shedding && !particles) {
            particles = std::make_unique<Particles>();
        } else if (!shedding && current != Page::Home) {
            particles.reset();
        }
        emitters.clear();
        logo_boundary = {};
        if (grid.width < 40 || grid.height < 16 || (current == Page::Home && grid.height < 18)) {
            grid.text(3, std::max(2, grid.height / 2), "BitFrost: enlarge terminal", blue, black, grid.width - 6);
        } else {
            if (particles) {
                particles->draw(grid);
            }
            if (helper_missing) {
                grid.text((grid.width - 24) / 2, grid.height / 2 - 1, "BitFrost helper not found");
                grid.text((grid.width - 24) / 2, grid.height / 2 + 1, "Esc/Q closes this screen", dim);
            } else if (current == Page::Home) {
                draw_home(grid, 1, transition == Transition::Exit);
            } else if (current == Page::Models) {
                draw_models(grid);
            } else if (current == Page::Settings) {
                draw_settings(grid);
            } else {
                draw_status(grid);
            }
            if (transition == Transition::Enter) {
                hits.shift(int((1 - ease_out(elapsed / page_enter_seconds)) * 4));
                fade_slide(grid, elapsed / page_enter_seconds);
            }
        }
        std::string hints = controls_hint();
        grid.clip_inner(true);
        std::string version = current == Page::Home ? "" : "v" BITFROST_VERSION;
        status_bar(
            grid,
            helper_missing ? "BitFrost helper not found" : message,
            hints,
            version,
            helper_missing ? 1 : message_opacity()
        );
        if (controls_open) {
            draw_controls(grid);
        }
        hits.add({3, grid.height - 3, text_width(hints), 1}, HitKind::Controls);
        if (mouse_enabled) {
            hits.hover(grid, pointer);
        }
        grid.clip_inner(false);
        border(grid, clock);
        std::erase_if(scroll_motions, [](const auto &entry) { return !entry.second.active; });
    }
}
