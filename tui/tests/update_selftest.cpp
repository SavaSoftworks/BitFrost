// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "app/options.hpp"
#include <algorithm>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        std::string text(const Grid &grid, bool selected = false) {
            std::string result;
            for (const Cell &cell : grid.cells) {
                result += !selected || (cell.fg == black && cell.bg != black) ? cell.glyph : " ";
            }
            return result;
        }

        void available(App &app, const std::vector<Json> &sent) {
            app.receive(
                Json::object(
                    {{"id", sent.back()["id"]}, {"result", Json::object({{"available", true}, {"latest", "0.9.2"}})}}
                )
            );
        }
    }

    void update_selftest() {
        Options options;
        require(options.parse("--resume") && options.resume, "Resume flag parses");
        require(
            options.parse("--message=Updated to 0.9.2") && options.message == "Updated to 0.9.2",
            "Startup message preserves spaces"
        );
        require(options.parse("--message=") && options.message.empty(), "Empty startup message parses");
        require(
            options.parse("--no-anim") && !options.animations && options.parse("--no-mouse") && !options.mouse,
            "Keyboard and animation flags still parse"
        );
        require(!options.parse("--resume=1") && !options.parse("--message"), "Malformed options are rejected");

        std::vector<Json> sent;
        App app([&](const Json &request) { sent.push_back(request); }, false, true, true, "Welcome back");
        Grid grid(120, 40);
        app.start();
        require(sent.size() == 2, "Update check waits for the first home presentation");
        app.render(grid);
        require(text(grid).find("Welcome back") != std::string::npos, "Startup message renders in the status bar");
        app.presented();
        app.presented();
        require(sent.size() == 3 && sent.back()["method"].str() == "update.check", "Check is sent once per session");
        available(app, sent);
        app.render(grid);
        require(
            text(grid).find("New version available: 0.9.2") != std::string::npos,
            "Available version appears in the home corner"
        );
        require(
            grid.cells[size_t(33 * 120 + 109)].glyph == "U" && grid.cells[size_t(33 * 120 + 109)].fg == blue,
            "Inactive update button is plain blue below the notice"
        );
        auto selected = [&](std::string_view label) {
            app.render(grid);
            return text(grid, true).find(label) != std::string::npos;
        };
        for (std::string_view label : {"Models", "Settings", "Status"}) {
            require(selected(label), "Menu origin is selected");
            app.input({Key::Right, {}});
            require(selected("Update") && !selected(label), "Right moves from each menu item to Update");
            require(
                grid.cells[size_t(32 * 120 + 107)].glyph == "▄" && grid.cells[size_t(34 * 120 + 107)].glyph == "▀",
                "Focused update button has half-cell padding"
            );
            app.input({Key::Left, {}});
            require(selected(label), "Left restores the menu origin");
            if (label != "Status") {
                app.input({Key::Down, {}});
            }
        }
        app.input({Key::Down, {}});
        require(selected("Update"), "Down from Status selects Update");
        app.input({Key::Up, {}});
        require(selected("Status"), "Up from Update returns to Status");
        app.input({Key::Home, {}});
        app.input({Key::Right, {}});
        app.input({Key::Up, {}});
        require(selected("Status"), "Up returns to Status regardless of menu origin");
        app.render(grid);
        app.mouse(MousePosition{109, 33});
        app.render(grid);
        require(
            grid.cells[size_t(33 * 120 + 109)].fg != blue && !selected("Update"),
            "Hover brightens Update without moving keyboard focus"
        );
        app.mouse(std::nullopt);
        app.input({Key::Down, {}});
        app.input({Key::Enter, {}});
        app.input({Key::Enter, {}});
        require(
            std::count_if(
                sent.begin(),
                sent.end(),
                [](const Json &request) { return request["method"].str() == "update.run"; }
            ) == 1,
            "Update cannot be started twice"
        );
        const auto run = *std::find_if(sent.begin(), sent.end(), [](const Json &request) {
            return request["method"].str() == "update.run";
        });
        require(
            run["params"]["simulate"].null() && run["params"]["version"].str() == "0.9.2",
            "The update asks for the found version and leaves simulating to the broker"
        );
        require(app.page() == Page::Home, "Repeated activation does not accidentally activate the menu");
        app.input({Key::Left, {}});
        app.input({Key::Enter, {}});
        require(app.page() == Page::Status, "Menu remains usable while updating");
        app.input({Key::Back, {}});
        for (int index = 0; index < 12; ++index) {
            app.receive(
                Json::object(
                    {{"method", "update.step"},
                     {"params",
                      Json::object(
                          {{"index", index},
                           {"total", 12},
                           {"label", "Step " + std::to_string(index)},
                           {"detail", "detail"},
                           {"state", index == 11 ? "running" : "done"}}
                      )}}
                )
            );
        }
        app.render(grid);
        require(
            text(grid).find("Step 0") == std::string::npos && text(grid).find("Step 3") != std::string::npos &&
                text(grid).find("Step 11") != std::string::npos,
            "Progress keeps the newest fitting lines and scrolls older steps upward"
        );
        require(
            text(grid).find("✓") != std::string::npos && text(grid).find("◴") != std::string::npos,
            "Done steps have checks and running steps have a spinner"
        );
        auto detail = std::find_if(grid.cells.begin(), grid.cells.end(), [](const Cell &cell) {
            return cell.glyph == "d" && cell.fg == dim;
        });
        require(detail != grid.cells.end(), "Step details stay dim");
        for (auto [width, height] : {std::pair{80, 24}, std::pair{40, 18}}) {
            Grid narrow(width, height);
            app.render(narrow);
            require(
                text(narrow).find("◴") != std::string::npos &&
                    (width < 80 || text(narrow).find("Step 11") != std::string::npos),
                "Newest running step fits a small terminal with its label shortened when needed"
            );
        }
        app.receive(
            Json::object(
                {{"method", "update.finished"}, {"params", Json::object({{"ok", true}, {"version", "0.9.2"}})}}
            )
        );
        app.render(grid);
        require(
            app.status() == "Updated to 0.9.2. Restarting..." && app.needs_tick(),
            "Finished message renders and schedules reload even without animations"
        );
        app.step(0.99);
        require(app.restart_version().empty(), "Completion is visible for a second");
        app.step(0.02);
        require(app.restart_version() == "0.9.2", "Completion requests a reload");
        app.restart_failed();
        app.step(2);
        require(
            app.restart_version().empty() && app.status() == "Restart bitfrost to use 0.9.2",
            "Failed reload falls back once with a status message"
        );

        for (bool rpc_error : {false, true}) {
            sent.clear();
            App unavailable([&](const Json &request) { sent.push_back(request); }, false);
            unavailable.presented();
            unavailable.receive(
                Json::object(
                    {{"id", sent.back()["id"]},
                     {rpc_error ? "error" : "result", Json::object({{"available", false}, {"message", "offline"}})}}
                )
            );
            unavailable.render(grid);
            require(
                text(grid).find("Update") == std::string::npos && unavailable.status().empty(),
                "Unavailable versions and check errors stay silent"
            );
        }
        sent.clear();
        for (bool rpc_error : {false, true}) {
            App retry([&](const Json &request) { sent.push_back(request); }, false);
            retry.presented();
            available(retry, sent);
            retry.input({Key::Right, {}});
            retry.input({Key::Enter, {}});
            Json run_request = sent.back();
            if (rpc_error) {
                retry.receive(
                    Json::object({{"id", run_request["id"]}, {"error", Json::object({{"message", "download failed"}})}})
                );
            } else {
                retry.receive(
                    Json::object(
                        {{"method", "update.finished"},
                         {"params", Json::object({{"ok", false}, {"error", "download failed"}})}}
                    )
                );
            }
            retry.render(grid);
            require(
                text(grid).find("Update") != std::string::npos &&
                    retry.status().find("download failed") != std::string::npos,
                "Failed update restores the button and keeps the failure message"
            );
            size_t count = sent.size();
            retry.input({Key::Enter, {}});
            require(
                sent.size() == count + 1 && sent.back()["method"].str() == "update.run" && retry.status().empty(),
                "Retry starts a fresh update and clears the failure"
            );
            retry.receive(
                Json::object(
                    {{"method", "update.finished"}, {"params", Json::object({{"ok", true}, {"version", "0.9.2"}})}}
                )
            );
            retry.step(1.1);
            require(retry.restart_version() == "0.9.2", "Successful retry can restart");
        }
        sent.clear();
        App clicked([&](const Json &request) { sent.push_back(request); }, false);
        clicked.presented();
        available(clicked, sent);
        clicked.render(grid);
        clicked.mouse_input({{109, 33}, MouseKind::Click, 0});
        clicked.mouse_input({{109, 33}, MouseKind::Click, 0});
        require(
            sent.size() == 2 && sent.back()["method"].str() == "update.run",
            "Click starts Update and repeated clicks are guarded"
        );

        App animated([](const Json &) {}, true, true, true);
        animated.render(grid);
        require(text(grid, true).find("Models") != std::string::npos, "Resume opens a fully drawn home frame");
        App intro([](const Json &) {}, true);
        intro.render(grid);
        require(text(grid, true).find("Models") == std::string::npos, "Normal startup includes the intro");
        intro.step(0.23);
        intro.render(grid);
        require(text(grid, true).find("Models") != std::string::npos, "Intro reaches the completed home frame");

        sent.clear();
        App fading([&](const Json &request) { sent.push_back(request); }, true, true, true);
        fading.presented();
        available(fading, sent);
        fading.input({Key::Right, {}});
        fading.input({Key::Enter, {}});
        fading.receive(
            Json::object(
                {{"method", "update.step"},
                 {"params",
                  Json::object(
                      {{"index", 0}, {"total", 8}, {"label", "Release"}, {"detail", "archive"}, {"state", "running"}}
                  )}}
            )
        );
        fading.render(grid);
        require(text(grid, true).find("Update") != std::string::npos, "Update begins by fading its highlight");
        fading.step(0.24);
        fading.render(grid);
        require(
            text(grid).find("Update") == std::string::npos && text(grid).find("◷ Release") != std::string::npos,
            "After the fade the running step replaces the button"
        );
        fading.step(0.125);
        fading.render(grid);
        require(text(grid).find("◶ Release") != std::string::npos, "Running step spinner advances on the frame clock");
    }
}
