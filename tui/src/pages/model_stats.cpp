// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/format.hpp"
#include "ui/list.hpp"
#include "ui/usage_chart.hpp"
#include <algorithm>
#include <iomanip>
#include <iterator>
#include <sstream>

namespace bf {
    void App::draw_model_stats(Grid &grid, int x, int y, int width, int height) {
        grid.rect(x - 1, y, width + 2, height, black);
        for (int column = x - 1; column <= x + width; ++column) {
            grid.put(column, y, "─", blue);
        }
        const Json *row = nullptr;
        auto cached = provider_stats.find(provider()["id"].str());
        if (cached != provider_stats.end()) {
            auto entry = cached->second.find(model()["model"].str());
            if (entry != cached->second.end()) {
                row = &entry->second;
            }
        }
        const Json empty;
        const Json &usage = row ? *row : empty;
        constexpr std::string_view periods[]{"today", "week", "month", "total"};
        constexpr std::string_view labels[]{"Today", "7 days", "30 days", "All time"};
        constexpr std::string_view short_labels[]{"Day", "7d", "30d", "All"};
        const Json &period = usage[periods[stats_tab]];
        bool pending = !row && !model().null();
        int facts_width = height > 3 ? std::clamp(width * 2 / 5, 26, 40) : std::max(0, width - STATS_TABS * 7 - 2);
        int stats_x = x + facts_width + 2;
        int stats_width = width - facts_width - 2;
        int tab_width = stats_width / STATS_TABS;
        if (height > 3) {
            for (int line = y + 1; line < y + height; ++line) {
                grid.put(stats_x - 2, line, "│", blue);
            }
        }
        for (int tab = 0; tab < STATS_TABS; ++tab) {
            int tab_x = stats_x + tab * tab_width;
            std::string_view label = text_width(labels[tab]) <= tab_width - 2 ? labels[tab] : short_labels[tab];
            hits.add({tab_x, y + 1, tab_width, 1}, HitKind::StatsTab, tab);
            if (tab == stats_tab) {
                list_item(grid, tab_x, y + 1, tab_width, {label, true}, clock);
            } else {
                grid.text(tab_x + 1, y + 1, label, blue, black, tab_width - 2);
            }
        }
        std::string company = height > 3 ? model()["company"].str() : "";
        int company_width = std::min(text_width(company), std::max(0, facts_width - 2));
        grid.text(
            x,
            y + 1,
            ellipsis(
                model()["displayName"].str(model()["model"].str("Model usage")),
                facts_width - company_width - (company_width ? 2 : 1)
            )
        );
        if (company_width) {
            grid.text(x + facts_width - company_width - 1, y + 1, ellipsis(company, company_width), dim);
        }
        if (height <= 3) {
            std::string summary = pending
                                      ? "Loading usage..."
                                      : "Sessions " + compact(period["sessions"].number()) + "   Tokens " +
                                            compact(period["inputTokens"].number() + period["outputTokens"].number());
            grid.text(x, y + 2, ellipsis(summary, width), white);
            return;
        }
        if (model().null()) {
            grid.text(x, y + 2, "Select a model", dim, black, facts_width - 2);
            return;
        }
        std::string state = model()["enabled"].boolean() ? "Enabled" : "Disabled";
        std::string efforts;
        for (const Json &effort : model()["efforts"].array()) {
            efforts += (efforts.empty() ? "" : ", ") + effort.str();
        }
        std::vector<std::pair<std::string, Color>> facts{
            {state, white},
            {"", dim},
            {"First used", dim},
            {date(usage["firstUsedAt"]), white},
            {"", dim},
            {"Last used", dim},
            {date(usage["lastUsedAt"]), white},
            {"", dim},
            {"Efforts: " + (efforts.empty() ? "-" : efforts), white},
            {"Default: " + model()["defaultEffort"].str("-"), white}
        };
        if (model()["offered"].boolean() && !model()["agent"].null()) {
            facts.push_back({"", dim});
            facts.push_back({"Subagent: " + model()["agent"].str(), white});
        }
        while (int(facts.size()) > height - 2) {
            auto blank =
                std::find_if(facts.rbegin(), facts.rend(), [](const auto &fact) { return fact.first.empty(); });
            if (blank == facts.rend()) {
                facts.pop_back();
            } else {
                facts.erase(std::next(blank).base());
            }
        }
        for (size_t offset = 0; offset < facts.size(); ++offset) {
            grid.text(x, y + 2 + int(offset), ellipsis(facts[offset].first, facts_width - 2), facts[offset].second);
        }
        double turns = period["turns"].number(), closed = period["closedSessions"].number();
        std::ostringstream failure;
        failure << std::fixed << std::setprecision(0) << (turns ? period["failedTurns"].number() * 100 / turns : 0)
                << '%';
        std::vector<std::pair<std::string_view, std::string>> rows{
            {"Sessions", compact(period["sessions"].number())},
            {"Tokens", compact(period["inputTokens"].number() + period["outputTokens"].number())},
            {"Cache reads", compact(period["cachedTokens"].number())},
            {"Turns", compact(turns)},
            {"Failure rate", turns ? failure.str() : "-"},
            {"Avg. turn time", turns ? duration(period["turnMs"].number() / turns) : "-"},
            {"Avg. session time", closed ? duration(period["sessionMs"].number() / closed) : "-"}
        };
        int line = y + 3;
        for (const auto &[label, value] : rows) {
            const std::string &shown_value = pending ? std::string("-") : value;
            int value_width = std::min(text_width(shown_value), stats_width / 3);
            grid.text(stats_x, line, ellipsis(label, stats_width - value_width - 2), dim);
            grid.text(x + width - value_width, line++, ellipsis(shown_value, value_width), white);
        }
        if (height >= 13) {
            // Today is drawn by the hour, the rest by the day.
            constexpr int days[]{0, 7, 30, 0};
            const Json &series = stats_tab == 0 ? usage["hourly"] : usage["daily"];
            draw_usage_chart(grid, stats_x, line, stats_width, height - 11, series, days[stats_tab]);
        }
        if (pending) {
            grid.text(stats_x, line, "Loading usage...", dim, black, stats_width);
        }
    }
}
