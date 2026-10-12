// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

#include "app.hpp"
#include "ui/popup.hpp"
#include <algorithm>

namespace bf {
    void App::start_configuration() {
        if (configuration.open || update.busy) {
            return;
        }
        int generation = configuration.generation + 1;
        configuration = {};
        configuration.generation = generation;
        configuration.open = configuration.busy = true;
        request("settings.pending", Json::Object{}, std::to_string(generation));
    }

    void App::configuration_move(int direction) {
        if (!configuration.open || configuration.busy) {
            return;
        }
        if ((direction < 0 && configuration.step == 0) ||
            (direction > 0 && configuration.step == int(configuration.steps.size()))) {
            return;
        }
        if (configuration.step < int(configuration.steps.size())) {
            const auto &step = configuration.steps[size_t(configuration.step)];
            const auto &options = step["options"].array();
            if (options.empty()) {
                return;
            }
            int option = std::clamp(configuration.option, 0, int(options.size()) - 1);
            configuration.answers[step["feature"].str()][step["key"].str()] = options[size_t(option)]["value"];
        }
        configuration.busy = true;
        configuration.direction = direction;
        configuration.error.clear();
        request(
            "settings.pending",
            Json::object({{"answers", configuration.answers}, {"revision", configuration.revision}}),
            std::to_string(configuration.generation)
        );
    }

    void App::configuration_input(const Input &event) {
        if (event.key == Key::Back && !configuration.committing) {
            configuration.open = false;
            ++configuration.generation;
            message = "New settings left for later";
            return;
        }
        if (configuration.busy) {
            return;
        }
        bool review = configuration.step == int(configuration.steps.size());
        if (event.key == Key::Left || event.key == Key::Right) {
            configuration_move(event.key == Key::Left ? -1 : 1);
        } else if (event.key == Key::Enter) {
            if (!review) {
                configuration_move(1);
            } else {
                configuration.busy = configuration.committing = true;
                configuration.error.clear();
                request(
                    "settings.configure",
                    Json::object({{"answers", configuration.answers}, {"revision", configuration.revision}}),
                    std::to_string(configuration.generation)
                );
            }
        } else if (review) {
            int delta = event.key == Key::Up || event.key == Key::ScrollUp       ? -1
                        : event.key == Key::Down || event.key == Key::ScrollDown ? 1
                        : event.key == Key::PageUp                               ? -configuration.visible
                        : event.key == Key::PageDown                             ? configuration.visible
                                                                                 : 0;
            if (event.key == Key::Home) {
                configuration.first = 0;
            } else if (event.key == Key::End) {
                configuration.first = int(configuration.steps.size());
            } else {
                configuration.first += delta;
            }
            configuration.first = std::clamp(
                configuration.first,
                0,
                std::max(0, int(configuration.steps.size()) - configuration.visible)
            );
        } else {
            const auto &options = configuration.steps[size_t(configuration.step)]["options"].array();
            if (event.key == Key::ScrollUp || event.key == Key::ScrollDown) {
                configuration.option_view
                    .scroll(event.key == Key::ScrollUp ? -1 : 1, int(options.size()), configuration.visible);
            } else {
                configuration.option_view
                    .input(configuration.option, event.key, int(options.size()), configuration.visible);
            }
        }
    }

    void App::receive_configuration(const std::string &method, const std::string &context, const Json &reply) {
        if (!configuration.open || context != std::to_string(configuration.generation)) {
            return;
        }
        configuration.busy = configuration.committing = false;
        if (!reply["error"].null()) {
            configuration.error = reply["error"]["message"].str("Could not load new settings");
            if (reply["error"]["code"].str() == "conflict" || configuration.steps.empty()) {
                message = configuration.error;
                configuration.open = false;
                reload();
            }
            return;
        }
        const auto &result = reply["result"];
        if (method == "settings.configure") {
            configuration.open = false;
            pending_settings = false;
            update.focused = false;
            message = "New settings saved";
            reload();
            return;
        }
        configuration.steps = result["steps"].array();
        configuration.answers = result["answers"];
        configuration.revision = result["revision"].str();
        if (configuration.steps.empty()) {
            configuration.open = false;
            pending_settings = false;
            update.focused = !update.version.empty();
            message = "Settings are up to date";
            return;
        }
        configuration.step =
            std::clamp(configuration.step + configuration.direction, 0, int(configuration.steps.size()));
        configuration.direction = 0;
        configuration.option = configuration.first = 0;
        configuration.option_view.reset();
        if (configuration.step < int(configuration.steps.size())) {
            const auto &step = configuration.steps[size_t(configuration.step)];
            const auto &options = step["options"].array();
            for (size_t index = 0; index < options.size(); ++index) {
                if (options[index]["value"] == step["value"]) {
                    configuration.option = int(index);
                }
            }
        }
    }

