// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>

namespace bf {
    namespace {
        std::string cursor(const Json &row) {
            return std::to_string(row["createdAt"].integer()) + ':' + row["id"].str();
        }

        bool newer(const Json &left, const Json &right) {
            if (left["createdAt"].number() != right["createdAt"].number()) {
                return left["createdAt"].number() > right["createdAt"].number();
            }
            return left["id"].str() > right["id"].str();
        }

        void merge(Json::Array &rows, const Json &row, bool insert) {
            auto found =
                std::find_if(rows.begin(), rows.end(), [&](const Json &entry) { return entry["id"] == row["id"]; });
            if (found != rows.end()) {
                *found = row;
            } else if (insert) {
                rows.push_back(row);
            }
        }
    }

    int App::tick_timeout_ms() const {
        int timeout = scrollbars_moving() ? 16 : INT32_MAX;
        if (!message.empty()) {
            // Wake when the message should start fading, then each frame while it fades.
            double left = message_seconds - message_age;
            timeout = std::min(timeout, left > 0 ? int(std::ceil(left * 1000)) : 33);
        }
        if (update.finished && !update.restart) {
            return std::max(1, std::min(timeout, int(std::ceil((1 - update.age) * 1000))));
        }
        if (current != Page::Status) {
            return std::max(1, timeout);
        }
        double age = status_section == 1 ? helper_age : status_history ? history_age : overview_age;
        double seconds = 1 - (age - std::floor(age));
        if (status_section == 1) {
            seconds = std::min(seconds, std::max(0.001, 3 - helper_refresh));
        }
        return std::max(1, std::min(timeout, int(std::ceil(seconds * 1000))));
    }

    void App::load_overview() {
        loading_subagents = true;
        request("subagents.overview");
    }

    void App::reset_history(bool oldest) {
        ++history_generation;
        paging_before = paging_after = false;
        history_top = !oldest;
        history_before = history_after = false;
        history = Json{};
        history_offset = 0;
        history_total = -1;
        history_newer_ids.clear();
        history_resume = Json{};
        history_rows.reset(history, true, false);
        loading_history = true;
        Json params = Json::object({{"limit", std::clamp(2 * list_visible, 2, 500)}});
        if (oldest) {
            params["oldest"] = true;
        }
        request("subagents.page", params, std::to_string(history_generation) + ":initial");
        sync_subagents();
    }

    void App::load_history(std::string direction) {
        const auto &rows = history["rows"].array();
        bool before = direction == "before";
        bool &pending = before ? paging_before : paging_after;
        if (pending || loading_history || rows.empty()) {
            return;
        }
        pending = true;
        request(
            "subagents.page",
            Json::object(
                {{"limit", std::clamp(2 * list_visible, 2, 500)},
                 {direction, cursor(before ? rows.back() : rows.front())}}
            ),
            std::to_string(history_generation) + ':' + direction
        );
    }

    void App::restore_history(Key key) {
        if (loading_history || !history_rows.selection()) {
            return;
        }
        if ((key == Key::Up && history_selection_offset == 0) ||
            (key == Key::Down && history_total >= 0 && history_selection_offset == history_total - 1)) {
            reset_history(key == Key::Up);
            return;
        }
        history_resume = history_rows.selection()->agent;
        history_move = key;
        ++history_generation;
        paging_before = paging_after = false;
        loading_history = true;
        bool newer_rows = key == Key::Up || key == Key::PageUp;
        request(
            "subagents.page",
            Json::object(
                {{"limit", std::clamp(2 * list_visible, 2, 500)},
                 {newer_rows ? "after" : "before", cursor(history_resume)}}
            ),
            std::to_string(history_generation) + ":selection"
        );
    }

    void App::trim_history() {
        if (history_rows.selected_row() >= 0) {
            history_selection_offset = history_offset;
            for (int index = 0; index < history_rows.selected_row(); ++index) {
                if (!history_rows.rows()[size_t(index)].agent.null()) {
                    ++history_selection_offset;
                }
            }
        }
        const auto &loaded = history["rows"].array();
        size_t cap = size_t(std::max(std::clamp(10 * list_visible, 20, 500), 3 * list_visible + 10));
        if (loaded.size() <= cap) {
            return;
        }
        auto rows = loaded;
        int first = history_rows.first_row(list_visible);
        const auto &entries = history_rows.rows();
        int begin = 0, end = 0;
        bool found = false;
        for (int index = first; index < int(entries.size()) && index < first + list_visible; ++index) {
            const Json &agent = entries[size_t(index)].agent;
            if (agent.null()) {
                continue;
            }
            auto at = std::find_if(rows.begin(), rows.end(), [&](const Json &row) { return row["id"] == agent["id"]; });
            int position = int(at - rows.begin());
            if (!found) {
                begin = position;
                found = true;
            }
            end = position;
        }
        int start =
            std::clamp(begin - int(cap) / 3, std::max(0, end + 1 - int(cap)), std::min(begin, int(rows.size() - cap)));
        if (start > 0) {
            history_offset += start;
            history_top = false;
            history_after = true;
        }
        if (size_t(start) + cap < rows.size()) {
            history_before = true;
        }
        history["rows"] = Json::Array(rows.begin() + start, rows.begin() + start + std::ptrdiff_t(cap));
        history_rows.reset(history, true);
    }

