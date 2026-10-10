// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "subagent_list.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <array>
#include <ctime>
#include <iomanip>
#include <iterator>
#include <sstream>

namespace bf {
    bool SubagentList::select(int row) {
        if (!std::binary_search(selectable.begin(), selectable.end(), row)) {
            return false;
        }
        selected = row;
        retained_selection.reset();
        return true;
    }

    void SubagentList::scroll(int delta, int visible_rows) {
        first_row(visible_rows);
        following = false;
        first = std::clamp(first + delta, 0, std::max(0, int(entries.size()) - std::max(1, visible_rows)));
    }

    int subagent_group(double created_at, double now) {
        time_t timestamp = time_t(now / 1000);
        tm today{};
        if (!localtime_r(&timestamp, &today)) {
            return 4;
        }
        today.tm_hour = today.tm_min = today.tm_sec = 0;
        constexpr int days[]{0, 1, 6, 13};
        for (int group = 0; group < 4; ++group) {
            tm boundary = today;
            boundary.tm_mday -= days[group];
            boundary.tm_isdst = -1;
            if (created_at >= double(std::mktime(&boundary)) * 1000) {
                return group;
            }
        }
        return 4;
    }

    std::string elapsed_time(double milliseconds) {
        int64_t seconds = int64_t(std::max(0.0, milliseconds) / 1000);
        if (seconds < 60) {
            return std::to_string(seconds) + 's';
        }
        std::ostringstream text;
        if (seconds >= 86400) {
            text << seconds / 86400 << "d " << seconds / 3600 % 24 << ':' << std::setw(2) << std::setfill('0')
                 << seconds / 60 % 60;
            return text.str();
        }
        if (seconds >= 3600) {
            text << seconds / 3600 << ':' << std::setw(2) << std::setfill('0') << seconds / 60 % 60;
        } else {
            text << seconds / 60;
        }
        text << ':' << std::setw(2) << std::setfill('0') << seconds % 60;
        return text.str();
    }

    // Time spent working: finished turns plus the one running now, if any.
    double subagent_duration(const Json &row, double now) {
        if (row["activeMs"].null()) {
            return std::max(0.0, (row["closedAt"].null() ? now : row["closedAt"].number()) - row["createdAt"].number());
        }
        double running = row["turnStartedAt"].null() ? 0 : std::max(0.0, now - row["turnStartedAt"].number());
        return row["activeMs"].number() + running;
    }

    void SubagentList::reset(const Json &data, bool history, bool preserve) {
        this->history = history;
        const SubagentRow *previous = preserve ? selection() : nullptr;
        std::optional<SubagentRow> retained = previous ? std::optional<SubagentRow>(*previous) : std::nullopt;
        std::string id = previous ? previous->agent["id"].str() : "";
        bool see_all = previous && previous->see_all;
        int old_selected = selected;
        std::string anchor;
        int anchor_offset = 0;
        if (preserve && (history || !following)) {
            for (int index = first; index < int(entries.size()); ++index) {
                if (!entries[size_t(index)].agent.null()) {
                    anchor = entries[size_t(index)].agent["id"].str();
                    anchor_offset = index - first;
                    break;
                }
            }
        }
        entries.clear();
        selectable.clear();
        auto add = [&](const Json &agent) {
            selectable.push_back(int(entries.size()));
            entries.push_back({agent, {}, false});
        };
        if (history) {
            Json::Array agents = data["rows"].array();
            std::stable_sort(agents.begin(), agents.end(), [](const Json &left, const Json &right) {
                return left["createdAt"].number() > right["createdAt"].number();
            });
            constexpr std::string_view names[]{"Today", "Yesterday", "Last 7 days", "Last 14 days", "Older"};
            std::array<Json::Array, 5> groups;
            for (const Json &agent : agents) {
                groups[size_t(subagent_group(agent["createdAt"].number(), data["now"].number()))].push_back(agent);
            }
            for (size_t group = 0; group < groups.size(); ++group) {
                if (!groups[group].empty()) {
                    if (!entries.empty()) {
                        entries.push_back({{}, {}, false});
                    }
                    entries.push_back({{}, std::string(names[group]), false});
                    for (const Json &agent : groups[group]) {
                        add(agent);
                    }
                }
            }
        } else {
            entries.push_back({{}, "Running", false});
            if (data["running"].array().empty()) {
                entries.push_back({{}, "None running", false});
            }
            for (const Json &agent : data["running"].array()) {
                add(agent);
            }
            entries.push_back({{}, {}, false});
            entries.push_back({{}, "Recent", false});
            Json::Array recent = data["recent"].array();
            for (const Json &agent : recent) {
                add(agent);
            }
            entries.push_back({{}, {}, false});
            selectable.push_back(int(entries.size()));
            entries.push_back({{}, "See all", true});
        }
        selected = selectable.empty() ? -1 : selectable.front();
        retained_selection.reset();
        if (preserve) {
            auto closest = std::lower_bound(selectable.begin(), selectable.end(), old_selected);
            if (!selectable.empty()) {
                selected = closest == selectable.end() ? selectable.back() : *closest;
            }
            bool found = false;
            for (int row : selectable) {
                const SubagentRow &entry = entries[size_t(row)];
                if ((see_all && entry.see_all) || (!id.empty() && entry.agent["id"].str() == id)) {
                    selected = row;
                    found = true;
                    break;
                }
            }
            if (history && retained && !found) {
                retained_selection = std::move(retained);
                selected = -1;
            }
            for (int row : selectable) {
                if (!anchor.empty() && entries[size_t(row)].agent["id"].str() == anchor) {
                    first = std::max(0, row - anchor_offset);
                    break;
                }
            }
        } else {
            first = 0;
            following = true;
        }
    }

    const SubagentRow *SubagentList::selection() const {
        return selected >= 0 ? &entries[size_t(selected)] : retained_selection ? &*retained_selection : nullptr;
    }

    int SubagentList::first_row(int visible_rows) {
        int page = std::max(1, visible_rows);
        first = std::clamp(first, 0, std::max(0, int(entries.size()) - page));
        if (following && selected >= 0) {
            if (selected < first) {
                first = selected;
            } else if (selected >= first + page) {
                first = selected - page + 1;
            }
            if (page > 1 && selected > 0 && !entries[size_t(selected - 1)].selectable()) {
                first = std::min(first, selected - 1);
            }
        }
        return first;
    }

    void SubagentList::input(Key key, int visible_rows) {
        if (resume_visible(key, visible_rows)) {
            return;
        }
        if (retained_selection) {
            return;
        }
        if (!list_navigation(key)) {
            return;
        }
        following = true;
        if (selectable.empty()) {
            return;
        }
        auto cursor = std::lower_bound(selectable.begin(), selectable.end(), selected);
        switch (key) {
        case Key::Up:
            selected =
                cursor == selectable.begin() ? history ? selectable.front() : selectable.back() : *std::prev(cursor);
            break;
        case Key::Down:
            selected = std::next(cursor) == selectable.end() ? history ? selectable.back() : selectable.front()
                                                             : *std::next(cursor);
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
        first_row(visible_rows);
    }

    bool SubagentList::resume_visible(Key key, int visible_rows) {
        if (following || !select_first_visible(selected, key, first_row(visible_rows), visible_rows, selectable)) {
            return false;
        }
        retained_selection.reset();
        return true;
    }
}
