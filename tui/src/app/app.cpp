// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app.hpp"
#include "metadata.hpp"
#include "rpc/protocol.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>

namespace bf {
    namespace {
        const Json &at(const Json::Array &entries, int index) {
            static const Json empty;
            return index >= 0 && size_t(index) < entries.size() ? entries[size_t(index)] : empty;
        }

        void move(int &position, int delta, size_t count) {
            position = count ? std::clamp(position + delta, 0, int(count) - 1) : 0;
        }

    }

    App::App(
        std::function<void(const Json &)> sender,
        bool animate,
        bool mouse,
        bool resume,
        std::string initial_message,
        std::function<bool(const std::string &)> link_opener
    )
        : send(std::move(sender)),
          opener(std::move(link_opener)),
          message(std::move(initial_message)),
          animations(animate),
          mouse_enabled(mouse) {
        if (animations && !resume) {
            transition = Transition::Enter;
        }
        if (animations) {
            particles = std::make_unique<Particles>();
        }
        try {
            about = Json::parse(about_metadata);
        } catch (...) {
            about = Json{};
        }
        model_rows.reset(models, false);
    }

    int64_t App::request(std::string method, Json params, std::string context, bool quiet) {
        int64_t id = next_id++;
        requests.emplace(id, Request{method, context, params, quiet});
        latest[method + ':' + context] = id;
        send(Json::object({{"id", id}, {"method", method}, {"params", std::move(params)}}));
        return id;
    }

    void App::start() {
        request("hello", Json::object({{"protocol", 1}}));
        request("providers.list");
    }

    const Json &App::provider() const {
        return at(providers, provider_selection);
    }

    const Json &App::model() const {
        return at(models, model_rows.model_index());
    }

    const Json &App::section() const {
        return at(sections, section_selection);
    }

    const Json::Array &App::visible_items() const {
        return setting_items;
    }

    void App::update_setting_rows() {
        setting_items.clear();
        std::vector<std::string> groups;
        for (auto &setting : section()["items"].array()) {
            bool visible = true;
            const auto &condition = setting["visibleWhen"];
            if (!condition.null()) {
                visible = false;
                for (auto &section_value : sections) {
                    for (auto &other_setting : section_value["items"].array()) {
                        if (other_setting["key"] == condition["key"]) {
                            visible = other_setting["value"] == condition["equals"];
                        }
                    }
                }
            }
            if (visible) {
                setting_items.push_back(setting);
                groups.push_back(setting["group"].str());
            }
        }
        setting_rows.reset(groups);
    }

    Json App::item() const {
        return at(visible_items(), item_selection);
    }

    void App::load_models(bool refresh) {
        auto provider_id = provider()["id"].str();
        if (provider_id.empty()) {
            return;
        }
        loading_models = true;
        discovery_error.clear();
        Json params = Json::object({{"provider", provider_id}});
        if (refresh) {
            params["refresh"] = true;
        }
        request("models.list", std::move(params), provider_id);
    }

    void App::load_stats(bool refresh) {
        if (current != Page::Models || !stats_visible || model().null()) {
            unwatch_stats();
            return;
        }
        std::string provider_id = provider()["id"].str(), model_id = model()["model"].str();
        if (refresh || stats_provider != provider_id || stats_model != model_id) {
            stats_provider = provider_id;
            stats_model = model_id;
            request(
                "models.stats",
                Json::object({{"provider", provider_id}, {"model", model_id}}),
                provider_id + ':' + model_id
            );
        }
    }

    void App::unwatch_stats() {
        if (!stats_provider.empty()) {
            stats_provider.clear();
            stats_model.clear();
            request("unwatch", Json::object({{"what", "stats"}}));
        }
    }

    void App::reload() {
        request("hello", Json::object({{"protocol", 1}}));
        request("providers.list");
        if (current == Page::Settings) {
            loading_settings = true;
            request("settings.get");
        }
        if (current == Page::Models) {
            load_models();
        }
    }

