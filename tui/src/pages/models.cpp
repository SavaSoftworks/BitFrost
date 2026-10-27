// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/list.hpp"
#include "ui/popup.hpp"
#include "ui/sidebar.hpp"
#include <algorithm>

namespace bf {

    void App::draw_models(Grid &grid) {
        PageLayout layout = sidebar_layout(grid, "Providers", "Models");
        sidebar_visible = std::max(1, layout.sidebar_rows);
        int panel_height = grid.height >= 26 && layout.main_width >= 57 ? (grid.height >= 30 ? 13 : 10)
                           : grid.height >= 20                          ? 3
                                                                        : 0;
        int panel_y = status_row(grid) - panel_height;
        stats_visible = panel_height > 0;
        load_stats();
        list_visible = std::max(1, panel_y - 6);
        int first_provider = provider_view.first_row(provider_selection, sidebar_visible);
        const auto &provider_rows = provider_view.rows();
        int sidebar_width = draw_scrollbar(
            grid,
            "providers",
            3,
            layout.sidebar_y,
            layout.sidebar_width - 3,
            sidebar_visible,
            int(provider_rows.size()),
            first_provider,
            sidebar_visible
        );
        hits.scroll({3, layout.sidebar_y, layout.sidebar_width - 3, sidebar_visible}, HitKind::Provider);
        for (int index = first_provider; index < int(provider_rows.size()) && index < first_provider + sidebar_visible;
             ++index) {
            int item = provider_rows[size_t(index)].item;
            if (item < 0) {
                continue;
            }
            hits.add({3, layout.sidebar_y + index - first_provider, sidebar_width, 1}, HitKind::Provider, item);
            const Json &entry = providers[size_t(item)];
            list_item(
                grid,
                3,
                layout.sidebar_y + index - first_provider,
                sidebar_width,
                {entry["displayName"].str(), item == provider_selection, !entry["detected"].boolean()},
                clock
            );
        }
        const Json &selected_provider = provider();
        if (selected_provider.null()) {
            grid.text(layout.main_x, 5, "Loading providers...", dim, black, layout.main_width);
        } else if (!selected_provider["detected"].boolean() || !selected_provider["enabled"].boolean()) {
            std::string explanation = discovery_error;
            if (explanation.empty()) {
                explanation = selected_provider["detected"].boolean() ? "Provider is disabled"
                                                                      : "App not detected on this machine";
            }
            grid.text(layout.main_x, 5, ellipsis(explanation, layout.main_width), dim);
            if (selected_provider["detected"].boolean()) {
                std::string label = "Enable " + selected_provider["displayName"].str();
                list_item(grid, layout.main_x, 7, layout.main_width, {label, focus.back() == Focus::List}, clock);
                hits.add({layout.main_x, 7, layout.main_width, 1}, HitKind::EnableProvider);
            }
        } else {
            hits.scroll({layout.main_x, 5, layout.main_width, list_visible}, HitKind::Model);
            int first_model = model_rows.first_row(list_visible);
            const auto &rows = model_rows.rows();
            int width = draw_scrollbar(
                grid,
                "models",
                layout.main_x,
                5,
                layout.main_width,
                list_visible,
                int(rows.size()),
                first_model,
                list_visible
            );
            for (int index = first_model; index < int(rows.size()) && index < first_model + list_visible; ++index) {
                const ModelRow &row = rows[size_t(index)];
                if (row.model < 0) {
                    Color color = row.category ? white : dim;
                    grid.text(layout.main_x + 1, 5 + index - first_model, row.title, color, black, width - 2);
                    continue;
                }
                const Json &entry = models[size_t(row.model)];
                hits.add({layout.main_x, 5 + index - first_model, width, 1}, HitKind::Model, index);
                std::string label = row.label.empty() ? entry["model"].str() : row.label;
                bool offered = entry["enabled"].boolean() && entry["offered"].boolean() && entry["reason"].null();
                list_item(
                    grid,
                    layout.main_x,
                    5 + index - first_model,
                    width,
                    {label,
                     index == model_rows.selected_row() && focus.back() != Focus::Sidebar,
                     !offered,
                     {},
                     offered ? "on" : "off"},
                    clock
                );
            }
            if (loading_models) {
                grid.text(layout.main_x, panel_y - 1, "Discovering models...", dim, black, layout.main_width);
            } else if (models.empty()) {
                grid.text(
                    layout.main_x,
                    panel_y - 1,
                    ellipsis(discovery_error.empty() ? "No models discovered" : discovery_error, layout.main_width),
                    dim
                );
            } else if (!discovery_error.empty()) {
                grid.text(layout.main_x, panel_y - 1, ellipsis(discovery_error, layout.main_width), dim);
            }
        }
        if (panel_height) {
            draw_model_stats(grid, layout.main_x, panel_y, layout.main_width, panel_height);
        }
        if (focus.back() == Focus::Popup) {
            draw_models_popup(grid);
        }
    }

    void App::draw_models_popup(Grid &grid) {
        int width = std::min(42, grid.width - 8), height = 7;
        int x = (grid.width - width) / 2, y = 4;
        Popup popup{x, y, width, height};
        hits.modal({x, y, width, height});
        popup_frame(grid, popup, model()["displayName"].str(model()["model"].str()));
        list_item(
            grid,
            x + 1,
            y + 3,
            width - 2,
            {model()["enabled"].boolean() ? "> Disable" : "> Enable", true},
            clock
        );
        hits.add({x + 1, y + 3, width - 2, 1}, HitKind::ModelAction);
        std::string hint = controls_hint();
        popup_footer(grid, popup, hint);
        hits.add({x + 2, y + height - 2, text_width(hint), 1}, HitKind::Controls);
    }
}
