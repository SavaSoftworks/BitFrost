// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "ui/format.hpp"
#include <algorithm>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        double local_day(double now, int days) {
            time_t time = time_t(now / 1000);
            tm day{};
            localtime_r(&time, &day);
            day.tm_mday -= days;
            day.tm_hour = day.tm_min = day.tm_sec = 0;
            day.tm_isdst = -1;
            return double(std::mktime(&day)) * 1000;
        }

        std::string text(const Grid &grid, bool selected = false) {
            std::string result;
            for (int y = 2; y < grid.height - 5; ++y) {
                for (int x = 27; x < grid.width - 2; ++x) {
                    const Cell &cell = grid.cells[size_t(y * grid.width + x)];
                    result += !selected || (cell.fg == black && cell.bg != black) ? cell.glyph : " ";
                }
            }
            return result;
        }
    }

    void status_selftest() {
        const char *environment = std::getenv("TZ");
        std::string original_zone = environment ? environment : "";
        bool had_zone = environment;
        setenv("TZ", "America/Halifax", 1);
        tzset();
        for (int month : {2, 10}) {
            tm time{};
            time.tm_year = 126;
            time.tm_mon = month;
            time.tm_mday = month == 2 ? 9 : 2;
            time.tm_hour = 12;
            time.tm_isdst = -1;
            double now = double(std::mktime(&time)) * 1000;
            for (int day : {0, 1, 6, 13}) {
                double boundary = local_day(now, day);
                int group = day == 0 ? 0 : day == 1 ? 1 : day == 6 ? 2 : 3;
                require(subagent_group(boundary, now) == group, "History includes exact local day boundaries");
                require(
                    subagent_group(boundary - 1, now) == group + 1,
                    "History excludes the millisecond before local day boundaries across DST"
                );
            }
        }
        if (had_zone) {
            setenv("TZ", original_zone.c_str(), 1);
        } else {
            unsetenv("TZ");
        }
        tzset();
        double now = double(std::time(nullptr)) * 1000;
        auto agent = [&](std::string id, double created, bool running) {
            return Json::object(
                {{"id", id},
                 {"title", id},
                 {"agent", "reviewer"},
                 {"model", "gpt-6.1-sol"},
                 {"harnessName", "Codex"},
                 {"running", running},
                 {"createdAt", created},
                 {"closedAt", running ? Json{} : Json(created + 17000)},
                 {"tokens", 256200},
                 {"toolCalls", 12}}
            );
        };
        Json first = agent("Status build", now - 17000, true);
        Json second = agent("Fallback title", now - 20000, true);
        second["title"] = nullptr;
        Json::Array earlier;
        for (int day : {0, 1, 3, 9, 20}) {
            earlier.push_back(agent("Earlier " + std::to_string(day), local_day(now, day), false));
        }
        Json overview = Json::object({{"now", now}, {"running", Json::Array{first, second}}, {"recent", earlier}});
        Json::Array all = earlier;
        all.insert(all.begin(), {first, second});
        Json history = Json::object({{"now", now}, {"rows", all}, {"total", int(all.size())}});
        SubagentList list;
        list.reset(overview, false, false);
        require(
            list.selected_row() == 1 && list.selection()->agent["id"] == first["id"],
            "Overview skips Running header"
        );
        list.input(Key::Up, 3);
        require(list.selection()->see_all, "Overview wraps to See all");
        list.input(Key::Down, 3);
        list.input(Key::PageDown, 3);
        require(list.selected_row() == 5, "Subagent page navigation skips Recent header and blank row");
        list.input(Key::PageUp, 3);
        require(list.selected_row() == 2, "Subagent Page Up moves by visible rows and skips separators");
        list.input(Key::Home, 3);
        list.input(Key::Down, 3);
        Json updated = overview;
        updated["running"] = Json::Array{agent("New arrival", now, true), first, second};
        list.reset(updated, false);
        require(
            list.selection()->agent["id"] == second["id"] && list.selected_row() == 3,
            "Live overview preserves selection by id after insertion"
        );
        require(
            list.first_row(2) <= list.selected_row() && list.first_row(2) + 2 > list.selected_row(),
            "Live overview keeps selection visible"
        );
        list.reset(history, true, false);
        for (size_t row = 1; row < list.rows().size(); ++row) {
            const auto &entry = list.rows()[row];
            if (!entry.title.empty()) {
                require(
                    list.rows()[row - 1].title.empty() && list.rows()[row - 1].agent.null() &&
                        !list.rows()[row - 1].selectable(),
                    "History segments have a nonselectable blank separator"
                );
            }
        }
        for (std::string_view heading : {"Today", "Yesterday", "Last 7 days", "Last 14 days", "Older"}) {
            require(
                std::count_if(
                    list.rows().begin(),
                    list.rows().end(),
                    [&](const SubagentRow &row) { return row.title == heading; }
                ) == 1,
                "History includes each nonempty segment once"
            );
        }
        list.input(Key::End, 3);
        require(list.selection()->agent["id"].str() == "Earlier 20", "History End selects oldest row");
        list.input(Key::Down, 3);
        require(list.selection()->agent["id"].str() == "Earlier 20", "History stops at the loaded edge");
        list.reset(Json::object({{"now", now}, {"rows", Json::Array{}}}), true, false);
        require(list.rows().empty() && !list.selection(), "Empty history hides empty segments");
        list.reset(Json::object({{"now", now}}), false, false);
        require(
            list.rows()[1].title == "None running" && list.selection()->see_all,
            "Empty overview skips None running and selects See all"
        );
        require(
            list.rows()[2].title.empty() && !list.rows()[2].selectable() &&
                list.rows()[list.rows().size() - 2].title.empty() && !list.rows()[list.rows().size() - 2].selectable(),
            "Overview separates Running, Recent and See all with blank nonselectable rows"
        );
        require(
            subagent_duration(first, now + 1000) == 18000 && subagent_duration(earlier[0], now + 1000) == 17000 &&
                elapsed_time(62000) == "1:02" && elapsed_time(3721000) == "1:02:01",
            "Durations tick only while open and show seconds"
        );
        Json working = Json::parse(R"({"createdAt":0,"activeMs":30000,"turnStartedAt":null,"closedAt":null})");
        require(subagent_duration(working, 999999) == 30000, "A finished turn's working time holds still");
        working["turnStartedAt"] = 990000.0;
        require(subagent_duration(working, 999999) == 39999, "A new turn counts on from the stored working time");
        require(
            elapsed_time(86399000) == "23:59:59" && elapsed_time(86400000) == "1d 0:00" &&
                elapsed_time(87777000) == "1d 0:22" && elapsed_time(176520000) == "2d 1:02",
            "Day durations show days then hours and minutes"
        );
        require(
            listed_age(161000) == "listed 2m 41s ago" && listed_age(0) == "listed 0s ago",
            "Registry age uses readable units"
        );
        require(
            middle_ellipsis("/home/nick/very/long/application/bin/codex", 24).starts_with("/home/") &&
                middle_ellipsis("/home/nick/very/long/application/bin/codex", 24).ends_with("codex") &&
                text_width(middle_ellipsis("/home/nick/very/long/application/bin/codex", 24)) == 24,
            "App paths retain the start and filename within the available width"
        );

        App animated([](const Json &) {}, true);
        animated.input({Key::End, {}});
        animated.input({Key::Enter, {}});
        animated.step(0.5);
        require(
            animated.page() == Page::Status && !animated.particles_active(),
            "Animated Status holds no particle pool"
        );
        animated.stop();

        std::deque<Json> pending;
        std::vector<Json> sent;
        App app(
            [&](const Json &request) {
                pending.push_back(request);
                sent.push_back(request);
            },
            false
        );
        auto pump = [&] {
            while (!pending.empty()) {
                Json request = pending.front();
                pending.pop_front();
                Json result;
                std::string method = request["method"].str();
                if (method == "subagents.overview") {
                    result = overview;
                } else if (method == "subagents.page") {
                    result = history;
                    result["more"] = false;
                } else if (method == "status.get") {
                    result = Json::object(
                        {{"version", "0.9.1"},
                         {"pid", 4242},
                         {"startedAt", now - 7200000},
                         {"socket", "/tmp/fake.sock"},
                         {"config", "/tmp/fake.json"},
                         {"configError", "Invalid config sample"},
                         {"registryAt", now - 161000},
                         {"providers",
                          Json::Array{
                              Json::object({{"id", "codex"}, {"location", "/usr/bin/codex"}, {"models", 7}}),
                              Json::object({{"id", "zcode"}, {"location", "/opt/zcode"}, {"models", 8}}),
                              Json::object({{"id", "opencode"}, {"location", "/opt/opencode"}, {"models", 9}}),
                              Json::object({{"id", "omp"}, {"location", "/opt/omp"}, {"models", 10}}),
                              Json::object({{"id", "gemini"}, {"location", "/opt/gemini"}, {"models", 11}}),
                              Json::object({{"id", "crush"}, {"location", "/opt/crush"}, {"models", 12}})
                          }},
                         {"leases",
                          Json::Array{
                              Json::object({{"host", "workstation"}, {"profile", "nick"}, {"expiresInMs", 62000}})
                          }}}
                    );
                } else {
                    result = Json::object({{"ok", true}});
                }
                app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
            }
        };
        auto key = [&](Key key) {
            app.input({key, {}});
        };
        auto count = [&](std::string_view method) {
            return std::count_if(sent.begin(), sent.end(), [&](const Json &request) {
                return request["method"] == Json(std::string(method));
            });
        };
        key(Key::End);
        key(Key::Enter);
        Grid loading(120, 40);
        app.render(loading);
        require(
            text(loading).find("Loading sessions...") != std::string::npos &&
                text(loading).find("Sessions") != std::string::npos,
            "Status uses Sessions in its title and loading text"
        );
        pump();
        require(
            app.page() == Page::Status && !app.particles_active() && count("subagents.overview") == 1,
            "Home enters Status and starts overview watch without particles"
        );
        key(Key::Enter);
        Grid grid(120, 40);
        app.render(grid);
        pump();
        require(
            text(grid, true).find("Status build") != std::string::npos &&
                text(grid).find("reviewer") != std::string::npos,
            "Overview table selects first running row and falls back to agent name"
        );
        require(app.step(1) && !app.step(0.1), "Static Status redraws on second boundaries");
        require(
            app.tick_timeout_ms() >= 899 && app.tick_timeout_ms() <= 901,
            "Static Status wakes at the next second boundary"
        );
        app.render(grid);
        require(text(grid).find("18s") != std::string::npos, "Duration uses broker now and local elapsed seconds");
        app.receive(
            Json::object(
                {{"method", "subagents.changed"},
                 {"params",
                  Json::object(
                      {{"now", now},
                       {"rows", Json::Array{updated["running"].array().front()}},
                       {"newer", Json::Array{}}}
                  )}}
            )
        );
        app.render(grid);
        require(
            text(grid, true).find("Status build") != std::string::npos,
            "App live update preserves selected subagent"
        );
        Json fast = agent("Finished between polls", now, false);
        app.receive(
            Json::object(
                {{"method", "subagents.changed"},
                 {"params",
                  Json::object(
                      {{"now", now}, {"rows", Json::Array{}}, {"newer", Json::Array{}}, {"recent", Json::Array{fast}}}
                  )}}
            )
        );
        app.render(grid);
        require(
            text(grid).find("Finished between polls") != std::string::npos,
            "Recent snapshots insert unseen completed tasks into the overview"
        );
        require(
            text(grid, true).find("Status build") != std::string::npos,
            "New recent tasks preserve the running selection"
        );
        key(Key::Enter);
        require(count("subagents.page") == 0, "Enter on subagent is reserved and leaves selection alone");
        key(Key::End);
        key(Key::Enter);
        pump();
        app.render(grid);
        require(
            count("subagents.page") == 1 && text(grid).find("Last 14 days") != std::string::npos &&
                text(grid).find("Session history") != std::string::npos,
            "See all fetches and renders segmented history"
        );
        key(Key::Back);
        app.render(grid);
        require(
            app.focused() == Focus::List && text(grid, true).find("See all") != std::string::npos,
            "History Esc restores overview selection"
        );
        key(Key::Back);
        key(Key::Down);
        pump();
        app.render(grid);
        require(
            text(grid).find("/usr/bin/codex") != std::string::npos && grid.cells[5 * 120 + 28].fg == white &&
                grid.cells[6 * 120 + 28].fg == blue && grid.cells[6 * 120 + 37].fg == dim,
            "Helper uses white group headings, blue labels and dim values"
        );
        std::string helper_text = text(grid);
        key(Key::Enter);
        key(Key::End);
        app.render(grid);
        helper_text += text(grid);
        require(
            text(grid).find("workstation") != std::string::npos && text(grid).find("Leases") != std::string::npos &&
                text(grid, true).find("workstation") == std::string::npos,
            "Helper scrolls to leases without selectable highlights"
        );
        for (std::string_view name : {"Codex", "ZCode", "opencode", "Oh My Pi", "Gemini CLI", "Crush"}) {
            require(helper_text.find(name) != std::string::npos, "Helper uses app display names as group headings");
        }
        require(
            helper_text.find("Models: 7") != std::string::npos &&
                helper_text.find("listed 2m 41s ago") != std::string::npos &&
                helper_text.find("Config error:") != std::string::npos,
            "Helper has separate Location and Models rows and readable registry age"
        );
        key(Key::Home);
        app.render(grid);
        for (int y = 3; y < grid.height - 5; ++y) {
            const Cell &cell = grid.cells[size_t(y * grid.width + 28)];
            if (cell.fg == white && cell.glyph != " ") {
                require(cell.fg == white, "Helper section headers use white style");
                if (y == 5) {
                    continue;
                }
                for (int x = 27; x < grid.width - 2; ++x) {
                    if (x == grid.width - 4) {
                        continue;
                    }
                    require(
                        grid.cells[size_t((y - 1) * grid.width + x)].glyph == " ",
                        "Helper section headers have a blank line above"
                    );
                }
            }
        }
        app.step(3.1);
        pump();
        require(count("status.get") == 2, "Visible Helper refreshes every three seconds in static mode");
        key(Key::Back);
        key(Key::Back);
        pump();
        require(app.page() == Page::Home && count("unwatch") == 1, "Leaving Status unwatches subagents exactly once");
        app.receive(Json::object({{"method", "subagents.changed"}, {"params", updated}}));
        require(!app.needs_tick(), "Leaving Status stops timed work");
        key(Key::Enter);
        pump();
        app.render(grid);
        app.stop();
        require(count("unwatch") == 2 && !app.alive(), "Stopping on Status also unwatches");
    }
}
