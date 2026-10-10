// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "particles.hpp"
#include "mosaic.hpp"
#include <algorithm>
#include <cmath>

namespace bf {
    ClipRegion inner_region(const Grid &grid) {
        return {2, 4, grid.width - 2, (grid.height - 2) * 2};
    }

    void advance_particle(ParticleMotion &particle, double seconds, const std::optional<Gravity> &gravity) {
        double dt = std::min(std::max(0.0, seconds), particle.life);
        if (dt <= 0) {
            return;
        }
        if (gravity && gravity->boundary.contains(gravity->x, gravity->pixel_y)) {
            double dx = gravity->x - particle.x, dy = gravity->pixel_y - particle.pixel_y;
            double distance = std::hypot(dx, dy);
            if (distance > 0.001) {
                double angle = std::atan2(particle.vx * dy - particle.vy * dx, particle.vx * dx + particle.vy * dy);
                double turn = std::min(4.5, 50.0 / (6.0 + distance)) * std::min(1.0, particle.age / 0.16) * dt;
                angle = std::clamp(angle, -turn, turn);
                double heading = std::atan2(particle.vy, particle.vx) + angle;
                double speed = std::hypot(particle.initial_vx, particle.initial_vy);
                particle.vx = speed * std::cos(heading);
                particle.vy = speed * std::sin(heading);
            }
        } else {
            particle.vx = particle.initial_vx;
            particle.vy = particle.initial_vy;
        }
        particle.x += particle.vx * dt;
        particle.pixel_y += particle.vy * dt;
        particle.life = std::max(0.0, particle.life - seconds);
        particle.age += dt;
    }

    void Particles::step(
        double seconds,
        const std::vector<Emitter> &emitters,
        double time,
        const std::optional<Gravity> &gravity
    ) {
        for (Particle &particle : pool) {
            advance_particle(particle.motion, seconds, particle.gravity ? gravity : std::nullopt);
        }
        spawn_credit += seconds * 24;
        int count = int(spawn_credit);
        spawn_credit -= count;
        for (const Emitter &emitter : emitters) {
            if (emitter.height <= 0 || emitter.opacity <= 0) {
                continue;
            }
            for (int index = 0; index < count; ++index) {
                random = tile_hash(random);
                double fraction = double(random & 65535) / 65535;
                double speed = 4 + fraction * 9;
                double drift = std::sin(speed) * 1.5;
                Particle &particle = pool[next++ % pool.size()];
                particle = {
                    {double(emitter.x) - 1,
                     emitter.pixel_y + fraction * emitter.height,
                     0.5 + fraction * 1.4,
                     -speed,
                     drift,
                     -speed,
                     drift,
                     0},
                    blend(mosaic(emitter.x, emitter.pixel_y, time), emitter.opacity),
                    emitter.clip,
                    emitter.gravity
                };
            }
        }
    }

    void Particles::draw(Grid &grid) const {
        ClipRegion inner = inner_region(grid);
        for (const Particle &particle : pool) {
            int x = int(particle.motion.x);
            int pixel_y = int(particle.motion.pixel_y);
            if (particle.motion.life > 0 && inner.contains(x, pixel_y) && particle.clip.contains(x, pixel_y)) {
                grid.pixel(x, pixel_y, blend(particle.color, std::min(1.0, particle.motion.life / 1.6)));
            }
        }
    }

    void Particles::clear() {
        for (Particle &particle : pool) {
            particle.motion.life = 0;
        }
    }
}
