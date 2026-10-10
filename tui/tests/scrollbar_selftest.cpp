// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/scrollbar.hpp"
#include <deque>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        std::string bar(const Grid &grid, int x, int y, int height) {
            std::string result;
            for (int row = y; row < y + height; ++row) {
                const Cell &cell = grid.cells[size_t(row * grid.width + x)];
                require(cell.fg == blue || cell.fg == dim, "Scrollbar keeps its colors");
                require(cell.bg == black, "List highlight does not enter the scrollbar column");
                require(
                    cell.glyph == " " || cell.glyph == "▘" || cell.glyph == "▖" || cell.glyph == "▌",
                    "Text does not enter the scrollbar column"
                );
                result += cell.glyph;
            }
            return result;
        }
    }

    void scrollbar_selftest() {
        ScrollThumb top = scroll_thumb(10, 40, 0, 10);
        ScrollThumb middle = scroll_thumb(10, 40, 15, 10);
        ScrollThumb bottom = scroll_thumb(10, 40, 30, 10);
        require(top.top == 0 && top.size == 5, "Thumb size is proportional at the top");
        require(middle.top == 7.5 && middle.size == 5, "Thumb position retains half-row precision");
        require(bottom.top == 15 && bottom.top + bottom.size == 20, "Thumb touches the bottom at the last visible row");
        require(scroll_thumb(10, 10000, 9999, 1).size == 1, "Thumb has a one-half-row minimum");
        require(
            scroll_thumb(10, 10, 0, 10).size == 0 && scroll_thumb(10, 3, 0, 10).size == 0 &&
                scroll_thumb(10, -1, 0, 10).size == 0,
            "Fitting and unknown content have no scrollbar"
        );
        Grid sample(3, 10);
        scrollbar(sample, 1, 0, 10, top);
        require(
            sample.cells[1].glyph == "▌" && sample.cells[7].glyph == "▘" && sample.cells[10].glyph == " ",
            "Odd half-row thumb ends with an upper quarter and leaves no track"
        );
        scrollbar(sample, 1, 0, 10, bottom);
        require(
            sample.cells[22].glyph == "▖" && sample.cells[28].glyph == "▌",
            "Odd half-row thumb starts with a lower quarter at the bottom"
        );
        Grid blank(3, 10);
        scrollbar(blank, 1, 0, 10, {});
        require(blank.cells[1].glyph == " ", "No scrollbar is drawn when content fits");
        ScrollMotion motion;
        require(motion.update(0, 0, true) == 0 && !motion.moving(0), "First thumb position is immediate");
        require(motion.update(10, 1, true) == 0 && motion.moving(1), "Thumb starts easing from its old position");
        require(
            motion.value(1.075) > 0 && motion.value(1.075) < 10 && motion.value(1.15) == 10 && !motion.moving(1.15),
            "Thumb finishes easing in 150 ms"
        );
        require(motion.update(0, 2, false) == 0 && !motion.moving(2), "Static thumb jumps immediately");

        for (bool animations : {false, true}) {
            std::deque<Json> pending;
            App app([&](const Json &request) { pending.push_back(request); }, animations);
            auto pump = [&] {
                while (!pending.empty()) {
                    Json request = pending.front();
                    pending.pop_front();
                    Json result = Json::object({{"ok", true}});
                    if (request["method"].str() == "hello") {
                        result["protocol"] = 1;
                    } else if (request["method"].str() == "providers.list") {
                        Json::Array providers;
                        for (int index = 0; index < 30; ++index) {
                            providers.push_back(
                                Json::object(
                                    {{"id", "provider-" + std::to_string(index)},
                                     {"displayName", std::string(100, 'P')},
                                     {"enabled", true},
                                     {"detected", true}}
                                )
                            );
                        }
                        result["providers"] = providers;
                    } else if (request["method"].str() == "models.list") {
                        Json::Array models;
                        for (int index = 0; index < 60; ++index) {
                            models.push_back(
                                Json::object(
                                    {{"model", std::string(100, 'M') + std::to_string(index)},
                                     {"enabled", false},
                                     {"offered", true}}
                                )
                            );
                        }
                        result["models"] = models;
                    } else if (request["method"].str() == "settings.get") {
                        Json::Array items, options, values;
                        for (int index = 0; index < 40; ++index) {
                            options.push_back(Json::object({{"label", std::string(100, 'C')}, {"value", index}}));
                            values.push_back(std::string(100, 'L'));
                        }
                        for (int index = 0; index < 60; ++index) {
                            items.push_back(
                                Json::object(
                                    {{"key", "item-" + std::to_string(index)},
                                     {"label", std::string(100, 'S')},
                                     {"type", index == 0 ? "choice" : "list"},
                                     {"options", options},
                                     {"value", index == 0 ? Json(0) : Json(values)}}
                                )
                            );
                        }
                        result["sections"] =
                            Json::Array{Json::object({{"id", "test"}, {"title", "Settings"}, {"items", items}})};
                    } else if (request["method"].str() == "subagents.overview") {
                        Json::Array sessions;
                        for (int index = 0; index < 60; ++index) {
                            sessions.push_back(
                                Json::object(
                                    {{"id", std::to_string(index)},
                                     {"title", std::string(100, 'N')},
                                     {"model", std::string(100, 'M')},
                                     {"createdAt", 100000 - index},
                                     {"running", true}}
                                )
                            );
                        }
                        result = Json::object({{"now", 100000}, {"running", sessions}, {"recent", Json::Array{}}});
                    } else if (request["method"].str() == "status.get") {
                        Json::Array providers;
                        for (int index = 0; index < 30; ++index) {
                            providers.push_back(
                                Json::object(
                                    {{"id", "provider-" + std::to_string(index)},
                                     {"location", std::string(100, 'H')},
                                     {"models", 12}}
                                )
                            );
                        }
                        result["providers"] = providers;
                    }
                    app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
                }
            };
            auto key = [&](Key key) {
                app.input({key, {}});
                pump();
            };
            Grid grid(100, 20);
            app.start();
            pump();
            key(Key::Enter);
            app.step(0.5);
            pump();
            app.step(0.5);
            key(Key::Enter);
            app.render(grid);
            require(!bar(grid, 20, 5, 10).empty(), "Overflowing Providers sidebar shows a scrollbar");
            std::string initial = bar(grid, 96, 5, 6);
            key(Key::PageDown);
            app.render(grid);
            if (animations) {
                require(
                    app.needs_tick() && app.tick_timeout_ms() <= 16,
                    "Moving Models thumb keeps the event loop awake"
                );
                require(
                    bar(grid, 96, 5, 6) == initial && app.step(0.075),
                    "Models thumb starts at its old position and requests redraws"
                );
                app.render(grid);
                require(app.step(0.075), "Models requests the final animation frame");
                app.render(grid);
                require(!app.needs_tick(), "Models stops timed work when the thumb settles");
            }
            require(bar(grid, 96, 5, 6) != initial, "Models Page Down moves the thumb");
            key(Key::End);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            std::string end = bar(grid, 96, 5, 6);
            require(end.ends_with("▖") || end.ends_with("▌"), "Models End places the thumb at the bottom");
            key(Key::Down);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            require(bar(grid, 96, 5, 6) == initial, "Models wrap-around returns the thumb to the top");
            key(Key::End);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            key(Key::Home);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            require(bar(grid, 96, 5, 6) == initial, "Models Home returns the thumb to the top");
            key(Key::PageDown);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            key(Key::PageUp);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            require(bar(grid, 96, 5, 6) == initial, "Models Page Up returns the thumb to the top");
            require(app.mouse_input({{30, 7}, MouseKind::Wheel, 1}), "Models wheel scrolls its view");
            app.render(grid);
            if (animations) {
                require(
                    bar(grid, 96, 5, 6) == initial && app.needs_tick(),
                    "Wheel thumb eases from the previous view offset"
                );
            }
            app.step(0.2);
            app.render(grid);
            require(bar(grid, 96, 5, 6) != initial, "Scrollbar follows the view with the selection unchanged");
            key(Key::Home);
            app.render(grid);
            app.step(0.2);
            app.render(grid);
            if (!animations) {
                key(Key::Back);
                key(Key::Back);
                key(Key::Down);
                key(Key::Enter);
                app.render(grid);
                require(!bar(grid, 96, 5, 9).empty(), "Settings list shows a scrollbar without text overlap");
                key(Key::Enter);
                key(Key::Enter);
                app.render(grid);
                std::string choice_top = bar(grid, 80, 7, 7);
                key(Key::End);
                app.render(grid);
                require(bar(grid, 80, 7, 7) != choice_top, "Choice popup scrollbar follows End without text overlap");
                key(Key::Back);
                key(Key::Down);
                key(Key::Enter);
                app.render(grid);
                require(!bar(grid, 80, 7, 7).empty(), "List popup shows a scrollbar without text overlap");
                key(Key::Back);
                key(Key::Back);
                key(Key::Back);
                key(Key::End);
                key(Key::Enter);
                app.render(grid);
                key(Key::Enter);
                std::string sessions_top = bar(grid, 96, 6, 9);
                key(Key::End);
                app.render(grid);
                require(
                    bar(grid, 96, 6, 9) != sessions_top,
                    "Sessions overview scrollbar follows End without text overlap"
                );
                key(Key::Down);
                app.render(grid);
                require(
                    bar(grid, 96, 6, 9) == sessions_top,
                    "Sessions overview scrollbar returns to the top on wrap-around"
                );
                key(Key::Back);
                key(Key::Down);
                app.render(grid);
                key(Key::Enter);
                std::string helper_top = bar(grid, 96, 5, 10);
                key(Key::End);
                app.render(grid);
                require(bar(grid, 96, 5, 10) != helper_top, "Helper scrollbar follows End without text overlap");
            }
        }
    }
}
