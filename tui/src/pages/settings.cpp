// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/format.hpp"
#include "ui/list.hpp"
#include "ui/popup.hpp"
#include "ui/sidebar.hpp"
#include <algorithm>

namespace bf {

    void App::draw_settings(Grid &grid) {
        PageLayout layout = sidebar_layout(grid, "Sections", section()["title"].str("Settings"));
        sidebar_visible = std::max(1, layout.sidebar_rows);
        list_visible = std::max(1, layout.visible_rows - 1);
        int first_section = section_view.first_row(section_selection, int(sections.size()), sidebar_visible);
        int sidebar_width = draw_scrollbar(
            grid,
            "sections",
            3,
            layout.sidebar_y,
            layout.sidebar_width - 3,
            sidebar_visible,
            int(sections.size()),
            first_section,
            sidebar_visible
        );
        hits.scroll({3, layout.sidebar_y, layout.sidebar_width - 3, sidebar_visible}, HitKind::Section);
        for (int index = first_section; index < int(sections.size()) && index < first_section + sidebar_visible;
             ++index) {
            hits.add({3, layout.sidebar_y + index - first_section, sidebar_width, 1}, HitKind::Section, index);
            const Json &entry = sections[size_t(index)];
            list_item(
                grid,
                3,
                layout.sidebar_y + index - first_section,
                sidebar_width,
                {entry["title"].str(), index == section_selection},
                clock
            );
        }
        const auto &items = visible_items();
        int first_item = setting_rows.first_row(item_selection, list_visible);
        const auto &rows = setting_rows.rows();
        int width = draw_scrollbar(
            grid,
            "settings",
            layout.main_x,
            5,
            layout.main_width,
            list_visible,
            int(rows.size()),
            first_item,
            list_visible
        );
        hits.scroll({layout.main_x, 5, layout.main_width, list_visible}, HitKind::Setting);
        for (int offset = first_item; offset < int(rows.size()) && offset < first_item + list_visible; ++offset) {
            const GroupedRow &entry = rows[size_t(offset)];
            int row = 5 + offset - first_item;
            if (entry.item < 0) {
                grid.text(layout.main_x + 1, row, entry.heading, white, black, width - 2);
                continue;
            }
            int index = entry.item;
            const Json &setting = items[size_t(index)];
            hits.add({layout.main_x, row, width, 1}, HitKind::Setting, index);
            property_row(
                grid,
                layout.main_x,
                row,
                width,
                setting["label"].str(),
                setting_value(setting),
                index == item_selection && focus.back() != Focus::Sidebar,
                clock
            );
            if (editing() && !adding_list && index == item_selection) {
                editor.draw(grid, layout.main_x, row, width);
                hits.add({layout.main_x, row, width, 1}, HitKind::Editor);
            }
        }
        if (loading_settings) {
            grid.text(layout.main_x, grid.height - 6, "Loading settings...", dim, black, layout.main_width);
        } else if (!editing()) {
            grid.text(layout.main_x, grid.height - 6, ellipsis(item()["help"].str(), layout.main_width), dim);
        }
        if (focus.back() == Focus::Popup || (editing() && adding_list)) {
            draw_settings_popup(grid);
        }
    }

    void App::draw_settings_popup(Grid &grid) {
        auto setting = item();
        bool list = setting["type"].str() == "list";
        auto &values = list ? list_edit.array() : setting["options"].array();
        int count = int(values.size()) + (list ? 1 : 0);
        int width = std::min(64, grid.width - 8), height = std::clamp(count + 5, 7, grid.height - 8);
        if (editing()) {
            height = std::min(grid.height - 8, height + 2);
        }
        int x = (grid.width - width) / 2, y = (grid.height - height) / 2;
        Popup popup{x, y, width, height};
        hits.modal({x, y, width, height});
        popup_frame(grid, popup, setting["label"].str());
        int available = height - (editing() ? 6 : 5);
        popup_visible = std::max(1, available);
        int first = popup_view.first_row(popup_selection, count, popup_visible);
        int list_width =
            draw_scrollbar(grid, "settings-popup", x + 1, y + 3, width - 2, available, count, first, available, true);
        hits.scroll({x, y, width, height}, HitKind::PopupRow);
        for (int index = first; index < count && index < first + available; ++index) {
            std::string label =
                list ? (index == int(values.size()) ? "+ Add item" : "Remove: " + shown(values[size_t(index)]))
                     : values[size_t(index)]["label"].str(shown(values[size_t(index)]["value"]));
            list_item(grid, x + 1, y + 3 + index - first, list_width, {label, index == popup_selection}, clock);
            if (!editing()) {
                hits.add({x + 1, y + 3 + index - first, list_width, 1}, HitKind::PopupRow, index);
            }
        }
        if (editing()) {
            editor.draw(grid, x + 2, y + height - 3, width - 4);
            hits.add({x + 2, y + height - 3, width - 4, 1}, HitKind::Editor);
        }
        std::string hint = controls_hint();
        popup_footer(grid, popup, hint);
        hits.add({x + 2, y + height - 2, text_width(hint), 1}, HitKind::Controls);
    }
}