    void App::receive_history(const Json &result, const Json &params, const std::string &context, bool error) {
        if (current != Page::Status || !status_history ||
            !context.starts_with(std::to_string(history_generation) + ':')) {
            return;
        }
        bool initial = context.ends_with(":initial");
        bool before = !params["before"].null();
        bool restoring = context.ends_with(":selection");
        if (initial || restoring) {
            loading_history = false;
        } else {
            (before ? paging_before : paging_after) = false;
        }
        if (error) {
            return;
        }
        if (restoring) {
            if (history_total >= 0 && !result["total"].null()) {
                history_selection_offset += std::max(0, int(result["total"].integer()) - history_total);
            }
            auto rows = result["rows"].array();
            int count = int(rows.size());
            merge(rows, history_resume, true);
            std::stable_sort(rows.begin(), rows.end(), newer);
            history = result;
            history["rows"] = std::move(rows);
            if (!result["total"].null()) {
                history_total = int(result["total"].integer());
            }
            history_offset = std::max(0, history_selection_offset - (before ? 0 : count));
            history_before = before ? result["more"].boolean() : history_selection_offset + 1 < history_total;
            history_after = before ? history_offset > 0 : result["more"].boolean();
            history_top = !history_after;
            history_rows.reset(history, true);
            history_rows.input(history_move, list_visible);
            history_resume = Json{};
        } else if (initial) {
            history = result;
            history_total = result["total"].null() ? -1 : int(result["total"].integer());
            history_offset =
                params["oldest"].boolean() ? std::max(0, history_total - int(result["rows"].array().size())) : 0;
            history_top = !params["oldest"].boolean() || !result["more"].boolean();
            history_before = !params["oldest"].boolean() && result["more"].boolean();
            history_after = params["oldest"].boolean() && result["more"].boolean();
            history_rows.reset(history, true, false);
            if (params["oldest"].boolean()) {
                history_rows.input(Key::End, list_visible);
            }
        } else {
            auto rows = history["rows"].array();
            const Json &boundary = before ? params["before"] : params["after"];
            if (std::none_of(rows.begin(), rows.end(), [&](const Json &row) {
                    return cursor(row) == boundary.str();
                })) {
                sync_subagents();
                return;
            }
            if (history_total >= 0 && !result["total"].null()) {
                int added = std::max(0, int(result["total"].integer()) - history_total);
                history_offset += added;
                if (history_rows.selected_row() < 0) {
                    history_selection_offset += added;
                }
                if (added && history_top) {
                    history_top = false;
                    history_after = true;
                }
            }
            for (const Json &row : result["rows"].array()) {
                merge(rows, row, true);
            }
            if (!before) {
                history_offset = std::max(0, history_offset - int(rows.size() - history["rows"].array().size()));
            }
            if (!result["total"].null()) {
                history_total = int(result["total"].integer());
            }
            std::stable_sort(rows.begin(), rows.end(), newer);
            history["rows"] = std::move(rows);
            if (before) {
                history_before = result["more"].boolean();
                if (!history_before && history_total >= 0) {
                    history_offset = std::max(0, history_total - int(history["rows"].array().size()));
                }
            } else {
                history_after = result["more"].boolean();
                history_top = !history_after;
                if (history_top) {
                    history_offset = 0;
                }
            }
            history["now"] = result["now"];
            history_rows.reset(history, true);
        }
        history_age = 0;
        trim_history();
        sync_subagents();
    }

    void App::sync_subagents() {
        if (current != Page::Status || status_section != 0 || !subagents_visible) {
            return;
        }
        if (status_history && !history.null()) {
            trim_history();
        }
        SubagentList &list = status_history ? history_rows : overview_rows;
        const Json &data = status_history ? history : overview;
        if (data.null() && !subagents_watched) {
            return;
        }
        int first = list.first_row(list_visible);
        const auto &entries = list.rows();
        Json::Array ids;
        // Rows on screen were loaded at different times, so only the oldest change is safe to start from.
        std::optional<int64_t> since;
        if (!data.null()) {
            for (int index = first; index < int(entries.size()) && index < first + list_visible; ++index) {
                const Json &row = entries[size_t(index)].agent;
                if (!row.null()) {
                    ids.push_back(row["id"]);
                    since = std::min(since.value_or(INT64_MAX), row["changedAt"].integer());
                }
            }
        }
        Json params = Json::object({{"ids", ids}, {"since", since.value_or(0)}});
        if (!status_history) {
            params["overview"] = true;
        } else if (history_top) {
            params["top"] = history["rows"].array().empty() ? "0:" : cursor(history["rows"].array().front());
        }
        if (!subagents_watched || watched_subagents != params) {
            watched_subagents = params;
            subagents_watched = true;
            request("subagents.watch", params);
        }
        if (status_history && !loading_history) {
            first = list.first_row(list_visible);
            if (history_before && first + 2 * list_visible >= int(list.rows().size())) {
                load_history("before");
            }
            if (history_after && first < list_visible) {
                load_history("after");
            }
        }
    }

