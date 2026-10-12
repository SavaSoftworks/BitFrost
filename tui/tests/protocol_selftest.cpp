// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include <algorithm>
#include <cmath>
#include <deque>
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        std::string frame(const Grid &grid, bool selected = false) {
            std::string result;
            for (const Cell &cell : grid.cells) {
                result += !selected || (cell.fg == black && cell.bg != black) ? cell.glyph : " ";
            }
            return result;
        }

        std::string cursor(const Json &row) {
            return std::to_string(row["createdAt"].integer()) + ':' + row["id"].str();
        }
    }

    void protocol_selftest() {
        std::deque<Json> pending;
        std::vector<Json> sent;
        App app(
            [&](const Json &request) {
                pending.push_back(request);
                sent.push_back(request);
            },
            false
        );
        auto reply = [&](const Json &request, const Json &result) {
            app.receive(Json::object({{"id", request["id"]}, {"result", result}}));
        };
        auto last = [&](std::string_view method) {
            auto found = std::find_if(sent.rbegin(), sent.rend(), [&](const Json &request) {
                return request["method"].str() == method;
            });
            return found == sent.rend() ? Json{} : *found;
        };
        auto count = [&](std::string_view method) {
            return std::count_if(sent.begin(), sent.end(), [&](const Json &request) {
                return request["method"].str() == method;
            });
        };
        auto drain = [&] {
            while (!pending.empty()) {
                Json request = pending.front();
                pending.pop_front();
                Json result = Json::object({{"ok", true}});
                if (request["method"].str() == "providers.list") {
                    result["providers"] = Json::Array{
                        Json::object({{"id", "codex"}, {"displayName", "Codex"}, {"enabled", true}, {"detected", true}})
                    };
                } else if (request["method"].str() == "models.list") {
                    result["models"] = Json::Array{
                        Json::object({{"model", "alpha"}, {"enabled", true}}),
                        Json::object({{"model", "beta"}, {"enabled", true}})
                    };
                } else if (request["method"].str() == "models.stats") {
                    result["rows"] = Json::Array{Json::object(
                        {{"model", request["params"]["model"]}, {"today", Json::object({{"inputTokens", 123456}})}}
                    )};
                }
                reply(request, result);
            }
        };
        Grid grid(100, 26);
        app.start();
        drain();
        app.input({Key::Enter, {}});
        drain();
        require(count("models.stats") == 0, "Stats wait until the panel is displayed");
        app.render(grid);
        require(
            count("models.stats") == 1 && last("models.stats")["params"]["model"].str() == "alpha",
            "Stats query only the displayed model"
        );
        drain();
        app.input({Key::Enter, {}});
        app.input({Key::Down, {}});
        require(
            count("models.stats") == 2 && last("models.stats")["params"]["model"].str() == "beta",
            "Moving highlight requests one model"
        );
        drain();
        app.input({Key::Up, {}});
        app.render(grid);
        require(
            count("models.stats") == 3 && frame(grid).find("123.5k") != std::string::npos,
            "Returning to a model displays its cache during refresh"
        );
        drain();
        Json beta = Json::object({{"model", "beta"}, {"today", Json::object({{"inputTokens", 987654}})}});
        app.receive(
            Json::object(
                {{"method", "stats.updated"},
                 {"params", Json::object({{"provider", "codex"}, {"rows", Json::Array{beta}}})}}
            )
        );
        app.input({Key::Down, {}});
        app.render(grid);
        require(
            frame(grid).find("987.7k") != std::string::npos,
            "Stats notification merges by model without losing other cached rows"
        );
        Grid tiny(80, 18);
        app.render(tiny);
        require(last("unwatch")["params"]["what"].str() == "stats", "Hiding stats stops its watch");
        app.render(grid);
        app.input({Key::Back, {}});
        app.input({Key::Back, {}});
        require(
            app.page() == Page::Home && last("unwatch")["params"]["what"].str() == "stats",
            "Leaving Models stops its watch"
        );
        drain();

        Json::Array agents;
        for (int index = 0; index < 5000; ++index) {
            agents.push_back(
                Json::object(
                    {{"id", "row-" + std::to_string(index)},
                     {"title", "Session " + std::to_string(index)},
                     {"model", "alpha"},
                     {"createdAt", 100000000 - index * 1000},
                     {"running", index == 0},
                     {"activeMs", 1000},
                     {"turnStartedAt", nullptr},
                     {"changedAt", index + 1}}
                )
            );
        }
        auto page = [&](const Json &params) {
            int start = 0, end = int(agents.size());
            for (int index = 0; index < int(agents.size()); ++index) {
                if (cursor(agents[size_t(index)]) == params["before"].str()) {
                    start = index + 1;
                }
                if (cursor(agents[size_t(index)]) == params["after"].str()) {
                    end = index;
                }
            }
            int limit = int(params["limit"].integer());
            bool reverse = !params["after"].null() || params["oldest"].boolean();
            int length = end - start;
            if (reverse) {
                start = std::max(start, end - limit);
            } else {
                end = std::min(end, start + limit);
            }
            return Json::object(
                {{"now", 100000000},
                 {"rows", Json::Array(agents.begin() + start, agents.begin() + end)},
                 {"total", int(agents.size())},
                 {"more", length > limit}}
            );
        };
        auto pump = [&] {
            while (!pending.empty()) {
                Json request = pending.front();
                pending.pop_front();
                Json result = Json::object({{"ok", true}});
                if (request["method"].str() == "subagents.overview") {
                    result = Json::object(
                        {{"now", 100000000},
                         {"running", Json::Array{agents[0]}},
                         {"recent", Json::Array(agents.begin() + 1, agents.begin() + 11)}}
                    );
                } else if (request["method"].str() == "subagents.page") {
                    result = page(request["params"]);
                }
                reply(request, result);
            }
        };
        auto render = [&] {
            app.render(grid);
            pump();
            app.render(grid);
            if (frame(grid).find("Session history") != std::string::npos) {
                Json watched = last("subagents.watch")["params"];
                const auto &ids = watched["ids"].array();
                if (!ids.empty()) {
                    auto row = std::find_if(agents.begin(), agents.end(), [&](const Json &entry) {
                        return entry["id"] == ids.front();
                    });
                    if (row != agents.end()) {
                        int height = grid.height - 11;
                        int first = int(row - agents.begin());
                        int size = std::max(1, int(std::round(height * 2.0 * ids.size() / agents.size())));
                        int top =
                            std::clamp(int(std::round(height * 2.0 * first / agents.size())), 0, height * 2 - size);
                        for (int index = 0; index < height; ++index) {
                            bool upper = index * 2 >= top && index * 2 < top + size;
                            bool lower = index * 2 + 1 >= top && index * 2 + 1 < top + size;
                            const Cell &cell = grid.cells[size_t((6 + index) * grid.width + 96)];
                            require(
                                cell.glyph == (upper   ? lower ? "▌" : "▘"
                                               : lower ? "▖"
                                                       : " "),
                                "History scrollbar uses total and absolute offset through paging and eviction"
                            );
                        }
                    }
                }
            }
        };
        auto key = [&](Key key) {
            app.input({key, {}});
            pump();
            render();
        };
        grid = Grid(100, 20);
        key(Key::End);
        key(Key::Enter);
        key(Key::Enter);
        Json watch = last("subagents.watch")["params"];
        require(
            watch["top"].null() && watch["ids"].array().size() < 11,
            "Overview watches only fitting rows and omits the top cursor"
        );
        for (const Json &id : watch["ids"].array()) {
            auto row = std::find_if(agents.begin(), agents.end(), [&](const Json &agent) { return agent["id"] == id; });
            require(
                row != agents.end() && frame(grid).find((*row)["title"].str()) != std::string::npos,
                "Every watched overview row is displayed"
            );
        }
        auto watches = count("subagents.watch");
        key(Key::End);
        require(count("subagents.watch") > watches, "Scrolling replaces the visible watch");
        key(Key::Enter);
        require(
            count("subagents.page") == 1 && last("subagents.page")["params"]["limit"].integer() == 18,
            "See all opens with two screens of rows"
        );
        require(!last("subagents.watch")["params"]["top"].null(), "Newest window supplies its top cursor");
        for (int index = 0; index < 20; ++index) {
            key(Key::PageDown);
        }
        require(
            grid.cells[size_t(6 * grid.width + 96)].glyph == "▖",
            "History Page Down moves the thumb in global coordinates"
        );
        key(Key::Home);
        require(grid.cells[size_t(6 * grid.width + 96)].glyph == "▘", "History Home returns the thumb to the top");
        for (int index = 0; index < 220; ++index) {
            key(Key::Down);
        }
        require(
            !last("subagents.page")["params"]["before"].null() && last("subagents.watch")["params"]["top"].null(),
            "Downward paging uses before and eviction removes the real top"
        );
        int upward = 0;
        while (last("subagents.page")["params"]["after"].null() && upward < 100) {
            app.input({Key::Up, {}});
            app.render(grid);
            std::string before_page = frame(grid, true);
            pump();
            app.render(grid);
            require(frame(grid, true) == before_page, "Prepending a newer page anchors the selected row on screen");
            ++upward;
        }
        require(
            upward < 100 && !last("subagents.page")["params"]["after"].null(),
            "Evicted newer pages are fetched with after within the ten-screen cap"
        );
        auto check_visible = [&] {
            Json watch = last("subagents.watch")["params"];
            require(watch["ids"].array().size() <= 9, "History watch never includes prefetched rows");
            int64_t stamp = INT64_MAX;
            for (const Json &id : watch["ids"].array()) {
                auto row =
                    std::find_if(agents.begin(), agents.end(), [&](const Json &agent) { return agent["id"] == id; });
                require(
                    row != agents.end() && frame(grid).find((*row)["title"].str()) != std::string::npos,
                    "History watches only displayed rows"
                );
                stamp = std::min(stamp, (*row)["changedAt"].integer());
            }
            require(stamp == watch["since"].integer(), "Watch since is the oldest displayed change");
        };
        check_visible();
        auto watch_count = count("subagents.watch");
        grid = Grid(100, 16);
        render();
        require(
            count("subagents.watch") > watch_count && last("subagents.watch")["params"]["ids"].array().size() <= 5,
            "Resize replaces the watch with the smaller visible set"
        );
        grid = Grid(100, 20);
        render();
        key(Key::Home);
        require(
            last("subagents.page")["params"]["before"].null() &&
                !last("subagents.page")["params"]["oldest"].boolean() &&
                frame(grid, true).find("Session 0") != std::string::npos,
            "Home reloads the newest page"
        );
        key(Key::End);
        require(
            last("subagents.page")["params"]["oldest"].boolean() &&
                frame(grid, true).find("Session 4999") != std::string::npos,
            "End loads and selects the oldest page"
        );
        require(
            grid.cells[size_t(14 * grid.width + 96)].glyph == "▖",
            "History End touches the bottom of the whole history"
        );
        key(Key::Down);
        require(
            frame(grid, true).find("Session 0") != std::string::npos &&
                grid.cells[size_t(6 * grid.width + 96)].glyph == "▘",
            "History wraps from the oldest session to the newest and returns the thumb to the top"
        );
        key(Key::Up);
        require(
            frame(grid, true).find("Session 4999") != std::string::npos,
            "History wraps from the newest session to the oldest"
        );
        app.input({Key::Home, {}});
        Json stale = pending.front();
        pending.pop_front();
        app.input({Key::End, {}});
        pump();
        reply(stale, page(stale["params"]));
        render();
        require(
            frame(grid, true).find("Session 4999") != std::string::npos,
            "Reset generations reject stale page replies"
        );
        key(Key::Home);
        auto pages_before_scroll = count("subagents.page");
        for (int index = 0; index < 40; ++index) {
            app.input({Key::Down, {}});
            app.render(grid);
        }
        require(
            count("subagents.page") == pages_before_scroll + 1 && !last("subagents.page")["params"]["before"].null(),
            "Only one older-page request can be in flight"
        );
        app.input({Key::End, {}});
        pump();
        render();
        require(
            frame(grid, true).find("Session 4999") != std::string::npos,
            "End ignores an older-page reply from the previous window"
        );
        key(Key::Home);
        key(Key::PageDown);
        std::string anchor = frame(grid, true);
        Json arrival = agents[0];
        arrival["id"] = "new";
        arrival["title"] = "New session";
        arrival["createdAt"] = 100001000;
        arrival["changedAt"] = 6000;
        agents.insert(agents.begin(), arrival);
        Json changed = agents[8];
        changed["title"] = "Changed session";
        app.receive(
            Json::object(
                {{"method", "subagents.changed"},
                 {"params",
                  Json::object({{"now", 100002000}, {"rows", Json::Array{changed}}, {"newer", Json::Array{arrival}}})}}
            )
        );
        render();
        require(
            frame(grid, true) == anchor && last("subagents.watch")["params"]["top"].str() == cursor(arrival),
            "Newer rows preserve the scrolled viewport and advance the top cursor"
        );
        require(
            frame(grid).find("Changed session") != std::string::npos,
            "Changed rows merge by id inside the loaded window"
        );
        key(Key::Back);
        key(Key::Home);
        Json finished = agents[1];
        finished["running"] = false;
        finished["title"] = "Finished session";
        arrival["running"] = true;
        app.receive(
            Json::object(
                {{"method", "subagents.changed"},
                 {"params",
                  Json::object(
                      {{"now", 100003000}, {"rows", Json::Array{finished, arrival}}, {"newer", Json::Array{}}}
                  )}}
            )
        );
        render();
        require(
            frame(grid).find("New session") != std::string::npos &&
                frame(grid).find("Finished session") != std::string::npos,
            "Overview moves started rows to Running and finished rows to Recent"
        );
        key(Key::End);
        key(Key::Enter);
        for (int index = 0; index < 220; ++index) {
            key(Key::Down);
        }
        std::string scrolled_anchor = frame(grid, true);
        Json::Array arrivals;
        for (int index = 0; index < 1000; ++index) {
            Json row = agents.front();
            row["id"] = "batch-" + std::to_string(index);
            row["title"] = "Batch session " + std::to_string(index);
            row["createdAt"] = 200000000 - index * 1000;
            arrivals.push_back(row);
        }
        agents.insert(agents.begin(), arrivals.begin(), arrivals.end());
        Json notification = Json::object(
            {{"method", "subagents.changed"},
             {"params", Json::object({{"now", 200000000}, {"rows", Json::Array{}}, {"newer", arrivals}})}}
        );
        app.receive(notification);
        render();
        require(
            frame(grid, true) == scrolled_anchor,
            "New sessions shift the evicted window's absolute indexes without moving its selection"
        );
        std::string after_arrivals = frame(grid);
        app.receive(notification);
        render();
        require(
            frame(grid) == after_arrivals,
            "Repeated newer notifications do not double-count the total or window offset"
        );
        key(Key::Back);
        key(Key::Back);
        key(Key::Back);
        require(
            app.page() == Page::Home && last("unwatch")["params"]["what"].str() == "subagents",
            "Leaving Status stops visible-row updates"
        );
    }
}
