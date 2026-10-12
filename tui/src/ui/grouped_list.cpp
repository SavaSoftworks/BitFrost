// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "grouped_list.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <iterator>

namespace bf {
    void GroupedList::reset(const std::vector<std::string> &groups) {
        entries.clear();
        selectable.clear();
        std::vector<std::string> names;
        for (const auto &group : groups) {
            if (std::find(names.begin(), names.end(), group) == names.end()) {
                names.push_back(group);
            }
        }
        for (const auto &name : names) {
            if (!entries.empty()) {
                entries.push_back({-1, {}});
            }
            if (!name.empty()) {
                entries.push_back({-1, name});
            }
            for (int index = 0; index < int(groups.size()); ++index) {
                if (groups[size_t(index)] == name) {
                    selectable.push_back(int(entries.size()));
                    entries.push_back({index, {}});
                }
            }
        }
    }
    int GroupedList::first_row(int item, int visible_rows) {
        int page = std::max(1, visible_rows);
        first = std::clamp(first, 0, std::max(0, int(entries.size()) - page));
        if (!following) {
            return first;
        }
        auto selected = std::find_if(entries.begin(), entries.end(), [&](const auto &row) { return row.item == item; });
        if (selected == entries.end()) {
            return first;
        }
        int row = int(selected - entries.begin());
        if (row < first) {
            first = row;
        } else if (row >= first + page) {
            first = row - page + 1;
        }
        int top = row;
        while (top > 0 && entries[size_t(top - 1)].item < 0) {
            --top;
        }
        if (!selectable.empty() && row == selectable.front()) {
            top = 0;
        }
        if (top < first && row - top < page) {
            first = top;
        }
        return first;
    }
    void GroupedList::input(int &item, Key key, int visible_rows) {
        if (!list_navigation(key)) {
            return;
        }
        if (selectable.empty()) {
            return;
        }
        auto cursor = std::find_if(selectable.begin(), selectable.end(), [&](int row) {
            return entries[size_t(row)].item == item;
        });
        if (cursor == selectable.end()) {
            cursor = selectable.begin();
        }
        int selected = *cursor;
        if (!following &&
            select_first_visible(selected, key, first_row(item, visible_rows), visible_rows, selectable)) {
            item = entries[size_t(selected)].item;
            return;
        }
        following = true;
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
            auto next = std::lower_bound(selectable.begin(), selectable.end(), selected + std::max(1, visible_rows));
            selected = next == selectable.end() ? selectable.back() : *next;
            break;
        }
        case Key::PageUp: {
            auto previous =
                std::upper_bound(selectable.begin(), selectable.end(), selected - std::max(1, visible_rows));
            selected = previous == selectable.begin() ? selectable.front() : *std::prev(previous);
            break;
        }
        default:
            break;
        }
        item = entries[size_t(selected)].item;
        first_row(item, visible_rows);
    }
    void GroupedList::scroll(int delta, int visible_rows) {
        following = false;
        first = std::clamp(first + delta, 0, std::max(0, int(entries.size()) - std::max(1, visible_rows)));
    }
}
