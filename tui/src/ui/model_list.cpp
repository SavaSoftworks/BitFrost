// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "model_list.hpp"
#include "rpc/protocol.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <iterator>

namespace bf {
    namespace {
        // A row the cursor skips: a section title, a category, or a blank line.
        ModelRow heading(std::string title, bool all, bool category = false) {
            ModelRow row;
            row.title = std::move(title);
            row.all = all;
            row.category = category;
            return row;
        }

        ModelRow model_row(int model, std::string id, std::string label, bool all) {
            ModelRow row;
            row.model = model;
            row.id = std::move(id);
            row.label = std::move(label);
            row.all = all;
            return row;
        }
    }

    bool ModelList::select(int row) {
        if (!std::binary_search(selectable.begin(), selectable.end(), row)) {
            return false;
        }
        selected = row;
        return true;
    }

    void ModelList::scroll(int delta, int visible_rows) {
        first_row(visible_rows);
        following = false;
        first = std::clamp(first + delta, 0, std::max(0, int(entries.size()) - std::max(1, visible_rows)));
    }

    void ModelList::reset(const Json::Array &models, bool preserve) {
        std::string previous = selected >= 0 && preserve ? entries[size_t(selected)].id : "";
        bool all = selected >= 0 && preserve && entries[size_t(selected)].all;
        entries.clear();
        selectable.clear();
        // Ids named category/model are grouped under their category, in the order categories first appear.
        auto add_section = [&](const std::vector<int> &indices, bool all_models) {
            std::vector<std::string> categories;
            for (int index : indices) {
                std::string id = models[size_t(index)]["model"].str();
                size_t slash = id.find('/');
                std::string category = slash == std::string::npos ? "" : id.substr(0, slash);
                if (std::find(categories.begin(), categories.end(), category) == categories.end()) {
                    categories.push_back(category);
                }
            }
            for (size_t group = 0; group < categories.size(); ++group) {
                const std::string &category = categories[group];
                if (group > 0) {
                    entries.push_back(heading({}, all_models));
                }
                if (!category.empty()) {
                    entries.push_back(heading(category, all_models, true));
                }
                for (int index : indices) {
                    std::string id = models[size_t(index)]["model"].str();
                    bool inside = category.empty() ? id.find('/') == std::string::npos
                                                   : id.compare(0, category.size() + 1, category + "/") == 0;
                    if (inside) {
                        selectable.push_back(int(entries.size()));
                        std::string label = category.empty() ? id : "  " + id.substr(category.size() + 1);
                        entries.push_back(model_row(index, id, label, all_models));
                    }
                }
            }
        };
        std::vector<int> enabled, everything;
        for (size_t index = 0; index < models.size(); ++index) {
            everything.push_back(int(index));
            if (models[index]["enabled"].boolean() && model_toggle_allowed(models[index])) {
                enabled.push_back(int(index));
            }
        }
        entries.push_back(heading("Enabled", false));
        add_section(enabled, false);
        if (enabled.empty()) {
            entries.push_back(heading("None yet", false));
        }
        entries.push_back(heading({}, false));
        entries.push_back(heading("All models", true));
        add_section(everything, true);
        selected = selectable.empty() ? -1 : selectable.front();
        for (int row : selectable) {
            if (entries[size_t(row)].id == previous) {
                selected = row;
                if (entries[size_t(row)].all == all) {
                    break;
                }
            }
        }
        if (!preserve) {
            first = 0;
            following = true;
        }
    }

    int ModelList::model_index() const {
        return selected < 0 ? -1 : entries[size_t(selected)].model;
    }

    int ModelList::first_row(int visible_rows) {
        int page = std::max(1, visible_rows);
        first = std::clamp(first, 0, std::max(0, int(entries.size()) - page));
        if (following && selected >= 0) {
            if (selected < first) {
                first = selected;
            } else if (selected >= first + page) {
                first = selected - page + 1;
            }
            // Keep the headings and blank lines just above the selection in view, and the very top
            // when the first model is selected, so a section never loses its titles.
            int top = selected;
            while (top > 0 && entries[size_t(top - 1)].model < 0) {
                --top;
            }
            if (selected == selectable.front()) {
                top = 0;
            }
            if (top < first && selected - top < page) {
                first = top;
            }
        }
        return first;
    }

    void ModelList::input(Key key, int visible_rows) {
        if (!list_navigation(key)) {
            return;
        }
        if (!following && select_first_visible(selected, key, first_row(visible_rows), visible_rows, selectable)) {
            return;
        }
        following = true;
        if (selectable.empty()) {
            return;
        }
        auto cursor = std::lower_bound(selectable.begin(), selectable.end(), selected);
        switch (key) {
        case Key::Up:
            selected = cursor == selectable.begin() ? selectable.back() : *std::prev(cursor);
            break;
        case Key::Down:
            selected = std::next(cursor) == selectable.end() ? selectable.front() : *std::next(cursor);
            break;
        case Key::Home:
            selected = selectable.front();
            break;
        case Key::End:
            selected = selectable.back();
            break;
        case Key::PageDown: {
            int target = std::min(selectable.back(), selected + std::max(1, visible_rows));
            auto next = std::lower_bound(selectable.begin(), selectable.end(), target);
            selected = next == selectable.end() ? selectable.back() : *next;
            break;
        }
        case Key::PageUp: {
            int target = std::max(0, selected - std::max(1, visible_rows));
            auto previous = std::upper_bound(selectable.begin(), selectable.end(), target);
            selected = previous == selectable.begin() ? selectable.front() : *std::prev(previous);
            break;
        }
        case Key::Tab:
        case Key::BackTab:
            for (int row : selectable) {
                if (entries[size_t(row)].all != entries[size_t(selected)].all) {
                    selected = row;
                    first = row - 1;
                    while (first > 0 && entries[size_t(first - 1)].model < 0 &&
                           !entries[size_t(first - 1)].title.empty()) {
                        --first;
                    }
                    break;
                }
            }
            break;
        default:
            break;
        }
        first_row(visible_rows);
    }
}
