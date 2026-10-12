// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "rpc/json.hpp"
#include "term/input.hpp"

namespace bf {
    struct SubagentRow {
        Json agent;
        std::string title;
        bool see_all = false;
        bool selectable() const {
            return see_all || !agent.null();
        }
    };
    int subagent_group(double created_at, double now);
    std::string elapsed_time(double milliseconds);
    double subagent_duration(const Json &row, double now);
    class SubagentList {
        std::vector<SubagentRow> entries;
        std::vector<int> selectable;
        int selected = -1, first = 0;
        bool following = true;
        bool history = false;
        std::optional<SubagentRow> retained_selection;

      public:
        void reset(const Json &data, bool history, bool preserve = true);
        void input(Key key, int visible_rows);
        bool select(int row);
        bool resume_visible(Key key, int visible_rows);
        void scroll(int delta, int visible_rows);
        int first_row(int visible_rows);
        int first_index() const {
            return first;
        }
        int selected_row() const {
            return selected;
        }
        const SubagentRow *selection() const;
        const std::vector<SubagentRow> &rows() const {
            return entries;
        }
    };
}
