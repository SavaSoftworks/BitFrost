// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "fx/glyphs.hpp"
#include "fx/mosaic.hpp"
#include "ui/list.hpp"
#include <algorithm>

namespace bf {
    void App::draw_home(Grid &grid, double opacity, bool leaving) {
        PixelFont font = grid.width >= 63 && grid.height >= 24 ? PixelFont::Bold : PixelFont::Logo;
        // The big logo waits for a wide terminal, not just one it fits in.
        int scale = grid.width >= std::max(160, pixel_text_width("BITFROST", 2, font) + 8) && grid.height >= 36 ? 2 : 1;
        bool logo = grid.width >= 55 && grid.height >= 22;
        int logo_width = logo ? pixel_text_width("BITFROST", scale, font) : 8;
        int logo_height = pixel_text_height(scale, font);
        int logo_x = (grid.width - logo_width) / 2;
        int menu_height = (int(home_items.size()) - 1) * 2 + 3;
        int logo_y = std::max(2, (grid.height - logo_height / 2 - menu_height - 5) / 2);
        int logo_bottom = 2;
        double fade = leaving ? 1 - std::clamp(elapsed / 0.22, 0.0, 1.0) : opacity;
        if (logo) {
            pixel_text(grid, logo_x, logo_y * 2, "BITFROST", scale, clock, fade, font);
            int version_width = pixel_text_width(BITFROST_VERSION, 1, PixelFont::Small);
            int version_y = logo_y * 2 + logo_height + 2;
            if (scale > 1) {
                pixel_text(
                    grid,
                    logo_x + logo_width - version_width,
                    version_y,
                    BITFROST_VERSION,
                    1,
                    clock,
                    fade,
                    PixelFont::Small
                );
                logo_bottom = (version_y + pixel_text_height(1, PixelFont::Small) + 1) / 2;
            } else {
                grid.text(
                    logo_x + logo_width - int(std::string_view(BITFROST_VERSION).size()),
                    logo_y + (logo_height + 1) / 2 + 1,
                    BITFROST_VERSION,
                    blend(blue, fade)
                );
                logo_bottom = logo_y + (logo_height + 1) / 2 + 2;
            }
            if (animations) {
                emitters.push_back({logo_x, logo_y * 2, logo_height, fade, inner_region(grid), true});
            }
        } else if (grid.height >= 20) {
            grid.text(logo_x, logo_y, "BitFrost", blend(blue, fade));
            grid.text(
                logo_x + 8 - int(std::string_view(BITFROST_VERSION).size()),
                logo_y + 1,
                BITFROST_VERSION,
                blend(dim, fade)
            );
            logo_bottom = logo_y + 2;
        }
        int menu_width = 0;
        for (const HomeItem &item : home_items) {
            menu_width = std::max(menu_width, text_width(item.label) + 4);
        }
        // On narrow terminals the corner action sits below the menu instead of
        // sharing its rows, so the longer configuration label cannot cover it.
        int action_width = pending_settings && !update.busy ? 26 : 10;
        bool stack_action =
            (pending_settings || !update.version.empty()) && (grid.width - menu_width) / 2 - 6 < action_width;
        int menu_bottom = grid.height - 5 - (stack_action ? 4 : 0);
        int menu_top = std::min(logo_bottom, menu_bottom - menu_height);
        int menu_y = menu_top + (menu_bottom - menu_top - menu_height) / 2 + 1;
        logo_boundary = {2, 4, grid.width - 2, (menu_y - 1) * 2};
        for (int item_index = 0; item_index < int(home_items.size()); ++item_index) {
            bool selected = !update.focused && home_selection == item_index;
            double amount = leaving ? ease_out((elapsed - item_index * 0.07) / 0.27) : 0;
            int menu_x = (grid.width - menu_width) / 2 - int(amount * grid.width / 2);
            int menu_item_y = menu_y + item_index * 2;
            hits.add(
                {menu_x, menu_item_y - (selected ? 1 : 0), menu_width, selected ? 3 : 1},
                HitKind::Home,
                item_index
            );
            double item_opacity = (1 - amount) * opacity;
            if (selected) {
                highlight(
                    grid,
                    menu_x,
                    menu_item_y,
                    menu_width,
                    home_items[size_t(item_index)].label,
                    clock,
                    item_opacity,
                    2
                );
                for (int column = 0; column < menu_width; ++column) {
                    int x = menu_x + column;
                    grid.put(x, menu_item_y - 1, "▄", blend(mosaic(x, menu_item_y * 2 - 1, clock, 1), item_opacity));
                    grid.put(x, menu_item_y + 1, "▀", blend(mosaic(x, menu_item_y * 2 + 2, clock, 1), item_opacity));
                }
                if (animations) {
                    emitters.push_back({menu_x, menu_item_y * 2 - 1, 4, item_opacity, inner_region(grid)});
                }
            } else {
                grid.text(menu_x + 2, menu_item_y, home_items[size_t(item_index)].label, blend(blue, item_opacity));
            }
        }
        draw_update(grid, menu_width, fade);
    }
}
