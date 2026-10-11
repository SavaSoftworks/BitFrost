// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app.hpp"
#include "ui/popup.hpp"
#include <algorithm>

namespace bf {
    bool App::set_controller(std::optional<GamepadInfo> info) {
        if (controller == info) {
            return false;
        }
        controller = std::move(info);
        return true;
    }

    std::string App::controls_hint() const {
        return "[Tab" + (controller ? "/" + std::string(controller->left_shoulder()) : "") + "] - Controls";
    }

    std::vector<std::pair<std::string, std::string>> App::control_mappings() const {
        std::vector<std::pair<std::string, std::string>> rows;
        auto add = [&](std::string action, std::string keyboard, std::string_view pad = {}) {
            if (controller && !pad.empty()) {
                keyboard += " • ";
                keyboard += pad;
            }
            rows.emplace_back(std::move(action), std::move(keyboard));
        };
        add(configuration.open ? "Choose answer" : "Navigation",
            editing()            ? "Left/Right"
            : configuration.open ? "W/S, Up/Down"
                                 : "WASD, Arrows",
            "D-pad/L-Stick");
        if (configuration.open) {
            add("Previous / Next step", "A/D, Left/Right", "D-pad/L-Stick");
        }
        add("Confirm/Select", editing() ? "Enter" : "Enter/E", controller ? controller->confirm() : "");
        add("Back/Cancel", editing() ? "Esc" : "Esc/Q", controller ? controller->cancel() : "");
        if (editing()) {
            add("Start / End of text", "Home/End");
            add("Delete character", "Backspace / Delete");
            add("Enter text", "Keyboard");
        } else {
            if (current != Page::Home || configuration.open) {
                if (mouse_enabled || controller) {
                    add("Scroll", mouse_enabled ? "Mouse wheel" : "—", "R-Stick");
                }
                add("Page", "PgUp/PgDn");
                add("First / Last item", "Home/End");
            }
            if (current == Page::Models && focus.back() == Focus::List) {
                add("Switch model section", "Shift+Tab", controller ? controller->right_shoulder() : "");
                add("Switch stats period", "Left/Right", "D-pad/L-Stick");
            }
        }
        if (mouse_enabled) {
            add(editing() ? "Place cursor" : "Select / Activate item",
                editing() ? "Click field" : "Click / Double-click");
            add("Dismiss popup", "Click outside");
        }
        add("Quit", "Ctrl+C");
        add("Suspend", "Ctrl+Z");
        return rows;
    }

    void App::scroll_controls(int delta) {
        controls_first =
            std::clamp(controls_first + delta, 0, std::max(0, int(control_mappings().size()) - controls_visible));
    }

    void App::draw_controls(Grid &grid) {
        if (grid.width < 20 || grid.height < 10) {
            return;
        }
        const auto rows = control_mappings();
        int width = std::min(86, grid.width - 6);
        int height = std::min(int(rows.size()) + 6, grid.height - 4);
        Popup popup{(grid.width - width) / 2, (grid.height - height) / 2, width, height};
        popup_frame(grid, popup, "");
        hits.modal({popup.x, popup.y, width, height});
        hits.scroll({popup.x, popup.y, width, height}, HitKind::Controls);
        controls_visible = height - 6;
        controls_first = std::clamp(controls_first, 0, std::max(0, int(rows.size()) - controls_visible));
        int content_width = draw_scrollbar(
                                grid,
                                "controls",
                                popup.x + 2,
                                popup.y + 3,
                                width - 3,
                                controls_visible,
                                int(rows.size()),
                                controls_first,
                                controls_visible,
                                true
                            ) -
                            1;
        int action_width = std::min(24, content_width / 2 - 1);
        int mapping_width = content_width - action_width - 2;
        grid.text(popup.x + 2, popup.y + 1, "Control", dim, black, action_width);
        std::string heading = ellipsis(controller ? "Keyboard & Mouse • Gamepad" : "Keyboard & Mouse", mapping_width);
        grid.text(popup.x + 2 + content_width - text_width(heading), popup.y + 1, heading, dim, black, mapping_width);
        for (int index = controls_first; index < int(rows.size()) && index < controls_first + controls_visible;
             ++index) {
            const auto &[action, mapping] = rows[size_t(index)];
            int y = popup.y + 3 + index - controls_first;
            grid.text(popup.x + 2, y, ellipsis(action, action_width), blue, black, action_width);
            std::string keys = ellipsis(mapping, mapping_width);
            grid.text(popup.x + 2 + content_width - text_width(keys), y, keys, white, black, mapping_width);
        }
        for (int x = popup.x + 1; x < popup.x + width - 1; ++x) {
            grid.put(x, popup.y + height - 3, "─", dim);
        }
        popup_footer(grid, popup, controller ? controller->name + " connected" : "Keyboard controls");
    }
}