    void App::receive(const Json &reply) {
        if (reply["id"].null()) {
            if (receive_update(reply)) {
                return;
            }
            auto method = reply["method"].str();
            if (method == "subagents.changed" && current == Page::Status && subagents_watched) {
                changed_subagents(reply["params"]);
            }
            if (method == "stats.updated" && current == Page::Models &&
                reply["params"]["provider"] == provider()["id"]) {
                for (const Json &row : reply["params"]["rows"].array()) {
                    provider_stats[provider()["id"].str()][row["model"].str()] = row;
                }
            }
            if (method == "models.updated" && current == Page::Models &&
                reply["params"]["provider"] == provider()["id"]) {
                load_models();
            }
            if (method == "settings.updated" && current == Page::Settings) {
                request("settings.get", Json::Object{}, {}, true);
            }
            if (method == "config.changed") {
                message =
                    configuration.open ? "Config changed; reopen Configure new settings" : "Config changed; refreshing";
                configuration.open = false;
                ++configuration.generation;
                reload();
            }
            return;
        }
        auto pending_request = requests.find(reply["id"].integer());
        if (pending_request == requests.end()) {
            return;
        }
        auto request_info = std::move(pending_request->second);
        auto id = pending_request->first;
        requests.erase(pending_request);
        if (latest[request_info.method + ':' + request_info.context] != id) {
            return;
        }
        auto &result = reply["result"];
        if (request_info.method == "settings.pending" || request_info.method == "settings.configure") {
            receive_configuration(request_info.method, request_info.context, reply);
            return;
        }
        if (request_info.method == "subagents.page") {
            receive_history(result, request_info.params, request_info.context, !reply["error"].null());
            if (!reply["error"].null() && request_info.context.starts_with(std::to_string(history_generation) + ':')) {
                message = reply["error"]["message"].str("BitFrost helper error");
            }
            return;
        }
        if (request_info.method == "update.check") {
            if (reply["error"].null() && result["error"].null() && result["available"].boolean()) {
                update.version = result["latest"].str();
            }
            return;
        }
        if (request_info.method == "update.run") {
            if (!reply["error"].null() || !result["ok"].boolean()) {
                message = reply["error"]["message"].str("Update failed");
                update.busy = false;
                update.failed = true;
                update.finished = false;
            }
            return;
        }
        bool write = request_info.method == "settings.set" || request_info.method == "models.set" ||
                     request_info.method == "providers.set";
        if (write) {
            saving = false;
        }
        if (!reply["error"].null()) {
            if (!request_info.quiet) {
                message = reply["error"]["message"].str("BitFrost helper error");
            }
            if (request_info.method == "models.list") {
                loading_models = false;
                discovery_error = message;
            }
            if (request_info.method == "settings.get") {
                loading_settings = false;
            }
            if (request_info.method == "subagents.overview") {
                loading_subagents = false;
            }
            if (request_info.method == "status.get") {
                loading_helper = false;
            }
            if (reply["error"]["code"].str() == "conflict") {
                reload();
            }
            return;
        }
        if (request_info.method == "hello") {
            revision = result["revision"].str();
            pending_settings = !result["settingsUpToDate"].boolean(true);
            if (!pending_settings && update.version.empty()) {
                update.focused = false;
            }
            if (result["protocol"].integer() != 1) {
                message = "Unsupported BitFrost helper protocol";
            } else if (!result["configError"].null()) {
                message = result["configError"].str();
            }
        } else if (request_info.method == "providers.list") {
            std::string previous = provider()["id"].str();
            providers = result["providers"].array();
            move(provider_selection, 0, providers.size());
            for (size_t index = 0; index < providers.size(); ++index) {
                if (providers[index]["id"].str() == previous) {
                    provider_selection = int(index);
                }
            }
            if (current == Page::Models && previous != provider()["id"].str()) {
                load_models();
            }
        } else if (request_info.method == "models.list" && request_info.context == provider()["id"].str()) {
            models = result["models"].array();
            model_rows.reset(models);
            loading_models = result["pending"].boolean();
            discovery_error = result["error"].str();
            if (current == Page::Models) {
                load_stats();
            }
        } else if (request_info.method == "models.stats") {
            for (const Json &row : result["rows"].array()) {
                provider_stats[request_info.params["provider"].str()][row["model"].str()] = row;
            }
        } else if (request_info.method == "subagents.overview" && current == Page::Status) {
            bool preserve = !overview.null();
            overview = result;
            overview_age = 0;
            overview_rows.reset(overview, false, preserve);
            loading_subagents = false;
            sync_subagents();
        } else if (request_info.method == "status.get" && current == Page::Status) {
            helper = result;
            helper_age = 0;
            helper_now = double(std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::system_clock::now().time_since_epoch()
            )
                                    .count());
            loading_helper = false;
        } else if (request_info.method == "settings.get") {
            revision = result["revision"].str();
            pending_settings = !result["settingsUpToDate"].boolean(!pending_settings);
            sections = result["sections"].array();
            loading_settings = false;
            move(section_selection, 0, sections.size());
            update_setting_rows();
            move(item_selection, 0, visible_items().size());
        } else if (write) {
            revision = result["revision"].str();
            message = "Saved";
            for (auto &warning : result["warnings"].array()) {
                message += ": " + warning.str();
            }
            if (request_info.method == "settings.set") {
                for (auto &section_value : sections) {
                    for (auto &setting : std::get<Json::Array>(section_value["items"].value)) {
                        if (setting["key"] == request_info.params["key"]) {
                            setting["value"] = request_info.params["value"];
                        }
                    }
                }
                update_setting_rows();
                move(item_selection, 0, visible_items().size());
                request("settings.get");
            } else {
                if (request_info.method == "models.set") {
                    load_stats(true);
                }
                request("providers.list");
                load_models();
            }
            if (focus.back() == Focus::Popup || focus.back() == Focus::Editor) {
                while (focus.size() > 1 && (focus.back() == Focus::Popup || focus.back() == Focus::Editor)) {
                    focus.pop_back();
                }
            }
        }
    }

    void App::enter_page(Page page) {
        if (current == Page::Status && page != Page::Status) {
            unwatch_subagents();
            ++history_generation;
        }
        if (current == Page::Models && page != Page::Models) {
            unwatch_stats();
            stats_visible = false;
        }
        current = page;
        focus = page == Page::Home ? std::vector{Focus::Home} : std::vector{Focus::Home, Focus::Sidebar};
        particles = animations && page == Page::Home ? std::make_unique<Particles>() : nullptr;
        emitters.clear();
        logo_boundary = {};
        hits.clear(0, 0);
        if (page == Page::Models) {
            request("providers.list");
            load_models();
        }
        if (page == Page::Settings) {
            loading_settings = true;
            request("settings.get");
        }
        if (page == Page::Status) {
            subagents_visible = false;
            status_section = 0;
            status_view.reset();
            status_history = false;
            loading_helper = loading_history = false;
            helper_rows.reset({});
            helper_rows.clear_view();
            overview = history = helper = Json{};
            overview_rows.reset(overview, false, false);
            history_rows.reset(history, true, false);
            load_overview();
        }
        transition = animations ? Transition::Enter : Transition::None;
        elapsed = 0;
    }

    void App::open_page(Page page) {
        target = page;
        if (!animations) {
            enter_page(page);
            return;
        }
        transition = current == Page::Home ? Transition::Exit : Transition::Enter;
        elapsed = 0;
        if (current != Page::Home) {
            enter_page(page);
        }
    }

    void App::back() {
        if (current == Page::Status && status_history && focus.back() == Focus::List) {
            status_history = false;
            ++history_generation;
            sync_subagents();
            return;
        }
        if (focus.back() == Focus::Editor) {
            focus.pop_back();
            editor.reset("");
            adding_list = false;
            return;
        }
        if (focus.size() > 2) {
            focus.pop_back();
            return;
        }
        if (current != Page::Home) {
            open_page(Page::Home);
            return;
        }
        running = false;
    }

    void App::write_setting(const Json &setting, Json value) {
        if (saving || setting["key"].null()) {
            return;
        }
        saving = true;
        message = "Saving...";
        request(
            "settings.set",
            Json::object({{"key", setting["key"]}, {"value", std::move(value)}, {"revision", revision}}),
            setting["key"].str()
        );
    }

    void App::start_editor(const Json &setting, bool add) {
        adding_list = add;
        edit_key = setting["key"].str();
        edit_type = add ? "text" : setting["type"].str();
        editor.reset(add || setting["value"].null() ? "" : setting["value"].str(setting["value"].dump()));
        focus.push_back(Focus::Editor);
    }

    void App::edit(const Input &event) {
        if (event.key == Key::Back) {
            back();
            return;
        }
        if (event.key == Key::Enter) {
            Json setting = item(), value = editor.value;
            if (adding_list) {
                if (editor.value.empty()) {
                    message = "Enter a value";
                    return;
                }
                auto values = list_edit.array();
                values.emplace_back(editor.value);
                value = std::move(values);
            } else if (edit_type == "number") {
                try {
                    value = Json::parse(editor.value);
                    if (!std::holds_alternative<double>(value.value) && !std::holds_alternative<int64_t>(value.value)) {
                        throw std::runtime_error("number");
                    }
                } catch (...) {
                    message = "Enter a valid number";
                    return;
                }
                if (!setting["min"].null() && value.number() < setting["min"].number()) {
                    message = "Minimum value: " + setting["min"].dump();
                    return;
                }
            }
            setting["key"] = edit_key;
            write_setting(setting, std::move(value));
            return;
        }
        if (saving) {
            return;
        }
        editor.input(event);
    }

    void App::scroll_popup(int delta) {
        if (current != Page::Settings) {
            return;
        }
        Json setting = item();
        int count = setting["type"].str() == "list" ? int(list_edit.array().size()) + 1
                                                    : int(setting["options"].array().size());
        popup_view.scroll(delta, count, popup_visible);
    }

    void App::scroll_main(int delta) {
        if (current == Page::Models) {
            model_rows.scroll(delta, list_visible);
        } else if (current == Page::Settings) {
            setting_rows.first_row(item_selection, list_visible);
            setting_rows.scroll(delta, list_visible);
        } else if (current == Page::Status) {
            if (status_section == 0) {
                (status_history ? history_rows : overview_rows).scroll(delta, list_visible);
                sync_subagents();
            } else if (status_section == 1) {
                helper_rows.first_row(helper_selection, list_visible);
                helper_rows.scroll(delta, list_visible);
            } else {
                about_following = false;
                about_first = std::clamp(about_first + delta, 0, std::max(0, about_total - list_visible));
            }
        }
    }

    void App::input(const Input &event) {
        if (event.key == Key::Mouse) {
            if (event.mouse) {
                mouse_input(*event.mouse);
            }
            return;
        }
        if (event.key == Key::Interrupt) {
            stop();
            return;
        }
        if (event.key == Key::Tab || event.key == Key::Controls) {
            controls_open = !controls_open;
            controls_first = 0;
            last_click.reset();
            clicked_target.reset();
            return;
        }
        if (controls_open) {
            if (event.key == Key::Back || (event.key == Key::Text && (event.text == "q" || event.text == "Q"))) {
                controls_open = false;
            } else if (event.key == Key::Up || event.key == Key::ScrollUp) {
                scroll_controls(-1);
            } else if (event.key == Key::Down || event.key == Key::ScrollDown) {
                scroll_controls(1);
            } else if (event.key == Key::PageUp || event.key == Key::PageDown) {
                scroll_controls(event.key == Key::PageUp ? -controls_visible : controls_visible);
            } else if (event.key == Key::Home) {
                controls_first = 0;
            } else if (event.key == Key::End) {
                scroll_controls(int(control_mappings().size()));
            }
            return;
        }
        if (helper_missing) {
            if (event.key == Key::Back) {
                running = false;
            }
            return;
        }
        if (configuration.open) {
            configuration_input(event);
            return;
        }
        if (event.key == Key::ScrollUp || event.key == Key::ScrollDown) {
            if (transition != Transition::Exit && !saving) {
                int delta = event.key == Key::ScrollUp ? -1 : 1;
                if (focus.back() == Focus::Popup || (editing() && adding_list)) {
                    scroll_popup(delta);
                } else if (!editing()) {
                    scroll_main(delta);
                }
            }
            return;
        }
        if (editing()) {
            edit(event);
            return;
        }
        if (event.key == Key::Back) {
            if (transition == Transition::Exit) {
                transition = Transition::None;
                return;
            }
            back();
            return;
        }
        if (transition == Transition::Exit || saving) {
            return;
        }
        if (current == Page::Home) {
            if (pending_settings || !update.version.empty()) {
                if (update.focused) {
                    if (event.key == Key::Left || event.key == Key::Up) {
                        update.focused = false;
                        if (event.key == Key::Up) {
                            home_selection = int(home_items.size()) - 1;
                        }
                    } else if (event.key == Key::Enter) {
                        start_update();
                    }
                    return;
                }
                if (!update.busy && (event.key == Key::Right ||
                                     (event.key == Key::Down && home_selection == int(home_items.size()) - 1))) {
                    update.focused = true;
                    return;
                }
            }
            navigate(home_selection, event.key, home_items.size(), int(home_items.size()));
            if (event.key == Key::Enter) {
                open_page(home_items[size_t(home_selection)].page);
            }
            return;
        }
        if (current == Page::Status) {
            status_input(event);
            return;
        }
        if (focus.back() == Focus::Sidebar) {
            if (current == Page::Models) {
                int previous_selection = provider_selection;
                provider_view.input(provider_selection, event.key, int(providers.size()), sidebar_visible);
                if (previous_selection != provider_selection) {
                    models.clear();
                    model_rows.reset(models, false);
                    load_models();
                }
                if ((event.key == Key::Enter || event.key == Key::Right) && !provider().null()) {
                    focus.push_back(Focus::List);
                }
                load_stats();
            } else {
                int previous_selection = section_selection;
                section_view.input(section_selection, event.key, int(sections.size()), sidebar_visible);
                if (previous_selection != section_selection) {
                    update_setting_rows();
                    item_selection = 0;
                    setting_rows.clear_view();
                }
                if ((event.key == Key::Enter || event.key == Key::Right) && !section().null()) {
                    focus.push_back(Focus::List);
                }
            }
            return;
        }
        if (event.key == Key::Left && focus.back() == Focus::List && current == Page::Settings) {
            back();
            return;
        }
        if (current == Page::Models) {
            if (focus.back() == Focus::Popup) {
                if (event.key == Key::Enter && !model().null() && model_toggle_allowed(model())) {
                    saving = true;
                    message = "Saving...";
                    request(
                        "models.set",
                        Json::object(
                            {{"provider", provider()["id"]},
                             {"model", model()["model"]},
                             {"enabled", !model()["enabled"].boolean()},
                             {"revision", revision}}
                        ),
                        model()["model"].str()
                    );
                }
            } else {
                model_rows.input(event.key, list_visible);
                if (event.key == Key::Left || event.key == Key::Right) {
                    stats_tab = (stats_tab + (event.key == Key::Left ? STATS_TABS - 1 : 1)) % STATS_TABS;
                }
                if (event.key == Key::Enter) {
                    if (!provider()["detected"].boolean()) {
                        return;
                    }
                    if (!provider()["enabled"].boolean()) {
                        saving = true;
                        message = "Saving...";
                        request(
                            "providers.set",
                            Json::object({{"provider", provider()["id"]}, {"enabled", true}, {"revision", revision}}),
                            provider()["id"].str()
                        );
                    } else if (!model().null()) {
                        focus.push_back(Focus::Popup);
                    }
                }
            }
            load_stats();
        } else {
            Json setting = item();
            auto type = setting["type"].str();
            if (focus.back() == Focus::Popup) {
                if (type == "choice") {
                    auto &options = setting["options"].array();
                    popup_view.input(popup_selection, event.key, int(options.size()), popup_visible);
                    if (event.key == Key::Enter && !options.empty()) {
                        write_setting(setting, at(options, popup_selection)["value"]);
                    }
                } else if (type == "list") {
                    popup_view.input(popup_selection, event.key, int(list_edit.array().size()) + 1, popup_visible);
                    if (event.key == Key::Enter) {
                        auto values = list_edit.array();
                        if (size_t(popup_selection) >= values.size()) {
                            start_editor(setting, true);
                        } else {
                            values.erase(values.begin() + popup_selection);
                            write_setting(setting, std::move(values));
                        }
                    }
                }
            } else {
                setting_rows.input(item_selection, event.key, list_visible);
                if (event.key == Key::Enter && !setting.null()) {
                    if (type == "bool") {
                        write_setting(setting, !setting["value"].boolean());
                    } else if (type == "choice" || type == "list") {
                        popup_selection = 0;
                        popup_view.reset();
                        list_edit = setting["value"];
                        focus.push_back(Focus::Popup);
                        if (type == "choice") {
                            for (size_t option_index = 0; option_index < setting["options"].array().size();
                                 ++option_index) {
                                if (setting["options"].array()[option_index]["value"] == setting["value"]) {
                                    popup_selection = int(option_index);
                                }
                            }
                        }
                    } else {
                        start_editor(setting);
                    }
                }
            }
        }
    }

    std::optional<Gravity> App::mouse_gravity() const {
        if (animations && particles && pointer) {
            Gravity gravity{pointer->x + 0.5, pointer->y * 2.0 + 1.0, logo_boundary};
            if (gravity.boundary.contains(gravity.x, gravity.pixel_y)) {
                return gravity;
            }
        }
        return std::nullopt;
    }

    double App::message_opacity() const {
        return std::clamp(1 - (message_age - message_seconds) / message_fade_seconds, 0.0, 1.0);
    }

    bool App::step(double seconds) {
        bool redraw = scrollbars_moving();
        if (message != shown_message) {
            shown_message = message;
            message_age = 0;
        } else if (!message.empty()) {
            message_age += seconds;
            if (message_age >= message_seconds + (animations ? message_fade_seconds : 0)) {
                message.clear();
                shown_message.clear();
                redraw = true;
            } else if (message_age > message_seconds) {
                redraw = true;
            }
        }
        if (update.busy && !update.restart) {
            update.age += seconds;
            if (update.finished && update.age >= 1) {
                update.restart = true;
            }
        }
        if (current == Page::Status) {
            double &age = status_section == 1 ? helper_age : status_history ? history_age : overview_age;
            redraw = redraw || int(age + seconds) != int(age);
            overview_age += seconds;
            history_age += seconds;
            helper_age += seconds;
            if (status_section == 1) {
                helper_refresh += seconds;
                if (helper_refresh >= 3) {
                    load_helper();
                }
            }
        }
        if (!animations) {
            return redraw;
        }
        clock += seconds;
        elapsed += seconds;
        if (transition == Transition::Exit && elapsed >= home_exit_seconds) {
            enter_page(target);
        } else if (transition == Transition::Enter && elapsed >= page_enter_seconds) {
            transition = Transition::None;
        }
        if (particles) {
            if (seconds > 0.1) {
                particles->clear();
            }
            particles->step(std::min(seconds, 0.1), emitters, clock, mouse_gravity());
        }
        return redraw;
    }
}