    void App::draw_configuration(Grid &grid) {
        if (grid.width < 40 || grid.height < 16) {
            // Keep the overlay modal while the terminal is too small.
            hits.modal({2, 2, grid.width - 4, grid.height - 4});
            return;
        }
        int count = int(configuration.steps.size());
        bool review = configuration.step == count;
        int rows = review ? count : int(configuration.steps[size_t(configuration.step)]["options"].array().size());
        int desired_height = std::max(12, rows + (review ? 9 : 11));
        int width = std::min(92, grid.width - 6), height = std::min({desired_height, 24, grid.height - 4});
        Popup popup{(grid.width - width) / 2, (grid.height - height) / 2, width, height};
        popup_frame(grid, popup, "");
        hits.modal({popup.x, popup.y, width, height});
        int x = popup.x + 2, right = popup.x + width - 2, content = width - 4;
        if (!count) {
            grid.text(x, popup.y + 1, "New settings");
            grid.text(x, popup.y + 4, "Loading...", dim);
            return;
        }
        // Keep the active step visible even when future releases add many questions.
        int start = 0;
        auto indicator_width = [&](int first, int last) {
            int size = 0;
            for (int i = first; i <= last; ++i) {
                size += text_width(i == count ? "Confirm" : std::to_string(i + 1)) + (i > first ? 3 : 0);
            }
            return size;
        };
        while (start < configuration.step && indicator_width(start, configuration.step) > content) {
            ++start;
        }
        int cursor = x;
        for (int i = start; i <= count; ++i) {
            std::string label = i == count ? "Confirm" : std::to_string(i + 1);
            if (cursor + text_width(label) > right) {
                break;
            }
            grid.text(cursor, popup.y + 1, label, i == configuration.step ? blue : dim);
            hits.add({cursor, popup.y + 1, text_width(label), 1}, HitKind::ConfigurationStep, i);
            cursor += text_width(label);
            if (i < count && cursor + 3 < right) {
                grid.text(cursor, popup.y + 1, " • ", dim);
                cursor += 3;
            }
        }
        int top = popup.y + (review ? 5 : 7);
        int bottom = popup.y + height - 4;
        if (!configuration.error.empty()) {
            --bottom;
            grid.text(x, popup.y + height - 4, ellipsis(configuration.error, content), white);
        }
        configuration.visible = std::max(1, bottom - top + 1);
        if (review) {
            grid.text(x, popup.y + 3, "Review your choices", blue, black, content);
            configuration.first = std::clamp(configuration.first, 0, std::max(0, count - configuration.visible));
            int body_width = draw_scrollbar(
                grid,
                "configuration",
                x,
                top,
                content,
                configuration.visible,
                count,
                configuration.first,
                configuration.visible,
                true
            );
            for (int i = configuration.first; i < std::min(count, configuration.first + configuration.visible); ++i) {
                const auto &step = configuration.steps[size_t(i)];
                std::string choice;
                for (const auto &option : step["options"].array()) {
                    if (option["value"] == step["value"]) {
                        choice = option["label"].str();
                    }
                }
                int label_width = body_width / 2;
                std::string label = ellipsis(step["label"].str(), label_width);
                choice = ellipsis(choice, body_width - label_width - 2);
                int y = top + i - configuration.first;
                grid.text(x, y, label, blue, black, label_width);
                grid.text(x + body_width - text_width(choice), y, choice, white);
            }
        } else {
            const auto &step = configuration.steps[size_t(configuration.step)];
            grid.text(x, popup.y + 3, ellipsis(step["title"].str(), content), dim);
            grid.text(x, popup.y + 4, ellipsis(step["prompt"].str(), content), blue);
            grid.text(x, popup.y + 5, ellipsis(step["help"].str(), content), dim);
            const auto &options = step["options"].array();
            configuration.first =
                configuration.option_view.first_row(configuration.option, int(options.size()), configuration.visible);
            int body_width = draw_scrollbar(
                grid,
                "configuration",
                x,
                top,
                content,
                configuration.visible,
                int(options.size()),
                configuration.first,
                configuration.visible,
                true
            );
            for (int i = configuration.first;
                 i < std::min(int(options.size()), configuration.first + configuration.visible);
                 ++i) {
                int y = top + i - configuration.first;
                std::string label = options[size_t(i)]["label"].str();
                if (i == configuration.option) {
                    highlight(grid, x, y, body_width, label, clock);
                } else {
                    grid.text(x + 1, y, ellipsis(label, body_width - 1));
                }
                hits.add({x, y, body_width, 1}, HitKind::ConfigurationOption, i);
            }
        }
        hits.scroll({x, top, content, configuration.visible}, HitKind::ConfigurationOption);
        int footer = popup.y + height - 2;
        if (configuration.busy) {
            std::string label = configuration.committing ? "Saving..." : "Loading...";
            grid.text(right - text_width(label), footer, label, dim);
            return;
        }
        grid.text(x, footer, "Previous", configuration.step > 0 ? blue : dim);
        if (configuration.step > 0) {
            hits.add({x, footer, 8, 1}, HitKind::ConfigurationPrevious);
        }
        if (!review) {
            grid.text(x + 10, footer, "Next");
            hits.add({x + 10, footer, 4, 1}, HitKind::ConfigurationNext);
        }
        std::string action = review ? "Save settings" : "Continue";
        grid.text(right - text_width(action), footer, action);
        hits.add({right - text_width(action), footer, text_width(action), 1}, HitKind::ConfigurationContinue);
    }
}
