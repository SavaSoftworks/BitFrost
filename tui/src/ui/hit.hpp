// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"
#include "term/input.hpp"
#include <optional>

namespace bf {
    struct Rect {
        int x = 0, y = 0, width = 0, height = 0;
        bool contains(MousePosition point) const {
            return point.x >= x && point.y >= y && point.x < x + width && point.y < y + height;
        }
    };
    enum class HitKind {
        Home,
        Update,
        Provider,
        Section,
        StatusSection,
        Model,
        Setting,
        Subagent,
        Helper,
        Link,
        PopupRow,
        ModelAction,
        EnableProvider,
        StatsTab,
        Editor,
        Activate,
        Controls,
        ConfigurationOption,
        ConfigurationStep,
        ConfigurationPrevious,
        ConfigurationNext,
        ConfigurationContinue,
        Back
    };
    struct Hit {
        Rect rect;
        HitKind kind;
        int index = 0;
    };
    class HitMap {
        std::vector<Hit> targets, scroll_regions;
        std::optional<Rect> popup;
        Rect bounds;

      public:
        void clear(int width, int height);
        void add(Rect rect, HitKind kind, int index = 0);
        void scroll(Rect rect, HitKind kind);
        void modal(Rect rect);
        void shift(int columns);
        std::optional<Hit> at(MousePosition point, bool wheel = false) const;
        void hover(Grid &grid, std::optional<MousePosition> point) const;
    };
}
