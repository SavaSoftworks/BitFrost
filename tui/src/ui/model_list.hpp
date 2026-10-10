// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "rpc/json.hpp"
#include "term/input.hpp"

namespace bf {
    struct ModelRow {
        int model = -1;
        std::string id;
        std::string title;
        bool all = false;
        // A category heading, such as neuralwatt for neuralwatt/glm-5.3.
        bool category = false;
        // What a model row shows: its id without the category prefix.
        std::string label;
    };
    class ModelList {
        std::vector<ModelRow> entries;
        std::vector<int> selectable;
        int selected = -1, first = 0;
        bool following = true;

      public:
        void reset(const Json::Array &models, bool preserve = true);
        void input(Key key, int visible_rows);
        bool select(int row);
        void scroll(int delta, int visible_rows);
        int first_row(int visible_rows);
        int model_index() const;
        int selected_row() const {
            return selected;
        }
        const std::vector<ModelRow> &rows() const {
            return entries;
        }
    };
}
