// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "render/grid.hpp"
#include <array>
#include <optional>

namespace bf {
    struct ClipRegion {
        int left = 0;
        int top = 0;
        int right = 0;
        int bottom = 0;
        bool contains(double x, double pixel_y) const {
            return x >= left && x < right && pixel_y >= top && pixel_y < bottom;
        }
    };
    ClipRegion inner_region(const Grid &grid);
    struct Emitter {
        int x = 0;
        int pixel_y = 0;
        int height = 0;
        double opacity = 1;
        ClipRegion clip;
        bool gravity = false;
    };
    struct Gravity {
        double x = 0, pixel_y = 0;
        ClipRegion boundary;
    };
    struct ParticleMotion {
        double x = 0, pixel_y = 0, life = 0;
        double vx = 0, vy = 0, initial_vx = 0, initial_vy = 0;
        double age = 0;
    };
    void advance_particle(ParticleMotion &particle, double seconds, const std::optional<Gravity> &gravity);
    class Particles {
        struct Particle {
            ParticleMotion motion;
            Color color{};
            ClipRegion clip;
            bool gravity = false;
        };
        std::array<Particle, 96> pool{};
        uint32_t random = 0x91f2ab;
        size_t next = 0;
        double spawn_credit = 0;

      public:
        void step(
            double seconds,
            const std::vector<Emitter> &emitters,
            double time,
            const std::optional<Gravity> &gravity = std::nullopt
        );
        void draw(Grid &grid) const;
        void clear();
    };
}
