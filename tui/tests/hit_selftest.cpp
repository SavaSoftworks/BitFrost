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

        std::string selected(const Grid &grid) {
            std::string text;
            for (const Cell &cell : grid.cells) {
                text += cell.fg == black && cell.bg != black ? cell.glyph : " ";
            }
            return text;
        }
    }

    void hit_selftest() {
        HitMap map;
        map.clear(120, 40);
        map.add({3, 5, 20, 1}, HitKind::Provider, 2);
        map.add({27, 7, 89, 1}, HitKind::Model, 1);
        map.scroll({3, 5, 20, 20}, HitKind::Provider);
        map.scroll({27, 5, 89, 17}, HitKind::Model);
        require(
            map.at({4, 5})->kind == HitKind::Provider && map.at({30, 7})->index == 1,
            "Rectangles map to their registered widget actions"
        );
        require(
            !map.at({30, 6}) && map.at({30, 6}, true)->kind == HitKind::Model,
            "Header and blank rows ignore clicks but permit scrolling the containing list"
        );
        require(
            map.at({4, 12}, true)->kind == HitKind::Provider && !map.at({90, 25}, true),
            "Wheel routes by pointer location and ignores the stats panel"
        );
        map.modal({39, 4, 42, 7});
        map.add({40, 7, 40, 1}, HitKind::ModelAction);
        require(
            map.at({4, 5})->kind == HitKind::Back && !map.at({4, 5}, true) &&
                map.at({45, 7})->kind == HitKind::ModelAction,
            "Popup blocks underlying targets and outside clicks close it"
        );
        map.clear(120, 40);
        require(!map.at({4, 5}), "Each frame replaces the previous hit map");
        map.add({27, 7, 89, 1}, HitKind::Model, 1);
        map.shift(3);
        require(!map.at({28, 7}) && map.at({30, 7}), "Hit rectangles follow the page slide");

        std::deque<Json> pending;
        std::vector<Json> sent;
        App app(
            [&](const Json &request) {
                pending.push_back(request);
                sent.push_back(request);
            },
            false
        );
        Json::Array models;
        for (int index = 0; index < 25; ++index) {
            models.push_back(
                Json::object({{"model", "model-" + std::to_string(index)}, {"enabled", true}, {"offered", true}})
            );
        }
        Json settings = Json::parse(R"({"revision":"test","sections":[
        {"id":"general","title":"General","items":[
            {"key":"flag","label":"Flag","type":"bool","value":true},
            {"key":"text","label":"Text","type":"text","value":"old"},
            {"key":"choice","label":"Choice","type":"choice","value":"a","options":[
                {"label":"A","value":"a"},{"label":"B","value":"b"}]},
            {"key":"list","label":"List","type":"list","value":["one"]}]},
        {"id":"other","title":"Other","items":[
            {"key":"other","label":"Other flag","type":"bool","value":false}]}]})");
        Json agent = Json::object(
            {{"id", "one"}, {"title", "Test agent"}, {"createdAt", 1}, {"running", true}, {"model", "test"}}
        );
        auto pump = [&] {
            while (!pending.empty()) {
                Json request = pending.front();
                pending.pop_front();
                std::string method = request["method"].str();
                Json result = Json::object({{"revision", "test"}});
                if (method == "providers.list") {
                    result["providers"] = Json::Array{
                        Json::object(
                            {{"id", "codex"}, {"displayName", "Codex"}, {"enabled", true}, {"detected", true}}
                        ),
                        Json::object(
                            {{"id", "omp"}, {"displayName", "Oh My Pi"}, {"enabled", true}, {"detected", true}}
                        )
                    };
                } else if (method == "models.list") {
                    result["models"] = models;
                } else if (method == "settings.get") {
                    result = settings;
                } else if (method == "subagents.overview") {
                    result =
                        Json::object({{"now", 100000}, {"running", Json::Array{agent}}, {"recent", Json::Array{}}});
                } else if (method == "subagents.page") {
                    result = Json::object({{"now", 100000}, {"rows", Json::Array{agent}}, {"more", false}});
                } else if (method == "status.get") {
                    result = Json::object({{"pid", 4242}});
                }
                app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
            }
        };
        Grid grid(120, 40);
        auto click = [&](int x, int y) {
            bool handled = app.mouse_input({{x, y}, MouseKind::Click, 0});
            pump();
            app.render(grid);
            return handled;
        };
        auto wheel = [&](int x, int y, int delta) {
            bool handled = app.mouse_input({{x, y}, MouseKind::Wheel, delta});
            pump();
            app.render(grid);
            return handled;
        };
        auto last_write = [&](std::string_view method) {
            auto request = std::find_if(sent.rbegin(), sent.rend(), [&](const Json &entry) {
                return entry["method"].str() == method;
            });
            return request == sent.rend() ? Json{} : *request;
        };
        app.start();
        pump();
        app.render(grid);
        require(click(56, 24) && app.page() == Page::Models, "Home click chooses its menu item");
        require(!click(5, 4) && !wheel(5, 4, 1), "Sidebar branding has no menu or scroll hit targets");
        require(!click(30, 5) && app.focused() == Focus::Sidebar, "Model header click is ignored");
        require(
            click(5, 10) && app.focused() == Focus::Sidebar &&
                last_write("models.list")["params"]["provider"].str() == "omp",
            "Provider click focuses sidebar and loads its models"
        );
        require(
            wheel(30, 7, 1) && app.focused() == Focus::Sidebar && grid.cells[5 * 120 + 28].glyph == "m",
            "Wheel scrolls the model view while leaving sidebar focus alone"
        );
        wheel(30, 7, -100);
        wheel(30, 7, -1);
        require(grid.cells[5 * 120 + 28].glyph == "E", "Wheel clamps at the first row");
        wheel(30, 7, 100);
        wheel(30, 7, 1);
        require(grid.cells[5 * 120 + 28].glyph == "m", "Wheel clamps at the last view");
        app.input({Key::Enter, {}});
        app.input({Key::Home, {}});
        app.input({Key::BackTab, {}});
        for (int row = 0; row < 15; ++row) {
            app.input({Key::Down, {}});
        }
        app.render(grid);
        require(click(30, 5) && app.focused() == Focus::List, "Click can reveal a section header above its row");
        require(
            click(30, 5) && app.focused() == Focus::Popup,
            "Double click activates the original row even when selection shifts it down"
        );
        click(2, 2);
        require(wheel(5, 9, -1) && app.focused() == Focus::List, "Wheel over provider list leaves focus alone");
        app.input({Key::Back, {}});
        app.input({Key::Home, {}});
        app.render(grid);
        require(!wheel(90, 23, 1), "Wheel over stats never changes tabs");
        require(selected(grid).find("Today") != std::string::npos, "Stats default to Today");
        constexpr std::string_view labels[]{"Today", "7 days", "30 days", "All time"};
        for (int tab = 0; tab < 4; ++tab) {
            require(
                click(65 + tab * 13, 23) && selected(grid).find(labels[tab]) != std::string::npos,
                "All four full-width tab hit rectangles switch to their displayed period"
            );
            require(
                !wheel(65 + tab * 13, 23, 1) && selected(grid).find(labels[tab]) != std::string::npos,
                "Wheel over any stats tab leaves that period selected"
            );
        }
        constexpr std::string_view narrow_labels[]{"Today", "7d", "30d", "All"};
        for (int height : {40, 24}) {
            grid = Grid(80, height);
            app.render(grid);
            int x_start = height == 40 ? 48 : 49;
            int y = height == 40 ? 23 : 17;
            for (int tab = 0; tab < 4; ++tab) {
                require(
                    click(x_start + tab * 7, y) && selected(grid).find(narrow_labels[tab]) != std::string::npos,
                    "Narrow tabs remain fully readable and clickable with their active mosaic"
                );
                for (int other = 0; other < 4; ++other) {
                    std::string shown;
                    for (int x = x_start + other * 7; x < x_start + other * 7 + int(narrow_labels[other].size()); ++x) {
                        shown += grid.cells[y * 80 + x].glyph;
                    }
                    require(shown == narrow_labels[other], "Narrow active highlight preserves every tab label");
                }
            }
        }
        grid = Grid(120, 40);
        app.render(grid);
        require(click(30, 7) && app.focused() == Focus::List, "First click selects an unselected model row");
        require(click(30, 7) && app.focused() == Focus::Popup, "Double click selects and activates a model");
        require(
            click(45, 7) && last_write("models.set")["params"]["enabled"] == Json(false),
            "Model popup action click sends the same write as Enter"
        );
        app.input({Key::Enter, {}});
        app.render(grid);
        require(click(2, 2) && app.focused() == Focus::List, "Click outside model popup closes it");
        app.mouse(MousePosition{5, 10});
        app.render(grid);
        require(
            grid.cells[10 * 120 + 4].fg == Color{210, 225, 240},
            "Hover brightens an inactive label without a mosaic"
        );

        app.input({Key::Back, {}});
        app.input({Key::Back, {}});
        app.render(grid);
        click(56, 26);
        require(app.page() == Page::Settings, "Settings opens from a home click");
        require(
            click(5, 10) && app.focused() == Focus::Sidebar && selected(grid).find("Other") != std::string::npos,
            "Settings section click changes selection and sidebar focus"
        );
        click(5, 9);
        click(30, 5);
        require(last_write("settings.set")["params"]["key"].str() == "flag", "Selected bool click activates it");
        auto bool_writes = std::count_if(sent.begin(), sent.end(), [](const Json &request) {
            return request["method"].str() == "settings.set";
        });
        click(30, 5);
        require(
            std::count_if(
                sent.begin(),
                sent.end(),
                [](const Json &request) { return request["method"].str() == "settings.set"; }
            ) == bool_writes,
            "Double click on a selected bool activates once instead of toggling twice"
        );
        click(30, 6);
        click(30, 6);
        require(app.editing(), "Double click on a text row opens the editor");
        click(29, 6);
        app.input({Key::Text, "X"});
        click(5, 37);
        require(app.controls_shown() && app.editing(), "The persistent hint opens Controls over an editor");
        app.input({Key::Back, {}});
        app.input({Key::Enter, {}});
        pump();
        app.render(grid);
        require(last_write("settings.set")["params"]["value"].str() == "oXld", "Field click moves the caret");
        click(30, 7);
        click(30, 7);
        require(app.focused() == Focus::Popup, "Choice row opens a picker");
        require(wheel(30, 19, 1), "Wheel scrolls a popup picker");
        wheel(30, 19, 100);
        wheel(30, 16, 1);
        require(selected(grid).find("A") != std::string::npos, "Popup wheel leaves its selected option alone");
        require(!wheel(5, 9, 1) && app.focused() == Focus::Popup, "Popup prevents wheel from reaching the sidebar");
        click(30, 20);
        require(last_write("settings.set")["params"]["value"].str() == "b", "Picker action click chooses its value");
        click(30, 8);
        click(30, 8);
        require(app.focused() == Focus::Popup, "List item opens its list editor popup");
        require(click(30, 20) && app.editing(), "Click Add item opens the popup text field");
        require(
            click(2, 2) && !app.editing() && app.focused() == Focus::Popup,
            "Outside popup editor click cancels the editor like Escape"
        );
        click(2, 3);
        require(app.focused() == Focus::List, "Outside picker click closes the picker");

        app.input({Key::Back, {}});
        app.input({Key::Back, {}});
        app.render(grid);
        click(56, 28);
        require(app.page() == Page::Status, "Status opens from a home click");
        require(!click(30, 6), "Subagent section header ignores clicks");
        require(!click(30, 8), "Subagent blank separator ignores clicks");
        require(
            wheel(30, 7, 1) && app.focused() == Focus::Sidebar && selected(grid).find("Sessions") != std::string::npos,
            "Subagent wheel leaves the selection and sidebar focus alone"
        );
        click(30, 11);
        require(
            click(30, 11) && selected(grid).find("Test agent") != std::string::npos,
            "Selected See all click opens subagent history"
        );
        require(wheel(30, 7, -1), "History list supports clamped view scrolling");
        app.input({Key::Back, {}});
        app.render(grid);
        click(5, 10);
        require(
            app.focused() == Focus::Sidebar && last_write("status.get").object().size() > 0,
            "Status section click loads Helper and focuses the sidebar"
        );
        models = Json::parse(R"([
            {"model":"alpha/one","enabled":true,"offered":true},
            {"model":"beta/two","enabled":true,"offered":true},
            {"model":"alpha/three","enabled":true,"offered":true},
            {"model":"plain","enabled":true,"offered":true}
        ])")
                     .array();
        app.input({Key::Back, {}});
        app.input({Key::Home, {}});
        app.input({Key::Enter, {}});
        pump();
        app.render(grid);
        require(
            grid.cells[6 * 120 + 28].fg == white && grid.cells[7 * 120 + 30].fg == blue &&
                grid.cells[7 * 120 + 28].glyph == " " && grid.cells[7 * 120 + 29].glyph == " " &&
                grid.cells[7 * 120 + 30].glyph == "o",
            "Category headings are white and grouped labels are blue with two spaces of indentation"
        );
        require(
            !click(30, 6) && app.focused() == Focus::Sidebar,
            "Category heading click leaves the sidebar focused and never activates a model"
        );
        require(
            click(30, 8) && selected(grid).find("three") != std::string::npos &&
                selected(grid).find("alpha/") == std::string::npos,
            "Grouped model click selects its stripped label and keeps its full id for actions"
        );
        std::string selected_before = selected(grid);
        for (int y : {5, 6, 9, 10, 12, 14, 15, 16, 19, 20}) {
            require(
                !click(30, y) && selected(grid) == selected_before && app.focused() == Focus::List,
                "Every visible section, category and blank row ignores clicks in a grouped list"
            );
        }
        app.input({Key::BackTab, {}});
        app.render(grid);
        require(
            grid.cells[12 * 120 + 28].glyph == "A" && grid.cells[13 * 120 + 28].glyph == "a" &&
                selected(grid).find("one") != std::string::npos,
            "Grouped Tab jump displays All models above its category and first selected model"
        );
        require(
            !click(30, 12) && !click(30, 13) && app.focused() == Focus::List,
            "All models and category headings remain non-clickable after a section jump"
        );
        app.input({Key::BackTab, {}});
        app.render(grid);
        require(
            grid.cells[5 * 120 + 28].glyph == "E" && selected(grid).find("one") != std::string::npos,
            "Grouped Shift-Tab returns to Enabled"
        );
        app.input({Key::Up, {}});
        app.render(grid);
        require(
            selected(grid).find("plain") != std::string::npos,
            "Grouped Up wraps across sections to the last ungrouped model"
        );
        app.input({Key::Down, {}});
        app.render(grid);
        require(
            selected(grid).find("one") != std::string::npos,
            "Grouped Down wraps back across categories to the first Enabled model"
        );
        auto visible_top = [&] {
            return grid.cells[5 * 120 + 28].glyph == "E" && grid.cells[6 * 120 + 28].glyph == "a" &&
                   grid.cells[7 * 120 + 30].glyph == "o";
        };
        app.input({Key::End, {}});
        app.input({Key::Home, {}});
        app.render(grid);
        require(visible_top(), "Grouped End then Home renders Enabled and the first category at the top");
        wheel(30, 7, 1000);
        wheel(30, 7, -1000);
        require(visible_top(), "Wheel from All models back to the first model restores both top headings");
        wheel(30, 7, -1);
        require(visible_top(), "Wheel clamps at the grouped top without hiding the headings");
    }
}
