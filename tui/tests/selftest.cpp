// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "fx/glyphs.hpp"
#include "fx/mosaic.hpp"
#include "term/output.hpp"
#include "ui/format.hpp"
#include "ui/list.hpp"
#include "ui/sidebar.hpp"
#include "ui/usage_chart.hpp"
#include <algorithm>
#include <clocale>
#include <cmath>
#include <ctime>
#include <deque>
#include <iostream>
#include <limits>
#include <locale>
#include <numeric>
#include <stdexcept>

namespace bf {
    void status_selftest();
    void protocol_selftest();
    void settings_selftest();
    void mouse_selftest();
    void hit_selftest();
    void update_selftest();
    void about_selftest();
    void scrollbar_selftest();
    void scroll_selftest();
    void gamepad_selftest();
    void controls_selftest();
    void configuration_selftest();
    namespace {
        void check(bool condition, const char *name) {
            if (!condition) {
                throw std::runtime_error(name);
            }
        }

        void rejects(std::string_view text) {
            bool rejected = false;
            try {
                Json::parse(text);
            } catch (...) {
                rejected = true;
            }
            check(rejected, "JSON accepts malformed input");
        }

        void providers_selftest() {
            Json::Array providers = Json::parse(R"([
                {"id":"opencode", "displayName":"OpenCode", "firstClass":false},
                {"id":"zcode", "displayName":"ZCode", "firstClass":true},
                {"id":"grok", "displayName":"Grok Build", "firstClass":true},
                {"id":"omp", "displayName":"Oh My Pi", "firstClass":false},
                {"id":"crush", "displayName":"crush", "firstClass":false},
                {"id":"codex", "displayName":"Codex", "firstClass":true},
                {"id":"gemini", "displayName":"Gemini CLI", "firstClass":false},
                {"id":"agy", "displayName":"antigravity", "firstClass":true}
            ])")
                                        .array();
            std::deque<Json> pending;
            std::vector<Json> sent;
            App app(
                [&](const Json &request) {
                    pending.push_back(request);
                    sent.push_back(request);
                },
                false
            );
            Grid grid(120, 20);
            auto pump = [&] {
                while (!pending.empty()) {
                    Json request = pending.front();
                    pending.pop_front();
                    Json result = Json::object({{"protocol", 1}, {"revision", "test"}});
                    if (request["method"].str() == "providers.list") {
                        result["providers"] = providers;
                    }
                    app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
                }
                app.render(grid);
            };
            auto key = [&](Key key) {
                app.input({key, {}});
                pump();
            };
            auto line = [&](int y, bool selected = false) {
                std::string text;
                for (int x = 4; x < 23; ++x) {
                    const Cell &cell = grid.cells[size_t(y * grid.width + x)];
                    text += !selected || cell.fg == black ? cell.glyph : " ";
                }
                return text;
            };
            auto selected = [&](std::string_view name) {
                for (int y = 5; y < status_row(grid); ++y) {
                    if (line(y, true).starts_with(name)) {
                        return true;
                    }
                }
                return false;
            };
            app.start();
            pump();
            key(Key::Enter);
            std::vector<std::string> expected{
                "antigravity",
                "Codex",
                "Grok Build",
                "ZCode",
                "",
                "crush",
                "Gemini CLI",
                "Oh My Pi",
                "OpenCode"
            };
            for (size_t row = 0; row < expected.size(); ++row) {
                check(line(5 + int(row)).starts_with(expected[row]), "Provider groups sort names without case");
            }
            check(line(9) == std::string(19, ' '), "Provider groups have one empty row");
            key(Key::Down);
            key(Key::Down);
            key(Key::Down);
            check(selected("ZCode"), "Sidebar reaches the last first-class provider");
            auto requests = sent.size();
            check(!app.mouse_input({{5, 9}, MouseKind::Click, 0}), "Provider gap has no click target");
            pump();
            check(selected("ZCode") && sent.size() == requests, "Gap click leaves selection and requests alone");
            key(Key::Down);
            check(selected("crush"), "Sidebar Down skips the gap");
            key(Key::Up);
            check(selected("ZCode"), "Sidebar Up skips the gap");
            key(Key::End);
            check(selected("OpenCode"), "Sidebar End selects the last provider");
            key(Key::Down);
            check(selected("antigravity"), "Sidebar wraps from the end to the top");
            key(Key::Up);
            check(selected("OpenCode"), "Sidebar wraps from the top to the end");
            key(Key::PageUp);
            check(selected("antigravity"), "Sidebar Page Up skips the gap");
            key(Key::PageDown);
            check(selected("OpenCode"), "Sidebar Page Down skips the gap");
            check(app.mouse_input({{5, 10}, MouseKind::Click, 0}), "Second provider group accepts clicks");
            pump();
            check(selected("crush"), "Mouse rows map past the gap to provider indices");
            key(Key::Home);
            key(Key::Down);
            providers[5]["displayName"] = "zzCodex";
            std::reverse(providers.begin(), providers.end());
            app.receive(Json::object({{"method", "config.changed"}}));
            pump();
            check(selected("zzCodex"), "Provider refresh preserves the selected id after sorting changes its index");
            grid = Grid(120, 16);
            key(Key::Home);
            check(app.mouse_input({{5, 7}, MouseKind::Wheel, 100}), "Provider sidebar scrolls");
            pump();
            check(line(5).starts_with("zzCodex"), "Provider wheel scrolls without moving selection");
            key(Key::Down);
            check(selected("zzCodex"), "Navigation after scrolling selects the visible provider");
            GroupedList view;
            view.reset({"first", "first", "first", "first", "other", "other", "other", "other"}, false);
            view.scroll(4, 5);
            int item = 0;
            view.input(item, Key::Down, 5);
            check(item == 4 && view.first_row(item, 5) == 4, "Navigation skips a gap at the scrolled viewport top");
            grid = Grid(120, 20);
            for (bool first : {true, false}) {
                for (Json &entry : providers) {
                    entry["firstClass"] = first;
                }
                app.receive(Json::object({{"method", "config.changed"}}));
                pump();
                key(Key::Home);
                for (int y = 5; y < 13; ++y) {
                    check(line(y) != std::string(19, ' '), "A single provider group has no gap or headings");
                }
                check(line(13) == std::string(19, ' '), "A single provider group has exactly eight rows");
            }
        }

