// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "fx/particles.hpp"
#include "fx/transition.hpp"
#include "rpc/json.hpp"
#include "term/gamepad.hpp"
#include "term/input.hpp"
#include "ui/editor.hpp"
#include "ui/grouped_list.hpp"
#include "ui/hit.hpp"
#include "ui/list.hpp"
#include "ui/model_list.hpp"
#include "ui/scrollbar.hpp"
#include "ui/subagent_list.hpp"
#include <array>
#include <functional>
#include <map>
#include <memory>
#include <set>

namespace bf {
    enum class Page { Home, Models, Settings, Status };
    struct HomeItem {
        std::string_view label;
        Page page;
    };
    inline constexpr std::array<HomeItem, 3> home_items{
        {{"Models", Page::Models}, {"Settings", Page::Settings}, {"Status", Page::Status}}
    };
    enum class Focus { Home, Sidebar, List, Popup, Editor };
    class App {
        struct Request {
            std::string method, context;
            Json params;
            bool quiet = false;
        };
        std::function<void(const Json &)> send;
        std::function<bool(const std::string &)> opener;
        std::map<int64_t, Request> requests;
        std::map<std::string, int64_t> latest;
        int64_t next_id = 1;
        Json::Array providers, models, sections;
        Json::Array setting_items;
        std::map<std::string, std::map<std::string, Json>> provider_stats;
        std::string stats_provider, stats_model;
        bool stats_visible = false;
        std::vector<Focus> focus{Focus::Home};
        std::string revision, message, discovery_error;
        // A status message shows for a while, then fades; shown_message notices when it changes.
        static constexpr double message_seconds = 5, message_fade_seconds = 0.5;
        std::string shown_message;
        double message_age = 0;
        double message_opacity() const;
        int home_selection = 0, provider_selection = 0;
        struct UpdateStep {
            std::string label, detail;
            // running, done, note, warn or fail, as install.sh reports them.
            std::string state = "running";
        };
        struct Update {
            bool checked = false, focused = false, busy = false, finished = false, restart = false, failed = false;
            std::string version;
            std::vector<UpdateStep> steps;
            double age = 0;
        } update;
        bool pending_settings = false;
        struct Configuration {
            bool open = false, busy = false, committing = false;
            int step = 0, option = 0, direction = 0, generation = 0;
            int first = 0, visible = 1;
            Json::Array steps;
            ListView option_view;
            Json answers = Json::Object{};
            std::string revision, error;
        } configuration;
        void start_configuration();
        void configuration_input(const Input &);
        void configuration_move(int direction);
        void receive_configuration(const std::string &method, const std::string &context, const Json &reply);
        void draw_configuration(Grid &);
        ModelList model_rows;
        int section_selection = 0, item_selection = 0, popup_selection = 0;
        GroupedList setting_rows, helper_rows;
        ListView provider_view, section_view, status_view, popup_view;
        int stats_tab = 0, sidebar_visible = 1, list_visible = 1, popup_visible = 1;
        static constexpr int STATS_TABS = 4;
        bool loading_models = false, loading_settings = false, saving = false, running = true;
        bool helper_missing = false;
        int status_section = 0, helper_selection = 0, about_selection = 0;
        int about_first = 0;
        int about_total = 0;
        std::vector<int> about_link_rows;
        bool about_following = true;
        bool status_history = false, subagents_watched = false;
        bool subagents_visible = false;
        bool loading_subagents = false, loading_history = false, loading_helper = false;
        Json overview, history, helper, about;
        std::optional<Grid> about_canvas;
        Json watched_subagents;
        int history_generation = 0;
        int history_offset = 0, history_total = -1;
        int history_selection_offset = 0;
        Json history_resume;
        Key history_move = Key::Down;
        std::set<std::string> history_newer_ids;
        bool history_top = true, history_before = false, history_after = false;
        bool paging_before = false, paging_after = false;
        SubagentList overview_rows, history_rows;
        double overview_age = 0, history_age = 0, helper_age = 0, helper_refresh = 0;
        double helper_now = 0;
        bool animations;
        bool mouse_enabled;
        HitMap hits;
        std::optional<MousePosition> last_click;
        std::optional<Hit> clicked_target;
        Page clicked_page = Page::Home;
        std::chrono::steady_clock::time_point clicked_at{};
        bool click_activated = false;
        Page current = Page::Home, target = Page::Home;
        Transition transition = Transition::None;
        double elapsed = 0, clock = 0;
        std::map<std::string, ScrollMotion> scroll_motions;
        bool scrollbars_moving() const;
        int draw_scrollbar(
            Grid &,
            std::string key,
            int x,
            int y,
            int width,
            int height,
            int total,
            int first,
            int visible,
            bool inside = false
        );
        std::string edit_key, edit_type;
        TextEditor editor;
        Json list_edit;
        bool adding_list = false;
        bool controls_open = false;
        int controls_first = 0, controls_visible = 1;
        std::optional<GamepadInfo> controller;
        std::string controls_hint() const;
        std::vector<std::pair<std::string, std::string>> control_mappings() const;
        void draw_controls(Grid &);
        void scroll_controls(int delta);
        std::unique_ptr<Particles> particles;
        std::vector<Emitter> emitters;
        std::optional<MousePosition> pointer;
        ClipRegion logo_boundary;
        int64_t request(std::string method, Json params = Json::Object{}, std::string context = {}, bool quiet = false);
        void reload();
        void load_models(bool refresh = false);
        void load_stats(bool refresh = false);
        void unwatch_stats();
        void open_page(Page);
        void enter_page(Page);
        void back();
        void write_setting(const Json &, Json value);
        void start_editor(const Json &, bool add = false);
        void edit(const Input &);
        const Json &provider() const;
        const Json &model() const;
        const Json &section() const;
        const Json::Array &visible_items() const;
        void update_setting_rows();
        Json item() const;
        void draw_home(Grid &, double opacity = 1, bool leaving = false);
        void draw_update(Grid &, int menu_width, double opacity);
        void start_update();
        bool receive_update(const Json &);
        void draw_models(Grid &);
        void draw_settings(Grid &);
        void draw_models_popup(Grid &);
        void draw_model_stats(Grid &, int x, int y, int width, int height);
        void draw_settings_popup(Grid &);
        void draw_status(Grid &);
        void draw_subagents(Grid &, int x, int width, int rows);
        void draw_helper(Grid &, int x, int width, int rows);
        void draw_about(Grid &, int x, int width, int rows);
        void about_input(const Input &);
        void scroll_main(int delta);
        void scroll_popup(int delta);
        void open_about_link(int index);
        void status_input(const Input &);
        void load_overview();
        void load_helper();
        void unwatch_subagents();
        void sync_subagents();
        void reset_history(bool oldest = false);
        void restore_history(Key key);
        void load_history(std::string direction = {});
        void receive_history(const Json &, const Json &, const std::string &, bool error);
        void changed_subagents(const Json &);
        void trim_history();