    void App::changed_subagents(const Json &params) {
        auto running = overview["running"].array(), recent = overview["recent"].array();
        if (!params["recent"].null()) {
            recent = params["recent"].array();
        }
        for (const Json &row : params["rows"].array()) {
            auto erase = [&](Json::Array &rows) {
                std::erase_if(rows, [&](const Json &entry) { return entry["id"] == row["id"]; });
            };
            bool was_running = std::any_of(running.begin(), running.end(), [&](const Json &entry) {
                return entry["id"] == row["id"];
            });
            if (row["running"].boolean()) {
                erase(recent);
                merge(running, row, true);
            } else {
                erase(running);
                if (was_running) {
                    erase(recent);
                    recent.insert(recent.begin(), row);
                } else {
                    merge(recent, row, false);
                }
            }
        }
        overview["running"] = std::move(running);
        recent.resize(std::min(size_t(10), recent.size()));
        overview["recent"] = std::move(recent);
        overview["now"] = params["now"];
        overview_age = 0;
        overview_rows.reset(overview, false);
        if (status_history && !history.null()) {
            bool at_top = history_rows.first_index() == 0;
            auto rows = history["rows"].array();
            for (const Json &row : params["rows"].array()) {
                merge(rows, row, false);
            }
            bool inserted = false;
            int added = 0;
            for (const Json &row : params["newer"].array()) {
                bool known =
                    std::any_of(rows.begin(), rows.end(), [&](const Json &entry) { return entry["id"] == row["id"]; });
                if (!known && history_newer_ids.insert(row["id"].str()).second) {
                    ++added;
                }
                if (history_top) {
                    size_t count = rows.size();
                    merge(rows, row, true);
                    inserted = inserted || rows.size() != count;
                }
            }
            if (!history_top) {
                history_offset += added;
            }
            if (history_total >= 0) {
                history_total += added;
            }
            if (history_rows.selected_row() < 0) {
                history_selection_offset += added;
            }
            std::stable_sort(rows.begin(), rows.end(), newer);
            history["rows"] = std::move(rows);
            history["now"] = params["now"];
            history_age = 0;
            history_rows.reset(history, true, !(at_top && inserted));
            trim_history();
        }
        sync_subagents();
    }

    void App::load_helper() {
        helper_refresh = 0;
        if (!loading_helper) {
            loading_helper = true;
            request("status.get");
        }
    }

    void App::unwatch_subagents() {
        if (subagents_watched) {
            subagents_watched = false;
            watched_subagents = Json{};
            request("unwatch", Json::object({{"what", "subagents"}}));
        }
    }

    void App::stop() {
        unwatch_subagents();
        unwatch_stats();
        running = false;
    }

    void App::status_input(const Input &event) {
        if (focus.back() == Focus::Sidebar) {
            int previous = status_section;
            status_view.input(status_section, event.key, 3, sidebar_visible);
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
            if (event.key == Key::Enter || event.key == Key::Right) {
                focus.push_back(Focus::List);
            }
            return;
        }
        if (event.key == Key::Left) {
            back();
            return;
        }
        if (status_section == 1) {
            helper_rows.input(helper_selection, event.key, list_visible);
            return;
        }
        if (status_section == 2) {
            about_input(event);
            return;
        }
        SubagentList &rows = status_history ? history_rows : overview_rows;
        if (rows.resume_visible(event.key, list_visible)) {
            sync_subagents();
            return;
        }
        if (status_history && (event.key == Key::Home || event.key == Key::End)) {
            reset_history(event.key == Key::End);
            return;
        }
        if (status_history && rows.selected_row() < 0 && rows.selection() && list_navigation(event.key)) {
            restore_history(event.key);
            return;
        }
        if (status_history && !loading_history && !history["rows"].array().empty()) {
            const SubagentRow *selected = rows.selection();
            if (selected && event.key == Key::Down && !history_before &&
                selected->agent["id"] == history["rows"].array().back()["id"]) {
                reset_history();
                return;
            }
            if (selected && event.key == Key::Up && history_top &&
                selected->agent["id"] == history["rows"].array().front()["id"]) {
                reset_history(true);
                return;
            }
        }
        rows.input(event.key, list_visible);
        const SubagentRow *selected = rows.selection();
        if (event.key == Key::Enter && selected && selected->see_all) {
            status_history = true;
            reset_history();
        }
        sync_subagents();
    }
}
