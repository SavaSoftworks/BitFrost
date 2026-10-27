// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "term/input.hpp"
#include <string>
#include <vector>

namespace bf {
    struct GroupedRow {
        int item = -1;
        std::string heading;
    };
    class GroupedList {
        std::vector<GroupedRow> entries;
        std::vector<int> selectable;
        int first = 0;
        bool following = true;

      public:
        void reset(const std::vector<std::string> &groups, bool headings = true);
        void input(int &item, Key key, int visible_rows);
        void scroll(int delta, int visible_rows);
        void clear_view() {
            first = 0;
            following = true;
        }
        int first_row(int item, int visible_rows);
        const std::vector<GroupedRow> &rows() const {
            return entries;
        }
    };
}
