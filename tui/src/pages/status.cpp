// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/format.hpp"
#include "ui/list.hpp"
#include "ui/sidebar.hpp"
#include <algorithm>
#include <array>

namespace bf {
    void App::draw_status(Grid &grid) {
        // About has no title; its wordmark heads the page.
        std::string_view title;
        if (status_section == 0) {
            title = status_history ? "Session history" : "Sessions";
        } else if (status_section == 1) {
            title = "Helper";
        }
        PageLayout layout = sidebar_layout(grid, "Status", title);
        sidebar_visible = std::max(1, layout.sidebar_rows);
        constexpr std::string_view sections[]{"Sessions", "Helper", "About"};
        int first_section = status_view.first_row(status_section, 3, sidebar_visible);
        int sidebar_width = draw_scrollbar(
            grid,
            "status-sidebar",
            3,
            layout.sidebar_y,
            layout.sidebar_width - 3,
            sidebar_visible,
            3,
            first_section,
            sidebar_visible
        );
        hits.scroll({3, layout.sidebar_y, layout.sidebar_width - 3, sidebar_visible}, HitKind::StatusSection);
        for (int section = first_section; section < 3 && section < first_section + sidebar_visible; ++section) {
            hits.add(
                {3, layout.sidebar_y + section - first_section, sidebar_width, 1},
                HitKind::StatusSection,
                section
            );
            list_item(
                grid,
                3,
                layout.sidebar_y + section - first_section,
                sidebar_width,
                {sections[section], section == status_section},
                clock
            );
        }
        if (status_section == 0) {
            draw_subagents(grid, layout.main_x, layout.main_width, layout.visible_rows);
        } else if (status_section == 1) {
            draw_helper(grid, layout.main_x, layout.main_width, layout.visible_rows);
        } else {
            draw_about(grid, layout.main_x, layout.main_width, layout.visible_rows);
        }
    }

    void App::draw_subagents(Grid &grid, int x, int width, int rows) {
        subagents_visible = true;
        SubagentList &list = status_history ? history_rows : overview_rows;
        const Json &data = status_history ? history : overview;
        double now = data["now"].number() + (status_history ? history_age : overview_age) * 1000;
        list_visible = std::clamp(rows - 1, 1, 500);
        sync_subagents();
        bool loading = status_history ? loading_history : loading_subagents;
        if (loading && data.null()) {
            grid.text(x, 5, "Loading sessions...", dim, black, width);
            return;
        }
        int first = list.first_row(list_visible);
        const auto &entries = list.rows();
        int total = int(entries.size()), absolute_first = first, visible = list_visible;
        if (status_history) {
            total = history_total;
            absolute_first = history_offset;
            visible = 0;
            for (int index = 0; index < int(entries.size()); ++index) {
                if (!entries[size_t(index)].agent.null()) {
                    if (index < first) {
                        ++absolute_first;
                    } else if (index < first + list_visible) {
                        ++visible;
                    }
                }
            }
        }
        width = draw_scrollbar(
            grid,
            status_history ? "history" : "overview",
            x,
            6,
            width,
            list_visible,
            total,
            absolute_first,
            visible
        );
        std::array<int, 5> sizes;
        int number_width = width >= 65 ? 10 : std::clamp(width / 6, 3, 6);
        int tools_width = width >= 65 ? 7 : std::clamp(width / 8, 3, 5);
        int remaining = width - number_width * 2 - tools_width;
        sizes = {
            std::max(1, remaining * 3 / 5),
            std::max(1, remaining - remaining * 3 / 5),
            number_width,
            number_width,
            tools_width
        };
        constexpr std::string_view names[]{"Name", "Model", "Duration", "Tokens", "Tools"};
        auto columns = [&](int y, const std::array<std::string, 5> &values, Color color) {
            int column_x = x + 1;
            for (size_t column = 0; column < values.size(); ++column) {
                int available = std::max(1, sizes[column] - 2);
                std::string text = ellipsis(values[column], available);
                int padding = column >= 2 ? available - text_width(text) : 0;
                list_text(grid, column_x + padding, y, text, color, available);
                column_x += sizes[column];
            }
        };
        columns(
            5,
            {std::string(names[0]),
             std::string(names[1]),
             std::string(names[2]),
             std::string(names[3]),
             std::string(names[4])},
            dim
        );
        hits.scroll({x, 5, width, list_visible + 1}, HitKind::Subagent);
        for (int index = first; index < int(entries.size()) && index < first + list_visible; ++index) {
            const SubagentRow &row = entries[size_t(index)];
            int y = 6 + index - first;
            bool active = row.selectable() && index == list.selected_row() && focus.back() == Focus::List;
            if (row.selectable()) {
                hits.add({x, y, width, 1}, HitKind::Subagent, index);
            }
            if (active) {
                highlight(grid, x, y, width, "", clock);
            }
            if (row.agent.null()) {
                list_text(grid, x + 1, y, row.title, active ? black : dim, width - 2);
                continue;
            }
            const Json &agent = row.agent;
            std::string title = agent["title"].str();
            if (title.empty()) {
                title = agent["agent"].str(agent["model"].str());
                if (title.empty()) {
                    title = agent["model"].str();
                }
            }
            std::string model = agent["harnessName"].str(agent["harness"].str()) + ' ' + agent["model"].str();
            columns(
                y,
                {title,
                 model,
                 elapsed_time(subagent_duration(agent, now)),
                 compact(agent["tokens"].number()),
                 std::to_string(agent["toolCalls"].integer())},
                active                       ? black
                : agent["running"].boolean() ? white
                                             : dim
            );
        }
        if (entries.empty()) {
            grid.text(x + 1, 6, "No sessions yet", dim, black, width - 2);
        }
    }

