// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app.hpp"
#include <algorithm>

namespace bf {
    bool App::mouse(std::optional<MousePosition> position) {
        auto previous = pointer ? hits.at(*pointer) : std::nullopt;
        pointer = mouse_enabled ? position : std::nullopt;
        auto next = pointer ? hits.at(*pointer) : std::nullopt;
        return bool(previous) != bool(next) ||
               (previous && next && (previous->kind != next->kind || previous->index != next->index));
    }

    bool App::mouse_input(const MouseEvent &event) {
        if (!mouse_enabled || transition == Transition::Exit) {
            return false;
        }
        pointer = event.position;
        bool wheel = event.kind == MouseKind::Wheel;
        auto now = std::chrono::steady_clock::now();
        bool repeated = !wheel && last_click == event.position && now - clicked_at < std::chrono::milliseconds(350);
        if (repeated && click_activated) {
            return false;
        }
        auto target = hits.at(event.position, wheel);
        if (repeated && !click_activated && clicked_target && clicked_page == current &&
            (clicked_target->kind == HitKind::Model || clicked_target->kind == HitKind::Setting ||
             clicked_target->kind == HitKind::Subagent)) {
            target = clicked_target;
        }
        if (!target) {
            if (!wheel) {
                last_click.reset();
            }
            return false;
        }
        if (target->kind == HitKind::Back) {
            last_click.reset();
            input({Key::Back, {}});
            return true;
        }
        if (target->kind == HitKind::Controls) {
            last_click.reset();
            if (wheel) {
                scroll_controls(3 * event.delta);
            } else {
                input({Key::Controls, {}});
            }
            return true;
        }
        if (saving || helper_missing) {
            return false;
        }
        if (wheel) {
            last_click.reset();
            int delta = 3 * event.delta;
            switch (target->kind) {
            case HitKind::Provider:
                provider_view.scroll(delta, int(providers.size()), sidebar_visible);
                break;
            case HitKind::Section:
                section_view.scroll(delta, int(sections.size()), sidebar_visible);
                break;
            case HitKind::StatusSection:
                status_view.scroll(delta, 3, sidebar_visible);
                break;
            case HitKind::PopupRow:
                scroll_popup(delta);
                break;
            case HitKind::Model:
            case HitKind::Setting:
            case HitKind::Subagent:
            case HitKind::Helper:
            case HitKind::Link:
                scroll_main(delta);
                break;
            default:
                return false;
            }
            return true;
        }
        bool double_click = repeated;
        last_click = event.position;
        clicked_at = now;
        clicked_target = target;
        clicked_page = current;
        click_activated = false;
        auto sidebar = [&] {
            focus = {Focus::Home, Focus::Sidebar};
        };
        auto list = [&] {
            focus = {Focus::Home, Focus::Sidebar, Focus::List};
        };
        auto position = [&](int count) {
            return count <= 0 ? 0 : std::clamp(target->index, 0, count - 1);
        };
        auto activate = [&] {
            input({Key::Enter, {}});
            click_activated = true;
        };
        if (editing() && target->kind != HitKind::Editor && target->kind != HitKind::Activate) {
            back();
        }
        switch (target->kind) {
        case HitKind::Home:
            update.focused = false;
            home_selection = target->index;
            activate();
            break;
        case HitKind::Update:
            update.focused = true;
            start_update();
            click_activated = true;
            break;
        case HitKind::Provider: {
            int previous = provider_selection;
            sidebar();
            provider_selection = position(int(providers.size()));
            if (previous != provider_selection) {
                models.clear();
                model_rows.reset(models, false);
                load_models();
            }
            load_stats();
            break;
        }
        case HitKind::Section: {
            int previous = section_selection;
            sidebar();
            section_selection = position(int(sections.size()));
            if (previous != section_selection) {
                update_setting_rows();
                item_selection = 0;
                setting_rows.clear_view();
            }
            break;
        }
        case HitKind::StatusSection: {
            int previous = status_section;
            sidebar();
            status_section = position(3);
            if (previous != status_section) {
                status_history = false;
                if (status_section != 0) {
                    unwatch_subagents();
                    subagents_visible = false;
                }
                if (status_section == 1) {
                    helper_selection = 0;
                    helper_rows.clear_view();
                    load_helper();
                }
                if (status_section == 2) {
                    about_selection = 0;
                    about_following = true;
                }
            }
            break;
        }
        case HitKind::Model: {
            bool selected = model_rows.selected_row() == target->index;
            if (!model_rows.select(target->index)) {
                return false;
            }
            list();
            if (selected || double_click) {
                activate();
            }
            load_stats();
            break;
        }
        case HitKind::Setting: {
            bool selected = item_selection == target->index;
            list();
            item_selection = position(int(visible_items().size()));
            if (selected || double_click) {
                activate();
            }
            break;
        }
        case HitKind::Subagent: {
            SubagentList &rows = status_history ? history_rows : overview_rows;
            bool selected = rows.selected_row() == target->index;
            if (!rows.select(target->index)) {
                return false;
            }
            list();
            if (selected || double_click) {
                activate();
            }
            sync_subagents();
            break;
        }
        case HitKind::Helper:
            list();
            break;
        case HitKind::Link:
            list();
            about_selection = target->index;
            activate();
            break;
        case HitKind::PopupRow: {
            Json setting = item();
            int count = setting["type"].str() == "list" ? int(list_edit.array().size()) + 1
                                                        : int(setting["options"].array().size());
            popup_selection = position(count);
            activate();
            break;
        }
        case HitKind::ModelAction:
        case HitKind::Activate:
            activate();
            break;
        case HitKind::EnableProvider:
            list();
            activate();
            break;
        case HitKind::StatsTab:
            stats_tab = target->index;
            break;
        case HitKind::Editor:
            editor.click(event.position.x - target->rect.x, target->rect.width);
            break;
        case HitKind::Back:
        case HitKind::Controls:
            break;
        }
        return true;
    }
}
