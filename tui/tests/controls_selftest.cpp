// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include <deque>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        std::string line(const Grid &grid, int y) {
            std::string result;
            for (int x = 0; x < grid.width; ++x) {
                result += grid.cells[size_t(y * grid.width + x)].glyph;
            }
            return result;
        }

        std::string text(const Grid &grid) {
            std::string result;
            for (int y = 0; y < grid.height; ++y) {
                result += line(grid, y) + '\n';
            }
            return result;
        }

        std::pair<int, int> locate(const Grid &grid, std::string_view label) {
            for (int y = 0; y < grid.height; ++y) {
                std::string row = line(grid, y);
                auto position = row.find(label);
                if (position != std::string::npos) {
                    return {text_width(row.substr(0, position)), y};
                }
            }
            return {-1, -1};
        }
    }

    void controls_selftest() {
        std::deque<Json> pending;
        int writes = 0;
        App app([&](const Json &request) { pending.push_back(request); }, false);
        Grid grid(120, 40);
        auto pump = [&] {
            while (!pending.empty()) {
                Json request = pending.front();
                pending.pop_front();
                Json result = Json::object({{"revision", "test"}});
                std::string method = request["method"].str();
                if (method == "providers.list") {
                    result["providers"] =
                        Json::parse(R"([{"id":"test","displayName":"Test","detected":true,"enabled":true}])");
                } else if (method == "models.list") {
                    result["models"] = Json::parse(R"([{"model":"model-one","enabled":true,"offered":true}])");
                } else if (method == "settings.get") {
                    result["sections"] = Json::parse(
                        R"([{"id":"test","title":"Test","items":[{"key":"choice","label":"Model","type":"choice","value":"a","options":[{"label":"Option A","value":"a"},{"label":"Option B","value":"b"}]}]}])"
                    );
                } else if (method == "models.set" || method == "settings.set") {
                    ++writes;
                }
                app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
            }
        };
        auto key = [&](Key key) {
            app.input({key, {}});
            pump();
            app.render(grid);
        };
        app.start();
        pump();
        app.render(grid);
        require(
            line(grid, 37).find("[Tab] - Controls") != std::string::npos &&
                line(grid, 37).find("WASD") == std::string::npos,
            "Home shows only the persistent Controls hint"
        );
        auto nintendo = identify_gamepad("Pro Controller", 0x057e);
        require(
            app.set_controller(nintendo) && !app.set_controller(nintendo),
            "Controller metadata only redraws on change"
        );
        key(Key::Tab);
        require(
            app.controls_shown() && text(grid).find("Nintendo Switch Pro controller connected") != std::string::npos &&
                line(grid, 37).find("[Tab/L] - Controls") != std::string::npos,
            "Tab opens Controls with the connected Nintendo controller and L hint"
        );
        const auto [header_x, header_y] = locate(grid, "Control");
        const std::string heading = "Keyboard & Mouse • Gamepad";
        const auto [mapping_header_x, mapping_header_y] = locate(grid, heading);
        const auto [action_x, action_y] = locate(grid, "Navigation");
        const std::string navigation = "WASD, Arrows • D-pad/L-Stick";
        const auto [mapping_x, mapping_y] = locate(grid, navigation);
        require(
            header_x >= 0 && mapping_header_x >= 0 && header_y == mapping_header_y && header_x == action_x &&
                action_y == header_y + 2 && action_y == mapping_y &&
                mapping_header_x + text_width(heading) == mapping_x + text_width(navigation),
            "Column headers align with the first action and right-aligned mappings"
        );
        require(
            grid.cells[size_t(header_y * grid.width + header_x)].fg == dim &&
                grid.cells[size_t(mapping_header_y * grid.width + mapping_header_x)].fg == dim &&
                text(grid).find("Close controls") == std::string::npos &&
                line(grid, action_y + 1).find("Confirm/Select") != std::string::npos &&
                line(grid, action_y + 1).find("Enter/E • A") != std::string::npos &&
                line(grid, action_y + 2).find("Back/Cancel") != std::string::npos &&
                line(grid, action_y + 2).find("Esc/Q • B") != std::string::npos,
            "Grey column headers precede Navigation, Confirm/Select and Back/Cancel without a redundant close row"
        );
        key(Key::Enter);
        require(app.page() == Page::Home && writes == 0, "Confirm in Controls does not activate the page underneath");
        app.set_controller(identify_gamepad("DualSense", 0x054c));
        app.render(grid);
        require(
            text(grid).find("[Tab/L1] - Controls") != std::string::npos &&
                text(grid).find("Enter/E • Cross") != std::string::npos,
            "Controller changes refresh both the hint and the mappings"
        );
        app.set_controller(identify_gamepad("Xbox Wireless Controller", 0x045e));
        app.render(grid);
        require(text(grid).find("[Tab/LB] - Controls") != std::string::npos, "Xbox uses LB in the persistent hint");
        app.set_controller(std::nullopt);
        app.render(grid);
        require(
            text(grid).find("connected") == std::string::npos &&
                text(grid).find("[Tab] - Controls") != std::string::npos &&
                text(grid).find("Keyboard & Mouse") != std::string::npos &&
                text(grid).find(" • ") == std::string::npos && text(grid).find("D-pad") == std::string::npos,
            "Disconnecting removes the controller name and mappings"
        );
        key(Key::Controls);
        require(!app.controls_shown(), "The shoulder action closes Controls too");
        key(Key::Enter);
        key(Key::Tab);
        const auto [nav_x, nav_y] = locate(grid, "Navigation");
        require(
            nav_x >= 0 && line(grid, nav_y + 1).find("Confirm/Select") != std::string::npos &&
                line(grid, nav_y + 2).find("Back/Cancel") != std::string::npos &&
                line(grid, nav_y + 3).find("Scroll") != std::string::npos &&
                line(grid, nav_y + 3).find("Mouse wheel") != std::string::npos &&
                line(grid, nav_y + 4).find("Page") != std::string::npos &&
                line(grid, nav_y + 4).find("PgUp/PgDn") != std::string::npos,
            "Subpage controls put Scroll and Page immediately after Back/Cancel"
        );
        app.set_controller(nintendo);
        app.render(grid);
        require(
            text(grid).find("Keyboard & Mouse • Gamepad") != std::string::npos &&
                text(grid).find("Mouse wheel • R-Stick") != std::string::npos &&
                text(grid).find("Nintendo Switch Pro controller connected") != std::string::npos,
            "Connecting a controller while Controls is open updates its header, mappings and footer"
        );
        app.set_controller(std::nullopt);
        key(Key::Back);
        key(Key::Enter);
        key(Key::Enter);
        require(app.focused() == Focus::Popup, "A model action popup opens");
        key(Key::Tab);
        key(Key::Down);
        key(Key::Back);
        require(
            !app.controls_shown() && app.focused() == Focus::Popup && writes == 0,
            "Closing Controls preserves the underlying model popup without saving"
        );
        require(
            app.mouse_input({{5, 37}, MouseKind::Click, 0}) && app.controls_shown(),
            "The persistent Controls hint is clickable above a modal popup"
        );
        app.render(grid);
        require(
            app.mouse_input({{2, 2}, MouseKind::Click, 0}) && !app.controls_shown() && app.focused() == Focus::Popup,
            "An outside click dismisses only Controls"
        );
        key(Key::Back);
        key(Key::Back);
        key(Key::Back);
        key(Key::Down);
        key(Key::Enter);
        key(Key::Enter);
        key(Key::Enter);
        require(app.focused() == Focus::Popup, "A settings model selector opens");
        key(Key::Tab);
        key(Key::ScrollDown);
        key(Key::Back);
        require(
            app.focused() == Focus::Popup && text(grid).find("Option A") != std::string::npos && writes == 0,
            "Controls preserves a settings selector and its selected value"
        );
        grid = Grid(40, 16);
        key(Key::Tab);
        key(Key::End);
        require(
            text(grid).find("Suspend") != std::string::npos && app.controls_shown(),
            "Controls scrolls to its final mapping in a small terminal"
        );
        key(Key::Back);
        require(app.focused() == Focus::Popup, "Small-terminal Controls returns to the same selector");

        App without_mouse([](const Json &) {}, false, false);
        without_mouse.input({Key::Enter, {}});
        without_mouse.set_controller(nintendo);
        without_mouse.input({Key::Tab, {}});
        grid = Grid(120, 40);
        without_mouse.render(grid);
        require(
            text(grid).find("— • R-Stick") != std::string::npos && text(grid).find("Mouse wheel") == std::string::npos,
            "Controller-only scrolling stays after the separator when mouse input is disabled"
        );
    }
}
