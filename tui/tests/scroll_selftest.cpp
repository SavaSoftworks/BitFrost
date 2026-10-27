// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include <algorithm>
#include <deque>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        std::string line(const Grid &grid, int x, int y, int width, bool selected = false) {
            std::string result;
            for (int column = x; column < x + width; ++column) {
                const Cell &cell = grid.cells[size_t(y * grid.width + column)];
                result += !selected || (cell.fg == black && cell.bg != black) ? cell.glyph : " ";
            }
            return result;
        }

        std::string selection(const Grid &grid, int x, int y, int width, int height) {
            std::string result;
            for (int row = y; row < y + height; ++row) {
                result += line(grid, x, row, width, true);
            }
            return result;
        }

        void resume_visible_selftest() {
            for (Key direction : {Key::Up, Key::Down}) {
                ListView view;
                int selected = 0;
                view.scroll(50, 100, 5);
                view.input(selected, direction, 100, 5);
                require(
                    selected == 50 && view.first_row(selected, 100, 5) == 50,
                    "Either arrow selects the first visible flat row without moving the view"
                );
                view.input(selected, Key::Down, 100, 5);
                require(selected == 51, "The next arrow continues from the visible flat selection");
                view.input(selected, Key::End, 100, 5);
                view.first_row(selected, 100, 5);
                view.scroll(-50, 100, 5);
                view.input(selected, direction, 100, 5);
                require(
                    selected == 45 && view.first_row(selected, 100, 5) == 45,
                    "A selection below the flat viewport also resumes at its top"
                );
                view.scroll(1, 100, 5);
                view.input(selected, Key::Down, 100, 5);
                require(selected == 46, "Scrolling the active row just offscreen selects the new top");
                view.scroll(-1, 100, 5);
                view.input(selected, Key::Down, 100, 5);
                require(selected == 47, "An active row still on screen moves normally after scrolling");

                GroupedList grouped;
                std::vector<std::string> groups;
                Json::Array models;
                for (int index = 0; index < 40; ++index) {
                    std::string group = "Group " + std::to_string(index / 2);
                    groups.push_back(group);
                    models.push_back(
                        Json::object({{"model", group + "/model-" + std::to_string(index)}, {"enabled", true}})
                    );
                }
                grouped.reset(groups);
                selected = 0;
                grouped.scroll(4, 5);
                grouped.input(selected, direction, 5);
                require(
                    selected == 2 && grouped.first_row(selected, 5) == 4,
                    "Grouped lists select the first visible item and skip the heading"
                );
                grouped.input(selected, Key::Down, 5);
                require(selected == 3, "Grouped navigation continues from the adopted selection");
                grouped.input(selected, Key::End, 5);
                grouped.scroll(-40, 5);
                int top = grouped.first_row(selected, 5);
                auto row =
                    std::find_if(grouped.rows().begin() + top, grouped.rows().end(), [](const GroupedRow &entry) {
                        return entry.item >= 0;
                    });
                int expected = row->item;
                grouped.input(selected, direction, 5);
                require(
                    selected == expected && grouped.first_row(selected, 5) == top,
                    "Grouped lists resume at the visible top when the selection is below it"
                );

                ModelList model_list;
                model_list.reset(models, false);
                model_list.scroll(4, 5);
                top = model_list.first_row(5);
                auto model =
                    std::find_if(model_list.rows().begin() + top, model_list.rows().end(), [](const ModelRow &entry) {
                        return entry.model >= 0;
                    });
                expected = int(model - model_list.rows().begin());
                model_list.input(direction, 5);
                require(
                    model_list.selected_row() == expected && model_list.first_row(5) == top,
                    "Models skip visible separators without bringing earlier headings into view"
                );
                model_list.input(Key::Down, 5);
                require(model_list.selected_row() > expected, "Model navigation continues from the visible selection");
                model_list.input(Key::End, 5);
                model_list.scroll(-40, 5);
                top = model_list.first_row(5);
                model =
                    std::find_if(model_list.rows().begin() + top, model_list.rows().end(), [](const ModelRow &entry) {
                        return entry.model >= 0;
                    });
                expected = int(model - model_list.rows().begin());
                model_list.input(direction, 5);
                require(
                    model_list.selected_row() == expected && model_list.first_row(5) == top,
                    "Models also resume at the visible top after scrolling above the selection"
                );
            }
        }
    }

    void scroll_selftest() {
        resume_visible_selftest();
        std::deque<Json> pending;
        std::vector<Json> sent;
        App app(
            [&](const Json &request) {
                pending.push_back(request);
                sent.push_back(request);
            },
            false
        );
        Json::Array sessions;
        for (int index = 0; index < 600; ++index) {
            sessions.push_back(
                Json::object(
                    {{"id", "session-" + std::to_string(index)},
                     {"title", "session-" + std::to_string(index)},
                     {"createdAt", 1000000 - index},
                     {"changedAt", index + 1},
                     {"model", "test"}}
                )
            );
        }
        auto last = [&](std::string_view method) {
            auto found = std::find_if(sent.rbegin(), sent.rend(), [&](const Json &request) {
                return request["method"].str() == method;
            });
            return found == sent.rend() ? Json{} : *found;
        };
        auto count = [&](std::string_view method) {
            return std::count_if(sent.begin(), sent.end(), [&](const Json &request) {
                return request["method"].str() == method;
            });
        };
        auto pump = [&] {
            int replies = 0;
            while (!pending.empty()) {
                require(++replies < 100, "View paging does not loop without more scrolling");
                Json request = pending.front();
                pending.pop_front();
                std::string method = request["method"].str();
                Json result = Json::object({{"revision", "test"}});
                if (method == "providers.list") {
                    Json::Array providers;
                    for (int index = 0; index < 30; ++index) {
                        providers.push_back(
                            Json::object(
                                {{"id", "provider-" + std::to_string(index)},
                                 {"displayName",
                                  "Provider " + std::string(index < 10 ? "0" : "") + std::to_string(index)},
                                 {"enabled", true},
                                 {"detected", true}}
                            )
                        );
                    }
                    result["providers"] = providers;
                } else if (method == "models.list") {
                    Json::Array models;
                    for (int index = 0; index < 40; ++index) {
                        models.push_back(
                            Json::object(
                                {{"model", "model-" + std::to_string(index)}, {"enabled", true}, {"offered", true}}
                            )
                        );
                    }
                    result["models"] = models;
                } else if (method == "settings.get") {
                    Json::Array options, items, sections;
                    for (int index = 0; index < 30; ++index) {
                        options.push_back(
                            Json::object({{"label", "Option " + std::to_string(index)}, {"value", index}})
                        );
                        items.push_back(
                            Json::object(
                                {{"key", "item-" + std::to_string(index)},
                                 {"label", "Item " + std::to_string(index)},
                                 {"type", index == 0 ? "choice" : "bool"},
                                 {"value", index}}
                            )
                        );
                    }
                    items[0]["options"] = options;
                    for (int index = 0; index < 20; ++index) {
                        sections.push_back(
                            Json::object(
                                {{"id", std::to_string(index)},
                                 {"title", "Section " + std::to_string(index)},
                                 {"items", items}}
                            )
                        );
                    }
                    result["sections"] = sections;
                } else if (method == "subagents.overview") {
                    result = Json::object(
                        {{"now", 1000000},
                         {"running", Json::Array(sessions.begin(), sessions.begin() + 30)},
                         {"recent", Json::Array{}}}
                    );
                } else if (method == "subagents.page") {
                    const Json &params = request["params"];
                    int limit = int(params["limit"].integer());
                    int begin = 0, end = std::min(limit, int(sessions.size()));
                    bool after = !params["after"].null();
                    if (!params["before"].null() || after) {
                        std::string cursor = params[after ? "after" : "before"].str();
                        auto at = std::find_if(sessions.begin(), sessions.end(), [&](const Json &row) {
                            return std::to_string(row["createdAt"].integer()) + ':' + row["id"].str() == cursor;
                        });
                        require(at != sessions.end(), "History pages use an existing keyset cursor");
                        int index = int(at - sessions.begin());
                        if (after) {
                            end = index;
                            begin = std::max(0, end - limit);
                        } else {
                            begin = index + 1;
                            end = std::min(begin + limit, int(sessions.size()));
                        }
                    } else if (params["oldest"].boolean()) {
                        end = int(sessions.size());
                        begin = std::max(0, end - limit);
                    }
                    result = Json::object(
                        {{"now", 1000000},
                         {"rows", Json::Array(sessions.begin() + begin, sessions.begin() + end)},
                         {"total", int(sessions.size())},
                         {"more", after || params["oldest"].boolean() ? begin > 0 : end < int(sessions.size())}}
                    );
                } else if (method == "status.get") {
                    result["providers"] =
                        Json::Array(30, Json::object({{"id", "test"}, {"location", "Location"}, {"models", 3}}));
                }
                app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
            }
        };
        Grid grid(120, 20);
        auto draw = [&] {
            app.render(grid);
        };
        auto key = [&](Key key) {
            app.input({key, {}});
            pump();
            draw();
        };
        auto wheel = [&](int x, int delta) {
            require(app.mouse_input({{x, 7}, MouseKind::Wheel, delta}), "Wheel reaches its view");
            pump();
            draw();
        };
        app.start();
        pump();
        draw();
        std::string home = selection(grid, 0, 0, grid.width, grid.height);
        key(Key::ScrollDown);
        key(Key::ScrollUp);
        require(
            selection(grid, 0, 0, grid.width, grid.height) == home && app.focused() == Focus::Home,
            "Right stick does nothing on Home"
        );
        key(Key::Enter);
        wheel(30, 1);
        require(
            line(grid, 28, 5, 30).starts_with("model-2") && app.focused() == Focus::Sidebar,
            "Models wheel scrolls three rows without changing sidebar focus"
        );
        require(line(grid, 27, 13, 30).starts_with("model-0"), "Stats keep showing the selected off-screen model");
        key(Key::ScrollDown);
        require(
            line(grid, 28, 5, 30).starts_with("model-3") && app.focused() == Focus::Sidebar,
            "ScrollDown scrolls main content by one row while sidebar has focus"
        );
        key(Key::ScrollUp);
        require(line(grid, 28, 5, 30).starts_with("model-2"), "ScrollUp scrolls main content by one row");
        auto model_requests = count("models.list");
        wheel(5, 1);
        require(
            line(grid, 4, 5, 15).starts_with("Provider 03") && count("models.list") == model_requests &&
                app.focused() == Focus::Sidebar,
            "Sidebar wheel moves three rows without changing provider selection or loading models"
        );
        wheel(5, 1000);
        require(line(grid, 4, 5, 15).starts_with("Provider 20"), "Sidebar clamps at its last view");
        wheel(5, 1);
        require(line(grid, 4, 5, 15).starts_with("Provider 20"), "Sidebar never wraps at the bottom");
        key(Key::Down);
        require(
            last("models.list")["params"]["provider"].str() == "provider-20" &&
                line(grid, 4, 5, 15, true).starts_with("Provider 20"),
            "Sidebar Down selects the first visible provider without jumping back"
        );
        wheel(5, -1000);
        wheel(5, -1);
        require(line(grid, 4, 5, 15).starts_with("Provider 00"), "Sidebar clamps at the top");
        key(Key::Up);
        require(
            last("models.list")["params"]["provider"].str() == "provider-0",
            "Sidebar Up also selects the visible top when the active provider is below it"
        );
        key(Key::Down);
        require(
            last("models.list")["params"]["provider"].str() == "provider-1",
            "The next sidebar arrow moves normally"
        );
        wheel(30, 1000);
        key(Key::Enter);
        key(Key::Enter);
        require(
            app.focused() == Focus::Popup && line(grid, 41, 5, 30).starts_with("model-0"),
            "Enter still activates the selected model while it is off screen"
        );
        key(Key::Back);
        for (Key move : {Key::Down, Key::Up}) {
            key(Key::Home);
            wheel(30, 1000);
            std::string top = line(grid, 28, 5, 30);
            top.resize(top.find(' '));
            key(move);
            require(
                line(grid, 28, 5, 30, true).starts_with(top) && line(grid, 28, 5, 30).starts_with(top),
                "Either model arrow selects the first visible item and preserves the view"
            );
        }
        for (Key move : {Key::PageDown, Key::Home}) {
            key(Key::Home);
            wheel(30, 1000);
            key(move);
            require(
                selection(grid, 27, 5, 69, 6).find("model-") != std::string::npos,
                "PgDn and Home keep their existing model navigation after scrolling away"
            );
        }
        key(Key::Home);
        wheel(30, 1);
        key(Key::BackTab);
        require(
            selection(grid, 27, 5, 69, 6).find("model-0") != std::string::npos,
            "Shift-Tab section jumps bring the selection into view"
        );
        key(Key::Back);
        key(Key::Back);
        key(Key::Down);
        key(Key::Enter);
        wheel(30, 1);
        require(
            line(grid, 28, 5, 30).starts_with("Item 3") && app.focused() == Focus::Sidebar,
            "Settings wheel scrolls three rows without changing focus"
        );
        key(Key::Enter);
        key(Key::Down);
        require(
            line(grid, 28, 5, 30, true).starts_with("Item 3"),
            "Settings Down selects the first visible setting without jumping back"
        );
        key(Key::Home);
        key(Key::Enter);
        require(app.focused() == Focus::Popup, "Choice opens a picker");
        key(Key::ScrollDown);
        require(
            line(grid, 30, 7, 30).starts_with("Option 1") && app.focused() == Focus::Popup,
            "ScrollDown scrolls the open popup one row without changing focus"
        );
        key(Key::ScrollUp);
        require(line(grid, 30, 7, 30).starts_with("Option 0"), "ScrollUp scrolls the popup back");
        wheel(30, 1);
        require(line(grid, 30, 7, 30).starts_with("Option 3"), "Picker wheel scrolls three rows");
        key(Key::Down);
        require(
            line(grid, 30, 7, 30, true).starts_with("Option 3"),
            "Popup Down selects the first visible option without jumping back"
        );
        wheel(30, 1000);
        key(Key::Enter);
        require(
            last("settings.set")["params"]["value"].integer() == 3,
            "Popup scrolling leaves its selected value intact for Enter"
        );
        key(Key::Back);
        key(Key::Back);
        key(Key::End);
        key(Key::Enter);
        wheel(30, 1);
        require(
            line(grid, 28, 6, 30).starts_with("session-2") && app.focused() == Focus::Sidebar,
            "Sessions overview wheel scrolls three rows without changing focus"
        );
        key(Key::Enter);
        key(Key::Home);
        key(Key::End);
        key(Key::Enter);
        require(
            last("subagents.watch")["params"]["ids"].array().front().str() == "session-0",
            "History initially watches its visible rows"
        );
        auto pages = count("subagents.page");
        wheel(30, 1);
        require(
            line(grid, 28, 6, 30).starts_with("session-2") && app.focused() == Focus::List &&
                count("subagents.page") == pages + 1 && !last("subagents.page")["params"]["before"].null(),
            "History wheel scrolls three rows and drives before paging without moving focus"
        );
        auto check_watch = [&] {
            const auto ids = last("subagents.watch")["params"]["ids"].array();
            Json::Array visible;
            for (int y = 6; y < 15; ++y) {
                std::string title = line(grid, 28, y, 30);
                if (title.starts_with("session-")) {
                    visible.push_back(title.substr(0, title.find_first_not_of("0123456789", 8)));
                }
            }
            require(ids == visible, "Subagents watch sends exactly the rows in the scrolled view");
        };
        check_watch();
        key(Key::ScrollUp);
        require(
            line(grid, 28, 6, 30).starts_with("session-1") && app.focused() == Focus::List,
            "History ScrollUp moves the view by one row without moving the selection"
        );
        key(Key::ScrollDown);
        check_watch();
        auto check_bar = [&] {
            auto ids = last("subagents.watch")["params"]["ids"].array();
            int index = std::stoi(ids.front().str().substr(8));
            Grid expected(120, 20);
            scrollbar(expected, 116, 6, 9, scroll_thumb(9, int(sessions.size()), index, int(ids.size())));
            for (int y = 6; y < 15; ++y) {
                require(
                    grid.cells[size_t(y * 120 + 116)].glyph == expected.cells[size_t(y * 120 + 116)].glyph,
                    "History scrollbar keeps its absolute view offset across paging and eviction"
                );
            }
        };
        for (int page = 0; page < 8; ++page) {
            require(app.mouse_input({{30, 7}, MouseKind::Wheel, 1000}), "History scrolls to its loaded edge");
            draw();
            std::string anchor = line(grid, 28, 6, 30);
            pump();
            draw();
            require(line(grid, 28, 6, 30) == anchor, "Before paging and eviction retain every visible row");
            check_watch();
            check_bar();
        }
        std::string history_anchor = line(grid, 28, 6, 30);
        history_anchor.resize(history_anchor.find(' '));
        pages = count("subagents.page");
        key(Key::Up);
        require(
            line(grid, 28, 6, 30, true).starts_with(history_anchor) && count("subagents.page") == pages,
            "Up selects the first visible history row without reloading the evicted selection"
        );
        wheel(30, 1);
        history_anchor = line(grid, 28, 6, 30);
        history_anchor.resize(history_anchor.find(' '));
        key(Key::Down);
        require(
            line(grid, 28, 6, 30, true).starts_with(history_anchor),
            "History Down also selects the visible top without moving the view"
        );
        key(Key::Down);
        require(
            line(grid, 28, 7, 30, true).starts_with("session-"),
            "The next history arrow continues from the visible selection"
        );
        for (int page = 0; page < 8; ++page) {
            wheel(30, 1000);
        }
        pages = count("subagents.page");
        require(app.mouse_input({{30, 7}, MouseKind::Wheel, -1000}), "History scrolls to the top of its window");
        draw();
        std::string anchor = line(grid, 28, 7, 30);
        pump();
        draw();
        require(
            count("subagents.page") == pages + 1 && !last("subagents.page")["params"]["after"].null() &&
                line(grid, 28, 7, 30) == anchor,
            "After paging prepends newer rows while keeping the view anchored"
        );
        check_watch();
        check_bar();
        wheel(30, -1000);
        wheel(30, -1000);
        wheel(30, -1000);
        wheel(30, -1000);
        int steps = 0;
        while (last("subagents.watch")["params"]["top"].null()) {
            require(++steps < 20, "After paging eventually reaches the real history top");
            wheel(30, -1000);
        }
        wheel(30, 1);
        anchor = line(grid, 28, 6, 30);
        Json arrival = sessions.front();
        arrival["id"] = "new-arrival";
        arrival["title"] = "new-arrival";
        arrival["createdAt"] = 1000001;
        sessions.insert(sessions.begin(), arrival);
        app.receive(
            Json::object(
                {{"method", "subagents.changed"},
                 {"params", Json::object({{"now", 1000001}, {"rows", Json::Array{}}, {"newer", Json::Array{arrival}}})}}
            )
        );
        pump();
        draw();
        require(line(grid, 28, 6, 30) == anchor, "Newer arrivals do not yank a view scrolled away from the top");
        check_watch();
        key(Key::Home);
        require(
            selection(grid, 27, 6, 69, 9).find("new-arrival") != std::string::npos,
            "History Home reloads the real top and follows its selection"
        );
        key(Key::Back);
        key(Key::Back);
        key(Key::Down);
        key(Key::ScrollDown);
        require(
            app.focused() == Focus::Sidebar && line(grid, 28, 5, 20).starts_with("Version"),
            "Helper right stick scrolls its main view while the sidebar has focus"
        );
        wheel(30, 1000);
        key(Key::Enter);
        key(Key::Home);
        require(line(grid, 28, 5, 20).starts_with("Helper"), "Helper Home snaps its view back to its selection");
        key(Key::Back);
        key(Key::Up);
        grid = Grid(120, 500);
        draw();
        key(Key::Enter);
        key(Key::End);
        pages = count("subagents.page");
        key(Key::Enter);
        require(
            count("subagents.page") == pages + 2,
            "Tall history windows prefetch two pages without an eviction paging loop"
        );
        require(
            last("subagents.watch")["params"]["ids"].array().size() == 488,
            "Tall history windows watch exactly the rows below their heading"
        );
        key(Key::ScrollDown);
        require(
            last("subagents.watch")["params"]["ids"].array().size() == 489 &&
                last("subagents.watch")["params"]["ids"].array().front().str() == "new-arrival",
            "Tall history scrolls a row without evicting its visible rows or selection"
        );
    }
}
