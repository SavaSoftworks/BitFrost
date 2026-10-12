// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/format.hpp"
#include <deque>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }
    }
    void settings_selftest() {
        Json setting = Json::parse(R"({"type":"bool","value":true,"states":["Disabled","Enabled"]})");
        require(setting_value(setting) == "Enabled", "Bool uses its enabled state text");
        setting["value"] = false;
        require(setting_value(setting) == "Disabled", "Bool uses its disabled state text");
        setting["states"] = Json::Array{};
        require(setting_value(setting) == "Off", "Bool without states uses Off");
        setting["value"] = true;
        require(setting_value(setting) == "On", "Bool without states uses On");
        require(
            setting_value(Json::parse(R"({"type":"number","value":30,"unit":"days"})")) == "30 days",
            "Number displays its unit"
        );
        require(
            setting_value(Json::parse(R"({"type":"list","value":["one","two"]})")) == "one, two" &&
                setting_value(Json::parse(R"({"type":"list","value":[]})")) == "none",
            "Lists show their joined entries or none"
        );
        setting = Json::parse(R"({"type":"text","label":"Location","value":""})");
        require(setting_value(setting) == "automatic", "Location is automatic when the helper supplied no found field");
        setting["found"] = nullptr;
        require(setting_value(setting) == "not found", "Null found location means not found");
        setting["found"] = "/usr/bin/codex";
        require(setting_value(setting) == "/usr/bin/codex (found automatically)", "Found location names its source");
        setting["value"] = "/opt/codex";
        require(setting_value(setting) == "/opt/codex (set by you)", "Explicit location overrides found location");

        GroupedList rows;
        rows.reset({"Alpha", "Beta", "Alpha", ""});
        require(
            rows.rows().size() == 8 && rows.rows()[0].heading == "Alpha" && rows.rows()[3].heading.empty() &&
                rows.rows()[4].heading == "Beta" && rows.rows()[6].heading.empty(),
            "Groups follow first appearance with headings and blank separators"
        );
        int selection = 0;
        for (int item : {2, 1, 3, 0}) {
            rows.input(selection, Key::Down, 3);
            require(selection == item, "Down skips grouped headings and wraps in display order");
        }
        for (int item : {3, 1, 2, 0}) {
            rows.input(selection, Key::Up, 3);
            require(selection == item, "Up skips grouped headings and wraps in display order");
        }
        rows.input(selection, Key::PageDown, 2);
        require(selection == 1, "Page Down skips a blank and the next heading");
        rows.input(selection, Key::PageUp, 1);
        require(selection == 2, "Page Up skips a heading and blank");
        rows.input(selection, Key::End, 3);
        require(selection == 3, "End selects the last grouped item");
        rows.input(selection, Key::Home, 3);
        require(
            selection == 0 && rows.first_row(selection, 3) == 0,
            "Home restores the first group heading at row zero"
        );
        rows.scroll(1000, 3);
        require(selection == 0 && rows.first_row(selection, 3) == 5, "Grouped scrolling clamps at the last view");
        rows.scroll(-1000, 3);
        require(selection == 0 && rows.first_row(selection, 3) == 0, "Grouped scrolling restores row zero");

        Json fixture = Json::parse(R"({"revision":"test","sections":[{"id":"general","title":"General","items":[
            {"key":"allowed","group":"Paths","label":"Allowed","type":"list","value":["one","two"]},
            {"key":"flag","group":"Switch","label":"Status","type":"bool","value":true,"states":["Disabled","Enabled"]},
            {"key":"days","group":"Retention","label":"Raw events","type":"number","value":30,"unit":"days"},
            {"key":"location","group":"Paths","label":"Location","type":"text","value":"","found":"/usr/bin/codex"}
        ]}]})");
        std::deque<Json> pending;
        Json written;
        App app([&](const Json &request) { pending.push_back(request); }, false);
        auto pump = [&] {
            while (!pending.empty()) {
                Json request = pending.front();
                pending.pop_front();
                Json result = Json::object({{"revision", "test"}});
                if (request["method"].str() == "settings.get") {
                    result = fixture;
                }
                if (request["method"].str() == "settings.set") {
                    written = request["params"];
                    auto &sections = std::get<Json::Array>(fixture["sections"].value);
                    for (Json &item : std::get<Json::Array>(sections[0]["items"].value)) {
                        if (item["key"] == written["key"]) {
                            item["value"] = written["value"];
                        }
                    }
                }
                app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
            }
        };
        app.start();
        pump();
        app.input({Key::Down, {}});
        app.input({Key::Enter, {}});
        pump();
        Grid grid(120, 40);
        app.render(grid);
        require(
            grid.cells[5 * 120 + 28].glyph == "P" && grid.cells[5 * 120 + 28].fg == white &&
                grid.cells[6 * 120 + 28].fg == blue && grid.cells[6 * 120 + 37].fg == dim,
            "Settings uses white group headings, blue captions and dim values"
        );
        require(
            grid.cells[8 * 120 + 28].glyph == " " && grid.cells[9 * 120 + 28].glyph == "S",
            "Settings puts a blank line between groups"
        );
        require(
            !app.mouse_input({{30, 5}, MouseKind::Click, 0}) && !app.mouse_input({{30, 8}, MouseKind::Click, 0}) &&
                app.focused() == Focus::Sidebar,
            "Group headings and blank lines ignore clicks and do not focus the settings list"
        );
        app.mouse_input({{30, 10}, MouseKind::Click, 0});
        require(
            app.focused() == Focus::List && written.null(),
            "First click selects a grouped setting without editing"
        );
        app.render(grid);
        app.mouse_input({{30, 10}, MouseKind::Click, 0});
        pump();
        require(written["key"].str() == "flag" && !written["value"].boolean(), "Selected grouped bool click activates");
        app.render(grid);
        app.mouse_input({{30, 7}, MouseKind::Wheel, -1});
        app.render(grid);
        app.input({Key::Up, {}});
        app.input({Key::Enter, {}});
        require(app.editing(), "Up selects Location after wheel leaves the selected Status setting alone");
        app.input({Key::Text, "/opt/custom"});
        app.input({Key::Enter, {}});
        pump();
        require(
            written["key"].str() == "location" && written["value"].str() == "/opt/custom",
            "Grouped editor retains the original setting key"
        );
        auto selected_cells = [&] {
            std::string text;
            for (const Cell &cell : grid.cells) {
                text += cell.fg == black && cell.bg != black ? cell.glyph : " ";
            }
            return text;
        };
        app.input({Key::End, {}});
        app.render(grid);
        std::string selected_before = selected_cells(), message_before = app.status();
        auto &items = std::get<Json::Array>(std::get<Json::Array>(fixture["sections"].value)[0]["items"].value);
        items[3]["found"] = "/opt/detected/codex";
        items[3]["value"] = "";
        app.receive(Json::object({{"method", "settings.updated"}, {"params", Json::Object{}}}));
        require(
            pending.size() == 1 && pending.front()["method"].str() == "settings.get",
            "Settings notification quietly requests fresh data"
        );
        pump();
        app.render(grid);
        require(
            selected_cells() == selected_before && app.status() == message_before && app.focused() == Focus::List,
            "Settings refresh preserves selection, scroll and status"
        );
        std::string refreshed;
        for (const Cell &cell : grid.cells) {
            refreshed += cell.glyph;
        }
        require(
            refreshed.find("/opt/detected/codex") != std::string::npos,
            "Late Settings refresh shows the detected location"
        );
        app.receive(Json::object({{"method", "settings.updated"}, {"params", Json::Object{}}}));
        Json failed_refresh = pending.front();
        pending.pop_front();
        app.receive(Json::object({{"id", failed_refresh["id"]}, {"error", Json::object({{"message", "offline"}})}}));
        require(app.status() == message_before, "Quiet Settings refresh errors leave the status bar alone");
        app.input({Key::Back, {}});
        app.input({Key::Back, {}});
        app.receive(Json::object({{"method", "settings.updated"}, {"params", Json::Object{}}}));
        require(pending.empty(), "Settings notifications are ignored outside Settings");

        fixture = Json::parse(R"({"revision":"test","sections":[
            {"id":"first","title":"First","items":[
                {"key":"show","label":"Show extra","type":"bool","value":false,"group":"General"},
                {"key":"extra","label":"Extra option","type":"text","value":"visible","group":"General",
                 "visibleWhen":{"key":"show","equals":true}}
            ]},
            {"id":"second","title":"Second","items":[
                {"key":"other","label":"Other value","type":"text","value":"second","group":"Other"}
            ]}
        ]})");
        app.input({Key::Enter, {}});
        pump();
        auto screen_text = [&] {
            std::string value;
            for (const Cell &cell : grid.cells) {
                value += cell.glyph;
            }
            return value;
        };
        app.render(grid);
        require(screen_text().find("Extra option") == std::string::npos, "Initially hidden settings are absent");
        app.input({Key::Enter, {}});
        app.input({Key::Enter, {}});
        pump();
        app.render(grid);
        require(
            screen_text().find("Extra option") != std::string::npos,
            "Saving a visibility condition refreshes cached rows"
        );
        app.input({Key::Back, {}});
        app.input({Key::Down, {}});
        app.render(grid);
        require(
            screen_text().find("Other value") != std::string::npos &&
                screen_text().find("Extra option") == std::string::npos,
            "Keyboard section changes refresh cached settings"
        );
        int first_section_row = -1;
        for (int y = 0; y < grid.height; ++y) {
            std::string row;
            for (int x = 0; x < 26; ++x) {
                row += grid.cells[size_t(y * grid.width + x)].glyph;
            }
            if (row.find("First") != std::string::npos) {
                first_section_row = y;
            }
        }
        require(first_section_row >= 0, "First section is visible in the sidebar");
        app.mouse_input({{4, first_section_row}, MouseKind::Click, 0});
        app.render(grid);
        require(
            screen_text().find("Extra option") != std::string::npos,
            "Mouse section changes refresh cached settings"
        );
        std::get<Json::Array>(std::get<Json::Array>(fixture["sections"].value)[0]["items"].value)[0]["value"] = false;
        app.receive(Json::object({{"method", "settings.updated"}, {"params", Json::Object{}}}));
        pump();
        app.render(grid);
        require(
            screen_text().find("Extra option") == std::string::npos,
            "External settings refresh invalidates cached visibility"
        );
    }
}