    void App::draw_helper(Grid &grid, int x, int width, int rows) {
        list_visible = std::max(1, rows);
        if (helper.null()) {
            grid.text(
                x,
                5,
                loading_helper ? "Loading helper status..." : "Helper status unavailable",
                dim,
                black,
                width
            );
            return;
        }
        struct Line {
            std::string group, label, value;
        };
        double now = helper_now + helper_age * 1000;
        std::vector<Line> lines{
            {"Helper", "Version", helper["version"].str()},
            {"Helper", "PID", std::to_string(helper["pid"].integer())},
            {"Helper", "Uptime", elapsed_time(now - helper["startedAt"].number())},
            {"Helper", "Socket", helper["socket"].str()},
            {"Helper", "Config", helper["config"].str()}
        };
        if (!helper["configError"].null()) {
            lines.push_back({"Helper", "Config error", helper["configError"].str()});
        }
        lines.push_back(
            {"Helper",
             "Model list",
             helper["registryAt"].null() ? "Not listed yet" : listed_age(now - helper["registryAt"].number())}
        );
        if (helper["providers"].array().empty()) {
            lines.push_back({"Helper", "Running apps", "None running"});
        }
        for (const Json &provider : helper["providers"].array()) {
            std::string name = app_name(provider["id"].str());
            lines.push_back({name, "Location", provider["location"].str("-")});
            lines.push_back({name, "Models", std::to_string(provider["models"].integer())});
        }
        if (helper["leases"].array().empty()) {
            lines.push_back({"Leases", "Status", "None"});
        }
        for (const Json &lease : helper["leases"].array()) {
            lines.push_back({"Leases", "Host", lease["host"].str()});
            lines.push_back({"Leases", "Profile", lease["profile"].str()});
            lines.push_back({"Leases", "Expires in", elapsed_time(lease["expiresInMs"].number() - helper_age * 1000)});
        }
        std::vector<std::string> groups;
        for (const auto &line : lines) {
            groups.push_back(line.group);
        }
        helper_rows.reset(groups);
        helper_selection = std::clamp(helper_selection, 0, std::max(0, int(lines.size()) - 1));
        int first = helper_rows.first_row(helper_selection, list_visible);
        const auto &entries = helper_rows.rows();
        width = draw_scrollbar(grid, "helper", x, 5, width, list_visible, int(entries.size()), first, list_visible);
        hits.scroll({x, 5, width, list_visible}, HitKind::Helper);
        for (int index = first; index < int(entries.size()) && index < first + list_visible; ++index) {
            const GroupedRow &entry = entries[size_t(index)];
            int y = 5 + index - first;
            if (entry.item < 0) {
                grid.text(x + 1, y, entry.heading, white, black, width - 2);
                continue;
            }
            const Line &line = lines[size_t(entry.item)];
            property_row(grid, x, y, width, line.label, line.value, false, clock);
        }
    }
}
