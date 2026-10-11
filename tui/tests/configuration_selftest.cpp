// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

#include "app/app.hpp"
#include <algorithm>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }
        std::string text(const Grid &grid) {
            std::string result;
            for (const auto &cell : grid.cells) {
                result += cell.glyph;
            }
            return result;
        }
        MousePosition location(const Grid &grid, std::string_view label) {
            for (int y = 0; y < grid.height; ++y) {
                for (int x = 0; x + int(label.size()) <= grid.width; ++x) {
                    bool match = true;
                    for (size_t i = 0; i < label.size(); ++i) {
                        match = match && grid.cells[size_t(y * grid.width + x) + i].glyph == label.substr(i, 1);
                    }
                    if (match) {
                        return {x, y};
                    }
                }
            }
            throw std::runtime_error("Missing wizard action");
        }
        Json plan(Json answers) {
            Json::Array steps;
            for (int i = 0; i < 4; ++i) {
                std::string feature = "preview" + std::to_string(i);
                Json value = answers[feature]["choice"];
                if (value.null()) {
                    value = "First choice";
                }
                answers[feature]["choice"] = value;
                steps.push_back(
                    Json::object(
                        {{"feature", feature},
                         {"key", "choice"},
                         {"title", "Test setting " + std::to_string(i + 1)},
                         {"label", "Test setting " + std::to_string(i + 1)},
                         {"prompt", "Which option would you prefer?"},
                         {"help", "Test setting only. This choice does not change behavior."},
                         {"value", value},
                         {"options",
                          Json::Array{
                              Json::object({{"value", "First choice"}, {"label", "First choice"}}),
                              Json::object({{"value", "Second choice"}, {"label", "Second choice"}})
                          }}}
                    )
                );
            }
            return Json::object({{"revision", "draft-revision"}, {"answers", answers}, {"steps", steps}});
        }
    }

    void configuration_selftest() {
        std::vector<Json> sent;
        App app([&](const Json &request) { sent.push_back(request); }, false);
        Grid grid(120, 40);
        app.start();
        app.receive(
            Json::object(
                {{"id", sent.front()["id"]},
                 {"result",
                  Json::object({{"protocol", 1}, {"revision", "draft-revision"}, {"settingsUpToDate", false}})}}
            )
        );
        app.presented();
        app.receive(
            Json::object(
                {{"id", sent.back()["id"]}, {"result", Json::object({{"available", true}, {"latest", "0.9.3"}})}}
            )
        );
        app.render(grid);
        require(
            text(grid).find("Configure new settings") != std::string::npos,
            "Pending settings replace Update in the home corner"
        );
        require(
            text(grid).find("New version available") == std::string::npos,
            "Configuration takes priority until answered"
        );
        app.input({Key::Right, {}});
        app.input({Key::Enter, {}});
        require(sent.back()["method"].str() == "settings.pending", "Home action opens setup");
        auto answer = [&] {
            Json request = sent.back();
            require(request["method"].str() == "settings.pending", "Navigation resolves the draft");
            app.receive(Json::object({{"id", request["id"]}, {"result", plan(request["params"]["answers"])}}));
        };
        answer();
        app.render(grid);
        require(
            text(grid).find("1 • 2 • 3 • 4 • Confirm") != std::string::npos,
            "Wizard shows numbered steps and Confirm"
        );
        require(text(grid).find("Continue") != std::string::npos, "Question has a Continue action");
        app.input({Key::Down, {}});
        app.input({Key::Right, {}});
        require(
            sent.back()["params"]["answers"]["preview0"]["choice"].str() == "Second choice",
            "Right records the current draft choice"
        );
        size_t before = sent.size();
        app.input({Key::Enter, {}});
        require(sent.size() == before, "Repeated activation cannot advance while loading");
        answer();
        app.input({Key::Left, {}});
        answer();
        app.render(grid);
        require(text(grid).find("Test setting 1") != std::string::npos, "Left returns to the previous question");
        app.input({Key::Enter, {}});
        answer();
        require(
            sent.back()["params"]["answers"]["preview0"]["choice"].str() == "Second choice",
            "Previous steps retain their selection"
        );
        for (int i = 0; i < 3; ++i) {
            app.input({Key::Enter, {}});
            answer();
        }
        app.render(grid);
        require(text(grid).find("Review your choices") != std::string::npos, "Last question advances to recap");
        for (int i = 1; i <= 4; ++i) {
            require(
                text(grid).find("Test setting " + std::to_string(i)) != std::string::npos,
                "Recap lists every setting"
            );
        }
        require(
            std::none_of(
                sent.begin(),
                sent.end(),
                [](const Json &r) { return r["method"].str() == "settings.configure"; }
            ),
            "No draft answers are written before confirmation"
        );
        Grid small(40, 16);
        app.render(small);
        require(
            text(small).find("Save settings") != std::string::npos,
            "Recap remains usable at minimum terminal size"
        );
        app.input({Key::Left, {}});
        answer();
        app.input({Key::Down, {}});
        app.render(grid);
        require(app.mouse_input({location(grid, "Continue"), MouseKind::Click, 0}), "Continue is clickable");
        answer();
        app.input({Key::Enter, {}});
        require(sent.back()["method"].str() == "settings.configure", "Confirm sends one atomic save");
        require(
            sent.back()["params"]["answers"]["preview3"]["choice"].str() == "Second choice",
            "Revised answer appears in the recap save"
        );
        Json save = sent.back();
        app.receive(
            Json::object(
                {{"id", save["id"]}, {"error", Json::object({{"code", "internal"}, {"message", "Disk full"}})}}
            )
        );
        app.render(grid);
        require(text(grid).find("Disk full") != std::string::npos, "Save errors retain the recap for retry");
        app.input({Key::Enter, {}});
        save = sent.back();
        app.receive(
            Json::object({{"id", save["id"]}, {"result", Json::object({{"ok", true}, {"revision", "saved"}})}})
        );
        app.render(grid);
        require(
            text(grid).find("New version available: 0.9.3") != std::string::npos,
            "Update returns after configuration"
        );

        // Closing an in-flight wizard must ignore its late response and keep the pending action.
        app.receive(
            Json::object(
                {{"id", sent[sent.size() - 2]["id"]},
                 {"result", Json::object({{"protocol", 1}, {"settingsUpToDate", false}})}}
            )
        );
        app.input({Key::Right, {}});
        app.input({Key::Enter, {}});
        Json late = sent.back();
        app.input({Key::Back, {}});
        app.receive(Json::object({{"id", late["id"]}, {"result", plan(Json::Object{})}}));
        app.render(grid);
        require(
            text(grid).find("Configure new settings") != std::string::npos &&
                text(grid).find("Continue") == std::string::npos,
            "Cancel leaves questions pending and late replies cannot reopen the popup"
        );
        app.input({Key::Enter, {}});
        Json long_plan = plan(Json::Object{});
        Json::Array options;
        for (int i = 0; i < 20; ++i) {
            std::string choice = "Choice " + std::to_string(i);
            options.push_back(Json::object({{"value", choice}, {"label", choice}}));
        }
        auto &steps = std::get<Json::Array>(long_plan["steps"].value);
        steps[0]["options"] = options;
        steps[0]["value"] = "Choice 0";
        app.receive(Json::object({{"id", sent.back()["id"]}, {"result", long_plan}}));
        app.render(small);
        app.input({Key::ScrollDown, {}});
        app.input({Key::ScrollDown, {}});
        app.render(small);
        app.input({Key::Down, {}});
        app.input({Key::Enter, {}});
        require(
            sent.back()["params"]["answers"]["preview0"]["choice"].str() == "Choice 2",
            "After scrolling a wizard answer off screen, Down selects the first visible option"
        );
    }
}