      public:
        explicit App(
            std::function<void(const Json &)> sender,
            bool animations = true,
            bool mouse = true,
            bool resume = false,
            std::string message = {},
            std::function<bool(const std::string &)> link_opener = {}
        );
        void start();
        void presented();
        std::string restart_version() const {
            return update.restart && !update.failed ? update.version : "";
        }
        void restart_failed();
        void receive(const Json &);
        void input(const Input &);
        bool step(double dt);
        void stop();
        bool needs_tick() const {
            return scrollbars_moving() || current == Page::Status || (update.finished && !update.restart) ||
                   !message.empty();
        }
        int tick_timeout_ms() const;
        void render(Grid &);
        bool mouse(std::optional<MousePosition> position);
        bool mouse_input(const MouseEvent &event);
        std::optional<Gravity> mouse_gravity() const;
        bool mouse_reporting() const {
            return mouse_enabled;
        }
        void error(std::string text) {
            helper_missing = text == "BitFrost helper not found";
            message = std::move(text);
        }
        bool alive() const {
            return running;
        }
        bool editing() const {
            return focus.back() == Focus::Editor;
        }
        bool text_input() const {
            return editing() && !controls_open;
        }
        bool controls_shown() const {
            return controls_open;
        }
        bool set_controller(std::optional<GamepadInfo> info);
        bool particles_active() const {
            return bool(particles);
        }
        Page page() const {
            return current;
        }
        Focus focused() const {
            return focus.back();
        }
        std::string status() const {
            return message;
        }
    };
    int selftest();
}