        void json_numbers_selftest() {
            struct CommaNumbers : std::numpunct<char> {
                char do_decimal_point() const override {
                    return ',';
                }
                char do_thousands_sep() const override {
                    return '.';
                }
                std::string do_grouping() const override {
                    return "\3";
                }
            };
            struct RestoreLocale {
                std::locale original;
                std::string original_c = std::setlocale(LC_ALL, nullptr);
                ~RestoreLocale() {
                    std::locale::global(original);
                    std::setlocale(LC_ALL, original_c.c_str());
                }
            } restore;
            std::locale::global(std::locale(std::locale::classic(), new CommaNumbers));
            check(Json(1234.5).dump() == "1234.5", "JSON decimals ignore the global locale");
            check(Json::parse("1234.5").number() == 1234.5, "JSON parsing ignores the global locale");
            check(Json::parse("1.25e+3").number() == 1250, "JSON exponent parsing");
            check(std::signbit(Json::parse("-0.0").number()), "JSON parsing preserves negative zero");
            for (double number :
                 {1.2345678901234567,
                  -1.2345678901234567,
                  std::numeric_limits<double>::max(),
                  std::numeric_limits<double>::lowest(),
                  std::numeric_limits<double>::min(),
                  std::numeric_limits<double>::denorm_min()}) {
                check(
                    Json::parse(Json(number).dump()).number() == number,
                    "JSON doubles roundtrip without losing precision"
                );
            }
            rejects("1e-999");
            rejects("1,25");
        }
    }

    int selftest() {
        try {
            providers_selftest();
            status_selftest();
            protocol_selftest();
            settings_selftest();
            mouse_selftest();
            hit_selftest();
            update_selftest();
            about_selftest();
            scrollbar_selftest();
            scroll_selftest();
            gamepad_selftest();
            controls_selftest();
            configuration_selftest();
            for (auto [width, height] : {std::pair{120, 40}, {120, 24}, {80, 24}, {40, 18}, {120, 16}}) {
                Grid branded(width, height);
                PageLayout layout = sidebar_layout(branded, "Providers", "Models");
                check(
                    layout.sidebar_rows == status_row(branded) - layout.sidebar_y,
                    "Branded sidebar keeps its menu above the status bar"
                );
                check(
                    branded.cells[size_t(3 * width + layout.main_x)].glyph == "M",
                    "Sidebar branding preserves the main panel's title position"
                );
                if (width >= 100 && height >= 24) {
                    check(layout.sidebar_y == 9, "Pixel logo and padding reserve four rows above the sidebar title");
                    for (int y = 3; y < 6; ++y) {
                        bool ink = false;
                        for (int x = 3; x < layout.sidebar_width; ++x) {
                            ink = ink || branded.cells[size_t(y * width + x)].glyph != " ";
                        }
                        check(ink, "The compact sidebar wordmark fits in three rows");
                    }
                } else {
                    int y = height >= 24 ? 3 : 2;
                    std::string brand;
                    for (int x = 3; x < layout.sidebar_width; ++x) {
                        brand += branded.cells[size_t(y * width + x)].glyph;
                    }
                    check(
                        brand.find("BitFrost") != std::string::npos,
                        "Short and narrow sidebars retain a readable wordmark"
                    );
                }
            }
            auto parsed_json = Json::parse(
                R"({
      "integer": 9223372036854775807,
      "low": -9223372036854775808,
      "unicode": "\uD83D\uDE80",
      "escaped": "a\n\t\u0000",
      "array": [
        true,
        false,
        null,
        -2,
        1.25,
        1e3
      ]
    })"
            );
            check(parsed_json["integer"].integer() == std::numeric_limits<int64_t>::max(), "JSON int64 max");
            check(parsed_json["low"].integer() == std::numeric_limits<int64_t>::min(), "JSON int64 min");
            check(parsed_json["unicode"].str() == "🚀", "JSON surrogate pair");
            check(Json::parse(parsed_json.dump()).dump() == parsed_json.dump(), "JSON roundtrip");
            json_numbers_selftest();
            for (auto text :
                 {"",
                  "01",
                  "-",
                  "1.",
                  "1e",
                  "[1,]",
                  "{\"x\":1,}",
                  "true x",
                  "\"\\uD800\"",
                  "\"\\uDC00\"",
                  "\"\\uD800\\u0041\"",
                  "\"\\x\"",
                  "{\"x\":1,\"x\":2}",
                  "1e999"}) {
                rejects(text);
            }
            rejects(std::string("\"") + char(0xc0) + char(0x80) + '"');
            check(valid_utf8("中文 🚀"), "UTF-8 validity");
            check(!valid_utf8(std::string(1, char(0xff))), "UTF-8 invalid byte");
            check(text_width("中文") == 4 && text_width("é") == 1, "Unicode width");
            check(quantize(black) == 16 && quantize({255, 255, 255}) == 231, "256 color quantization");
            Grid accented(20, 4);
            highlight(accented, 1, 1, 10, "é", 0);
            check(accented.cells[22].glyph == "é", "Highlight preserves combining marks");
            check(
                accented.cells[22].fg == black && accented.cells[21].glyph == "▀" &&
                    accented.cells[22].bg == mosaic(2, 2, 0, 1),
                "Highlight keeps black labels and half blocks"
            );
            int position = 0;
            navigate(position, Key::Up, 45, 16);
            check(position == 44, "List wraps upward");
            navigate(position, Key::Down, 45, 16);
            check(position == 0, "List wraps downward");
            navigate(position, Key::PageDown, 45, 16);
            check(position == 16, "List jumps by visible page");
            navigate(position, Key::End, 45, 16);
            navigate(position, Key::PageUp, 45, 16);
            check(position == 28, "List pages upward from end");
            navigate(position, Key::Home, 45, 16);
            check(position == 0, "List jumps home");
            auto daily = [](std::initializer_list<int> values) {
                Json::Array days;
                for (int tokens : values) {
                    days.push_back(Json::object({{"tokens", tokens}}));
                }
                return Json(std::move(days));
            };
            auto chart = usage_chart(daily({100, 200, 300}), 0, 3, 2);
            check(
                chart.levels == std::vector<int>({1, 9, 16}) && chart.least == 100 && chart.average == 200,
                "Chart scales from period minimum and keeps positive days visible"
            );
            chart = usage_chart(daily({0, 100, 200, 300, 400}), 0, 3, 2);
            check(
                chart.tokens == std::vector<double>({0, 300, 700}) && chart.levels[0] == 0 &&
                    std::accumulate(chart.tokens.begin(), chart.tokens.end(), 0.0) == 1000 && chart.most == 400,
                "Chart sums uneven buckets and retains daily legend extrema"
            );
            chart = usage_chart(daily({0, 100, 200}), 0, 9, 2);
            check(
                chart.tokens == std::vector<double>({0, 0, 0, 100, 100, 100, 200, 200, 200}) && chart.levels[0] == 0 &&
                    chart.levels.back() == 16,
                "Chart stretches days equally across its full width"
            );
            chart = usage_chart(daily({10, 10}), 0, 6, 3);
            check(
                std::all_of(chart.levels.begin(), chart.levels.end(), [](int level) { return level == 24; }),
                "Chart handles constant positive usage"
            );
            chart = usage_chart(daily({0, 0}), 0, 6, 2);
            check(
                std::all_of(chart.levels.begin(), chart.levels.end(), [](int level) { return level == 0; }),
                "Chart leaves zero days empty"
            );
            Json::Array history;
            for (int tokens = 0; tokens < 40; ++tokens) {
                history.push_back(Json::object({{"tokens", tokens}}));
            }
            chart = usage_chart(Json(history), 7, 14, 2);
            check(
                chart.least == 33 && chart.most == 39 && chart.average == 36 && chart.tokens.front() == 33,
                "Chart selects the last seven days"
            );
            chart = usage_chart(Json(history), 30, 5, 2);
            check(
                chart.least == 10 && chart.most == 39 && chart.average == 24.5 && chart.tokens.front() == 75,
                "Chart selects and buckets the last thirty days"
            );
            Grid bars(20, 6);
            draw_usage_chart(bars, 2, 1, 3, 2, daily({100, 200, 300}), 0);
            check(
                bars.cells[2 * 20 + 2].glyph == "▁" && bars.cells[1 * 20 + 4].glyph == "█",
                "Chart renders eighth blocks across multiple text rows"
            );
            Json::Array model_fixture = Json::parse(R"([
            {"model":"a", "enabled":true, "offered":false, "reason":"disabled"},
            {"model":"b", "enabled":false, "offered":false, "reason":"disabled"},
            {"model":"c", "enabled":false, "offered":false, "reason":"not_listed"}
        ])")
                                            .array();
            ModelList combined;
            combined.reset(model_fixture);
            check(
                combined.rows().size() == 7 && combined.selected_row() == 1 && combined.model_index() == 0 &&
                    combined.rows()[2].model < 0 && combined.rows()[2].title.empty(),
                "Enabled section excludes off models and selects past its header"
            );
            combined.input(Key::Up, 3);
            check(combined.selected_row() == 6 && combined.model_index() == 2, "Combined model wheel wraps up");
            combined.input(Key::Down, 3);
            check(combined.selected_row() == 1, "Combined model wheel wraps down");
            combined.input(Key::PageDown, 1);
            check(combined.selected_row() == 4, "Model Page Down skips blank line and section header");
            combined.input(Key::PageUp, 1);
            check(combined.selected_row() == 1, "Model Page Up skips section header");
            combined.input(Key::Tab, 3);
            check(combined.selected_row() == 4 && combined.rows()[4].all, "Tab selects first All models row");
            combined.input(Key::BackTab, 3);
            check(combined.selected_row() == 1, "Shift-Tab selects first Enabled row");
            combined.input(Key::Tab, 3);
            combined.input(Key::Down, 3);
            model_fixture[1]["enabled"] = true;
            model_fixture[1]["reason"] = nullptr;
            combined.reset(model_fixture);
            check(
                combined.model_index() == 1 && combined.rows()[size_t(combined.selected_row())].all &&
                    std::count_if(
                        combined.rows().begin(),
                        combined.rows().end(),
                        [](const ModelRow &row) { return row.id == "b"; }
                    ) == 2,
                "Enabling a duplicate keeps All models selected and adds its Enabled row"
            );
            combined.input(Key::Tab, 3);
            combined.input(Key::Down, 3);
            check(
                combined.model_index() == 1 && !combined.rows()[size_t(combined.selected_row())].all,
                "Both sections select the same enabled model"
            );
            model_fixture[1]["enabled"] = false;
            combined.reset(model_fixture);
            check(
                combined.model_index() == 1 && combined.rows()[size_t(combined.selected_row())].all,
                "Disabling an Enabled model falls back to its All models row"
            );
            model_fixture[0]["enabled"] = false;
            combined.reset(model_fixture);
            combined.input(Key::Home, 3);
            check(
                combined.rows()[1].title == "None yet" && combined.rows()[2].title.empty() &&
                    combined.selected_row() == 4,
                "Empty Enabled section has a non-selectable None yet row"
            );
            combined.input(Key::Tab, 3);
            check(
                combined.selected_row() == 4 && combined.first_row(1) == 4,
                "Empty section jump keeps selection visible and selectable"
            );
            model_fixture.clear();
            for (int index = 0; index < 320; ++index) {
                model_fixture.push_back(Json::object({{"model", std::to_string(index)}, {"enabled", true}}));
            }
            combined.reset(model_fixture, false);
            combined.input(Key::End, 16);
            check(
                combined.model_index() == 319 && combined.first_row(16) + 16 > combined.selected_row(),
                "Large combined model lists keep End visible"
            );
            combined.input(Key::Home, 16);
            combined.input(Key::PageDown, 16);
            check(combined.model_index() == 16, "Large model list pages by visible rows");
            Json::Array grouped_models = Json::parse(R"([
                {"model":"alpha/a","enabled":true,"offered":true},
                {"model":"plain","enabled":true,"offered":true},
                {"model":"beta/b","enabled":false},
                {"model":"alpha/c","enabled":true,"offered":true},
                {"model":"beta/d","enabled":true,"offered":true},
                {"model":"tail","enabled":true,"offered":true}
            ])")
                                             .array();
            ModelList grouped;
            grouped.reset(grouped_models, false);
            const auto &group_rows = grouped.rows();
            check(
                group_rows.size() == 22 && group_rows[0].title == "Enabled" && group_rows[11].title == "All models",
                "Grouped sections have their expected rows"
            );
            for (int row : {1, 8, 12, 19}) {
                check(
                    group_rows[size_t(row)].category && group_rows[size_t(row)].model < 0 &&
                        group_rows[size_t(row)].title == (row == 1 || row == 12 ? "alpha" : "beta"),
                    "Categories follow their first appearance in each section"
                );
            }
            for (int row : {4, 7, 10, 15, 18}) {
                check(
                    group_rows[size_t(row)].model < 0 && group_rows[size_t(row)].title.empty() &&
                        !group_rows[size_t(row)].category,
                    "Blank rows separate categories and sections"
                );
            }
            constexpr int selectable_rows[]{2, 3, 5, 6, 9, 13, 14, 16, 17, 20, 21};
            constexpr int model_indices[]{0, 3, 1, 5, 4, 0, 3, 1, 5, 2, 4};
            constexpr std::string_view
                labels[]{"  a", "  c", "plain", "tail", "  d", "  a", "  c", "plain", "tail", "  b", "  d"};
            for (int index = 0; index < 11; ++index) {
                const ModelRow &row = group_rows[size_t(selectable_rows[index])];
                check(
                    row.model == model_indices[index] && row.label == labels[index] &&
                        row.id == grouped_models[size_t(row.model)]["model"].str() && row.all == (index >= 5),
                    "Category labels strip one prefix and indent two spaces while ungrouped labels stay unchanged"
                );
                check(
                    grouped.selected_row() == selectable_rows[index],
                    "Down skips category headings and blanks across sections"
                );
                grouped.input(Key::Down, 5);
            }
            check(grouped.selected_row() == 2, "Down wraps the last grouped model to the first Enabled model");
            for (int index = 10; index >= 0; --index) {
                grouped.input(Key::Up, 5);
                check(
                    grouped.selected_row() == selectable_rows[index],
                    "Up skips group and section headings and wraps to the last All models row"
                );
            }
            for (int row = 0; row < int(group_rows.size()); ++row) {
                if (group_rows[size_t(row)].model < 0) {
                    check(
                        !grouped.select(row) && grouped.selected_row() == 2,
                        "Mouse selection rejects every heading and blank row without moving selection"
                    );
                }
            }
            grouped.input(Key::PageDown, 2);
            check(grouped.selected_row() == 5, "Page Down skips a blank before ungrouped models");
            grouped.input(Key::PageDown, 2);
            check(grouped.selected_row() == 9, "Page Down skips a blank and category heading");
            grouped.input(Key::PageDown, 2);
            check(grouped.selected_row() == 13, "Page Down skips All models and its category heading");
            grouped.input(Key::PageDown, 5);
            check(grouped.selected_row() == 20, "Page Down skips the blank before the next category");
            grouped.input(Key::PageUp, 1);
            check(grouped.selected_row() == 17, "Page Up skips a category heading and blank");
            grouped.input(Key::PageUp, 5);
            check(grouped.selected_row() == 9, "Page Up skips a section and category heading");
            grouped.input(Key::PageUp, 1);
            check(grouped.selected_row() == 6, "Page Up skips the previous category heading");
            grouped.input(Key::Home, 5);
            check(grouped.selected_row() == 2, "Home skips the Enabled and category headings");
            grouped.input(Key::End, 5);
            check(grouped.selected_row() == 21, "End selects the last model of the last category");
            grouped.input(Key::Home, 5);
            check(
                grouped.first_row(5) == 0 && group_rows[0].title == "Enabled" && group_rows[1].category,
                "End then Home restores row zero with Enabled and the first category visible"
            );
            grouped.input(Key::Tab, 5);
            check(
                grouped.selected_row() == 13 && grouped.first_row(5) == 10 && group_rows[11].title == "All models" &&
                    group_rows[12].category,
                "Tab jumps to All models with its preceding blank, section and category headings visible"
            );
            grouped.input(Key::BackTab, 5);
            check(
                grouped.selected_row() == 2 && grouped.first_row(5) == 0,
                "Shift-Tab jumps to Enabled with both headings visible"
            );
            grouped.input(Key::BackTab, 5);
            check(grouped.selected_row() == 13, "Shift-Tab jumps back to All models across category headings");
            for (Key direction : {Key::Up, Key::PageUp, Key::Home}) {
                grouped.input(Key::End, 5);
                int remaining = int(group_rows.size());
                while (group_rows[size_t(grouped.selected_row())].all && --remaining > 0) {
                    grouped.input(direction, 5);
                    int first = grouped.first_row(5);
                    check(
                        group_rows[size_t(grouped.selected_row())].model >= 0 && grouped.selected_row() >= first &&
                            grouped.selected_row() < first + 5,
                        "Backward grouped navigation keeps the selected model visible"
                    );
                }
                check(
                    remaining > 0 && !group_rows[size_t(grouped.selected_row())].all,
                    "Up, Page Up and Home can return from the bottom of All models to Enabled"
                );
            }
            grouped.input(Key::Home, 16);
            grouped.input(Key::Tab, 16);
            grouped.input(Key::Up, 16);
            int first_above_all = grouped.first_row(16);
            check(
                grouped.selected_row() == 9 && !group_rows[9].all && first_above_all <= 11 &&
                    first_above_all + 16 > 12 && group_rows[11].title == "All models" && group_rows[12].category,
                "Up from the first All models row keeps the All models title and category in view"
            );
            grouped.input(Key::End, 5);
            int last_selection = grouped.selected_row();
            grouped.scroll(-3, 5);
            check(
                grouped.selected_row() == last_selection && grouped.first_row(5) == int(group_rows.size()) - 8,
                "Scrolling moves three physical rows without changing the selected model"
            );
            grouped.scroll(-1000, 5);
            grouped.scroll(-1, 5);
            check(
                grouped.selected_row() == last_selection && grouped.first_row(5) == 0,
                "Scrolling reaches row zero and clamps with Enabled and its category visible"
            );
            grouped.input(Key::Up, 5);
            check(
                grouped.first_row(5) <= grouped.selected_row() && grouped.first_row(5) + 5 > grouped.selected_row(),
                "Up snaps the model view back to the selection"
            );
            Grid grid(120, 40);
            Diff diff;
            grid.text(4, 4, "BitFrost");
            grid.pixel(5, 12, blue);
            grid.pixel(5, 13, white);
            check(grid.cells[6 * 120 + 5].bg == white, "Half-block surface");
            check(!diff.frame(grid).empty() && diff.frame(grid).empty(), "Diff suppresses identical frames");
            grid.text(4, 4, "X");
            auto changed = diff.frame(grid);
            check(changed.size() < 150 && changed.find('X') != std::string::npos, "Diff emits one changed cell");
            InputParser parser;
            auto keys = parser.feed("\033[A\033OBwseaq\r\003");
            check(
                keys.size() == 9 && keys[0].key == Key::Up && keys[1].key == Key::Down &&
                    keys.back().key == Key::Interrupt,
                "Input CSI SS3 and shortcuts"
            );
            check(parser.feed("wasdeq", true).size() == 6, "Editor preserves shortcut letters");
            check(parser.feed("\033").empty() && parser.timeout_ms() >= 0, "Escape disambiguation");
            check(parser.feed("[C")[0].key == Key::Right, "Split escape sequence");
            auto paging = parser.feed("\033[5~\033[6~\033[1~\033[4~\033OH\033OF");
            check(
                paging.size() == 6 && paging[0].key == Key::PageUp && paging[1].key == Key::PageDown &&
                    paging[2].key == Key::Home && paging[3].key == Key::End && paging[4].key == Key::Home &&
                    paging[5].key == Key::End,
                "Input paging and end keys"
            );
            auto tabs = parser.feed("\t\033[Z");
            check(
                tabs.size() == 2 && tabs[0].key == Key::Tab && tabs[1].key == Key::BackTab,
                "Input Tab and Shift-Tab"
            );
            std::deque<Json> queue;
            std::vector<Json> sent;
            App app(
                [&](const Json &request) {
                    queue.push_back(request);
                    sent.push_back(request);
                },
                false
            );
            App *active = &app;
            bool model_enabled = true;
            Json::Array hourly, daily_usage;
            for (int hour = 0; hour < 24; ++hour) {
                hourly.push_back(Json::object({{"hour", hour}, {"tokens", (hour % 6) * 1000}}));
            }
            for (int day = 0; day < 35; ++day) {
                daily_usage.push_back(Json::object({{"tokens", (day % 7) * 10000}}));
            }
            auto pump = [&] {
                int count = 0;
                while (!queue.empty()) {
                    check(++count < 100, "RPC loop");
                    auto request = queue.front();
                    queue.pop_front();
                    auto method = request["method"].str();
                    Json result;
                    if (method == "hello") {
                        result = Json::object({{"protocol", 1}, {"revision", "abc"}, {"configError", nullptr}});
                    } else if (method == "providers.list") {
                        result = Json::parse(
                            R"({
      "providers": [
        {
          "id": "codex",
          "displayName": "Codex",
          "firstClass": true,
          "detected": true,
          "enabled": true,
          "mode": "deny"
        },
        {
          "id": "crush",
          "displayName": "Crush",
          "firstClass": false,
          "detected": true,
          "enabled": false,
          "mode": "allow"
        }
      ]
    })"
                        );
                    } else if (method == "models.list") {
                        result = Json::parse(
                            R"({
      "pending": false,
      "error": null,
      "models": [
        {
          "model": "test/model",
          "displayName": "Model",
          "company": "Example",
          "efforts": ["low", "high"],
          "defaultEffort": "high",
          "agent": "coding-agent",
          "enabled": true,
          "offered": true,
          "reason": null
        },
        {
          "model": "test/claude",
          "displayName": "Claude",
          "enabled": false,
          "offered": false,
          "reason": "not_listed"
        },
        {
          "model": "test/claude-other",
          "displayName": "Claude other",
          "enabled": false,
          "offered": false,
          "reason": "not_listed"
        }
      ]
    })"
                        );
                        auto &models = std::get<Json::Array>(result["models"].value);
                        models[0]["enabled"] = model_enabled;
                        models[0]["offered"] = model_enabled;
                        models[0]["reason"] = model_enabled ? Json() : Json("disabled");
                    } else if (method == "models.stats") {
                        result = Json::parse(
                            R"({
      "rows": [
        {
          "model": "test/model",
          "total": {
            "sessions": 3,
            "closedSessions": 2,
            "sessionMs": 7440000,
            "turns": 4,
            "turnMs": 68000,
            "inputTokens": 50,
            "outputTokens": 60
          },
          "today": {
            "sessions": 3,
            "closedSessions": 2,
            "sessionMs": 7440000,
            "turns": 4,
            "turnMs": 68000,
            "inputTokens": 8000,
            "outputTokens": 4000
          },
          "week": {
            "inputTokens": 20000,
            "outputTokens": 1000
          },
          "month": {
            "sessions": 7,
            "closedSessions": 6,
            "sessionMs": 22320000,
            "turns": 56,
            "turnMs": 952000,
            "inputTokens": 243800,
            "outputTokens": 12400
          },
          "daily": [
          ]
        }
      ]
    })"
                        );
                        auto &row = std::get<Json::Array>(result["rows"].value)[0];
                        row["hourly"] = hourly;
                        row["daily"] = daily_usage;
                        if (request["params"]["model"].str() != "test/model") {
                            row = Json::object(
                                {{"model", request["params"]["model"]},
                                 {"firstUsedAt", nullptr},
                                 {"lastUsedAt", nullptr}}
                            );
                        }
                    } else if (method == "settings.get") {
                        result = Json::parse(
                            R"({
      "revision": "abc",
      "sections": [
        {
          "id": "general",
          "title": "General",
          "items": [
            {
              "key": "flag",
              "label": "Flag",
              "type": "bool",
              "value": true
            },
            {
              "key": "text",
              "label": "Text",
              "type": "text",
              "value": "old"
            },
            {
              "key": "number",
              "label": "Number",
              "type": "number",
              "value": 1,
              "min": 0
            },
            {
              "key": "choice",
              "label": "Choice",
              "type": "choice",
              "value": "a",
              "options": [
                {
                  "value": "a",
                  "label": "A"
                },
                {
                  "value": "b",
                  "label": "B"
                }
              ]
            },
            {
              "key": "list",
              "label": "List",
              "type": "list",
              "value": [
                "one"
              ]
            }
          ]
        }
      ]
    })"
                        );
                    } else if (method == "models.set") {
                        model_enabled = request["params"]["enabled"].boolean();
                        result = Json::object({{"ok", true}, {"revision", "abc"}, {"warnings", Json::Array{}}});
                    } else {
                        result = Json::object({{"ok", true}, {"revision", "abc"}, {"warnings", Json::Array{}}});
                    }
                    active->receive(Json::object({{"id", request["id"]}, {"result", result}}));
                }
            };
            auto key = [&](Key input_key, std::string input_text = {}) {
                app.input({input_key, std::move(input_text)});
            };
            app.start();
            check(!app.particles_active(), "Static mode holds no particle pool");
            pump();
            app.render(grid);
            check(grid.cells[121].glyph == "┌", "Home root border");
            key(Key::Enter);
            pump();
            check(app.page() == Page::Models && app.focused() == Focus::Sidebar, "Home to models");
            key(Key::Enter);
            auto frame_text = [&](const Grid &frame) {
                std::string text;
                for (const Cell &cell : frame.cells) {
                    text += cell.glyph;
                }
                return text;
            };
            app.render(grid);
            pump();
            app.render(grid);
            check(
                frame_text(grid).find("Avg. session time") != std::string::npos &&
                    frame_text(grid).find("62m") != std::string::npos,
                "Stats panel averages only closed sessions"
            );
            check(
                grid.cells[23 * 120 + 54].glyph == "E" && grid.cells[25 * 120 + 27].glyph == " " &&
                    grid.cells[26 * 120 + 27].glyph == "F" && grid.cells[28 * 120 + 27].glyph == " " &&
                    grid.cells[29 * 120 + 27].glyph == "L" && grid.cells[31 * 120 + 27].glyph == " " &&
                    grid.cells[34 * 120 + 27].glyph == "S" && frame_text(grid).find("Company:") == std::string::npos,
                "Stats facts separate groups and align company with the display name"
            );
            check(
                grid.cells[35 * 120 + 25].glyph == "─" && grid.cells[36 * 120 + 25].glyph != "│",
                "Sidebar stops at status rule"
            );
            constexpr std::string_view tab_labels[]{"Today", "7 days", "30 days", "All time"};
            constexpr std::string_view tab_tokens[]{"12.0k", "21.0k", "256.2k", "110"};
            constexpr int tab_days[]{0, 7, 30, 0};
            for (int tab = 0; tab < 4; ++tab) {
                app.render(grid);
                std::string active_label;
                for (int x = 64; x < 116; ++x) {
                    const Cell &cell = grid.cells[23 * 120 + x];
                    active_label += cell.fg == black ? cell.glyph : " ";
                }
                check(
                    active_label.find(tab_labels[tab]) != std::string::npos &&
                        frame_text(grid).find(tab_tokens[tab]) != std::string::npos,
                    "Four stats tabs start with Today and select their matching totals"
                );
                Grid expected(120, 40);
                draw_usage_chart(expected, 64, 32, 52, 2, tab == 0 ? Json(hourly) : Json(daily_usage), tab_days[tab]);
                for (int y = 32; y < 35; ++y) {
                    for (int x = 64; x < 116; ++x) {
                        check(
                            grid.cells[y * 120 + x].glyph == expected.cells[y * 120 + x].glyph,
                            "Today charts every hour and other tabs chart the matching daily range"
                        );
                    }
                }
                key(Key::Right);
            }
            app.render(grid);
            check(grid.cells[23 * 120 + 65].fg == black, "Right wraps All time back to Today");
            key(Key::Left);
            app.render(grid);
            check(grid.cells[23 * 120 + 104].fg == black, "Left wraps Today back to All time");
            key(Key::Right);
            key(Key::Right);
            key(Key::Right);
            app.render(grid);
            check(frame_text(grid).find("256.2k") != std::string::npos, "Thirty day stats tab");
            key(Key::Down);
            key(Key::Down);
            pump();
            app.render(grid);
            check(frame_text(grid).find("Never") != std::string::npos, "Unused model dates");
            key(Key::Up);
            key(Key::Up);
            pump();
            app.render(grid);
            check(frame_text(grid).find("256.2k") != std::string::npos, "Stats tab sticks across models");
            Json notification = Json::parse(R"({"method":"stats.updated","params":{"provider":"codex",
            "rows":[{"model":"test/model","month":{"inputTokens":1000000},
            "daily":[{"tokens":1000000}]}]}})");
            app.receive(notification);
            app.render(grid);
            check(
                frame_text(grid).find("1.0M") != std::string::npos && grid.cells[23 * 120 + 91].fg == black &&
                    app.focused() == Focus::List && queue.empty(),
                "Live stats replace usage and keep selected model and tab without another request"
            );
            std::string updated_frame = frame_text(grid);
            notification["params"]["provider"] = "crush";
            notification["params"]["rows"] = Json::Array{};
            app.receive(notification);
            app.render(grid);
            check(frame_text(grid) == updated_frame, "Stats for other providers leave the current view alone");
            key(Key::Left);
            key(Key::Left);
            key(Key::Enter);
            pump();
            check(app.focused() == Focus::Popup, "Model popup");
            app.render(grid);
            auto stats_requests = [&] {
                return std::count_if(sent.begin(), sent.end(), [](const Json &request) {
                    return request["method"].str() == "models.stats";
                });
            };
            auto before_write = stats_requests();
            key(Key::Enter);
            pump();
            check(
                before_write >= 1 && stats_requests() > before_write,
                "Stats load with the provider and refresh after model write"
            );
            bool toggled = false;
            for (auto &request : sent) {
                if (request["method"].str() == "models.set") {
                    toggled = true;
                    check(!request["params"]["enabled"].boolean(), "Model disabling");
                    check(request["params"]["revision"].str() == "abc", "Write revision");
                }
            }
            check(toggled, "Model write request");
            key(Key::Back);
            key(Key::Back);
            check(app.page() == Page::Home, "Return home");
            key(Key::Down);
            key(Key::Enter);
            pump();
            key(Key::Enter);
            key(Key::Enter);
            pump();
            check(app.status() == "Saved", "Bool save");
            key(Key::Down);
            key(Key::Enter);
            check(app.editing(), "Text editor");
            key(Key::End);
            key(Key::Text, "wasdeq🚀");
            key(Key::Left);
            key(Key::Backspace);
            key(Key::Enter);
            pump();
            check(!app.editing(), "Text save");
            key(Key::Down);
            key(Key::Enter);
            key(Key::Home);
            key(Key::Delete);
            key(Key::Text, "-1");
            key(Key::Enter);
            check(app.editing(), "Number min validation");
            key(Key::Back);
            key(Key::Down);
            key(Key::Enter);
            key(Key::Down);
            key(Key::Enter);
            pump();
            check(app.focused() == Focus::List, "Choice save");
            key(Key::Down);
            key(Key::Enter);
            key(Key::Down);
            key(Key::Enter);
            key(Key::Text, "new");
            key(Key::Enter);
            pump();
            check(app.focused() == Focus::List, "List add");
            key(Key::Enter);
            key(Key::Enter);
            pump();
            check(app.focused() == Focus::List, "List remove");
            key(Key::Back);
            key(Key::Back);
            key(Key::Back);
            check(!app.alive(), "Home quit");
            App animated([](const Json &) {}, true);
            check(animated.particles_active(), "Home owns its particle pool");
            animated.render(grid);
            animated.input({Key::Enter, {}});
            animated.step(0.1);
            animated.render(grid);
            check(animated.page() == Page::Home && grid.cells[121].glyph == "┌", "Transition preserves border");
            animated.step(0.4);
            check(animated.page() == Page::Models, "Transition finishes");
            check(!animated.particles_active(), "Models holds no particle pool");
            for (auto [width, height] : {std::pair{1, 1}, {20, 8}, {40, 16}, {80, 24}, {200, 60}}) {
                Grid small(width, height);
                animated.render(small);
                diff.frame(small);
            }
            animated.input({Key::Back, {}});
            check(animated.particles_active(), "Returning home restores particles");
            animated.input({Key::Down, {}});
            animated.input({Key::Enter, {}});
            animated.step(0.5);
            check(animated.page() == Page::Settings && !animated.particles_active(), "Settings holds no particle pool");
            App errors([&](const Json &request) { queue.push_back(request); }, false);
            queue.clear();
            errors.start();
            auto hello = queue.front();
            errors.receive(
                Json::object(
                    {{"id", hello["id"]},
                     {"error", Json::object({{"code", "config_invalid"}, {"message", "Invalid config"}})}}
                )
            );
            check(errors.status() == "Invalid config", "Config invalid stays in UI");
            queue.clear();
            App faults(
                [&](const Json &request) {
                    queue.push_back(request);
                    sent.push_back(request);
                },
                false
            );
            active = &faults;
            auto fault_key = [&](Key input_key) {
                faults.input({input_key, {}});
            };
            faults.start();
            pump();
            fault_key(Key::Down);
            fault_key(Key::Enter);
            pump();
            fault_key(Key::Enter);
            fault_key(Key::Enter);
            auto write = queue.front();
            queue.pop_front();
            faults.receive(
                Json::object(
                    {{"id", write["id"]},
                     {"error", Json::object({{"code", "config_invalid"}, {"message", "Rejected value"}})}}
                )
            );
            check(faults.alive() && faults.status() == "Rejected value", "Validation error stays in page");
            fault_key(Key::Enter);
            write = queue.front();
            queue.pop_front();
            faults.receive(
                Json::object(
                    {{"id", write["id"]},
                     {"error", Json::object({{"code", "conflict"}, {"message", "Config changed elsewhere"}})}}
                )
            );
            check(queue.size() == 3, "Conflict reloads hello providers and settings");
            pump();
            check(
                faults.status() == "Config changed elsewhere" && faults.focused() == Focus::List,
                "Conflict message survives reload"
            );
            faults.receive(
                Json::object({{"method", "config.changed"}, {"params", Json::object({{"revision", "new"}})}})
            );
            check(queue.size() == 3, "Config notification refresh");
            pump();
            fault_key(Key::Back);
            fault_key(Key::Back);
            fault_key(Key::Up);
            fault_key(Key::Enter);
            pump();
            faults.receive(
                Json::object({{"method", "models.updated"}, {"params", Json::object({{"provider", "codex"}})}})
            );
            check(
                queue.size() == 1 && queue.front()["method"].str() == "models.list",
                "Discovery notification refresh"
            );
            pump();
            fault_key(Key::Down);
            pump();
            fault_key(Key::Enter);
            fault_key(Key::Enter);
            check(
                queue.front()["method"].str() == "providers.set" && queue.front()["params"]["enabled"].boolean(),
                "Disabled provider enable action"
            );
            pump();
            check(parser.feed("\032")[0].key == Key::Suspend, "Raw Ctrl-Z suspend event");
            check(shown(Json::Array{Json("one")}) == "1 item", "Singular list count");
            check(shown(Json::Array{}) == "0 items", "Empty list count");
            check(
                pixel_text_height(1, PixelFont::Small) == 5 && pixel_text_height(2) == 14,
                "Version font is about one third of the logo height"
            );
            App home([](const Json &) {}, false);
            Grid centered(120, 40);
            home.render(centered);
            check(
                centered.cells[24 * 120 + 54].glyph == "▀" && centered.cells[24 * 120 + 66].bg == black &&
                    centered.cells[24 * 120 + 56].glyph == "M" && centered.cells[26 * 120 + 56].glyph == "S" &&
                    centered.cells[28 * 120 + 56].glyph == "S",
                "Home menu centers a twelve cell highlight with labels exactly two rows apart"
            );
            home.input({Key::Down, {}});
            home.render(centered);
            check(
                centered.cells[26 * 120 + 54].glyph == "▀" && centered.cells[26 * 120 + 66].bg == black &&
                    centered.cells[24 * 120 + 56].glyph == "M" && centered.cells[26 * 120 + 56].glyph == "S",
                "Home labels share the same left edge when selection moves"
            );
            check(
                centered.cells[25 * 120 + 54].glyph == "▄" && centered.cells[25 * 120 + 54].bg == black &&
                    centered.cells[27 * 120 + 54].glyph == "▀" && centered.cells[27 * 120 + 54].bg == black &&
                    centered.cells[23 * 120 + 54].glyph == " " && centered.cells[23 * 120 + 54].bg == black,
                "Only the active item owns the half rows between neighboring labels"
            );
            home.input({Key::Down, {}});
            home.render(centered);
            check(
                centered.cells[27 * 120 + 54].glyph == "▄" && centered.cells[29 * 120 + 54].glyph == "▀" &&
                    centered.cells[25 * 120 + 54].glyph == " " && centered.cells[26 * 120 + 56].glyph == "S",
                "Moving selection transfers the shared half rows to the next item"
            );
            Grid medium(80, 40);
            home.render(medium);
            check(
                medium.cells[17 * 80 + 62].glyph == std::string_view(BITFROST_VERSION).substr(0, 1) &&
                    medium.cells[17 * 80 + 66].glyph == std::string_view(BITFROST_VERSION).substr(4, 1),
                "Medium logo uses right-aligned plain version text"
            );
            home.input({Key::Home, {}});
            Grid short_home(80, 20);
            home.render(short_home);
            check(
                short_home.cells[2 * 80 + 36].glyph == "B" && short_home.cells[7 * 80 + 36].glyph == "M" &&
                    short_home.cells[9 * 80 + 36].glyph == "S" && short_home.cells[11 * 80 + 36].glyph == "S" &&
                    short_home.cells[15 * 80 + 36].glyph == "─",
                "Short Home centers the compact menu below the plain logo and above the status bar"
            );
            check(
                pixel_text_width("BITFROST", 1, PixelFont::Bold) == 55 && pixel_text_height(1, PixelFont::Bold) == 10,
                "Bold logo dimensions"
            );
            check(
                date(Json(int64_t(std::time(nullptr)) * 1000)) == "Today" && date(Json()) == "Never",
                "Friendly current and missing dates"
            );
            Particles clipped_particles;
            ClipRegion home_region = inner_region(grid);
            std::vector<Emitter> home_emitters{{30, 20, 10, 1, home_region}};
            bool saw_particles = false;
            for (int frame = 0; frame < 90; ++frame) {
                clipped_particles.step(1.0 / 30, home_emitters, frame / 30.0);
                grid.clear();
                clipped_particles.draw(grid);
                for (int y = 0; y < grid.height; ++y) {
                    for (int x = 0; x < grid.width; ++x) {
                        const Cell &cell = grid.cells[size_t(y * grid.width + x)];
                        if (cell.glyph != " ") {
                            saw_particles = true;
                            check(home_region.contains(x, y * 2), "Home particles stay inside the border");
                        }
                    }
                }
            }
            check(saw_particles, "Home emitter produces particles");
            fault_key(Key::Back);
            fault_key(Key::Up);
            pump();
            fault_key(Key::Enter);
            fault_key(Key::Down);
            fault_key(Key::Enter);
            pump();
            faults.render(grid);
            pump();
            check(
                faults.focused() == Focus::Popup && frame_text(grid).find("> Enable") != std::string::npos,
                "Anthropic model exposes an enable action"
            );
            fault_key(Key::Enter);
            check(
                std::any_of(
                    queue.begin(),
                    queue.end(),
                    [](const Json &request) {
                        return request["method"].str() == "models.set" &&
                               request["params"]["model"].str() == "test/claude" &&
                               request["params"]["enabled"].boolean();
                    }
                ),
                "Anthropic model Enter sends an enable write"
            );
            Diff optimized;
            Grid styles(10, 4);
            styles.put(1, 1, "A", blue, black);
            styles.put(2, 1, "B", white, black);
            std::string frame_output = optimized.frame(styles);
            check(
                frame_output.find("\033[38;2;182;197;210mB") != std::string::npos,
                "Foreground changes do not resend the background"
            );
            styles.put(1, 1, "X", blue, black);
            styles.put(3, 1, "Y", blue, black);
            check(
                optimized.frame(styles).find("\033[CY") != std::string::npos,
                "Cursor gaps use shorter relative moves"
            );
            Grid solid(10, 4);
            solid.pixel(1, 2, blue);
            solid.pixel(1, 3, blue);
            Diff solid_output;
            std::string solid_frame = solid_output.frame(solid);
            check(
                solid_frame.find("▀") == std::string::npos &&
                    solid_frame.find("48;2;78;173;245m ") != std::string::npos,
                "Solid pixel cells use a background fill with identical color"
            );
            std::cout << "BitFrost selftest passed\n";
            return 0;
        } catch (const std::exception &exception) {
            std::cerr << "BitFrost selftest failed: " << exception.what() << '\n';
            return 1;
        }
    }
}
