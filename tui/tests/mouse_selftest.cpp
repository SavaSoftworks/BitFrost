// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "term/output.hpp"
#include "ui/list.hpp"
#include <cmath>
#include <stdexcept>
#include <thread>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }
    }

    void mouse_selftest() {
        std::string report = "\033[<35;31;20M";
        for (size_t split = 0; split <= report.size(); ++split) {
            InputParser parser;
            require(parser.feed(report.substr(0, split)).empty(), "Mouse prefix is never a key");
            require(parser.feed(report.substr(split)).empty(), "Split mouse report is never a key");
            require(parser.take_mouse() == MousePosition{30, 19}, "Split SGR cell coordinates");
            require(!parser.take_mouse(), "Mouse position is consumed once");
        }
        InputParser parser;
        std::vector<Input> keys;
        for (char byte : std::string("w") + report + "\033[B" + "\033[<32;8;9M" + "e") {
            auto events = parser.feed(std::string_view(&byte, 1));
            keys.insert(keys.end(), events.begin(), events.end());
        }
        require(
            keys.size() == 3 && keys[0].key == Key::Up && keys[1].key == Key::Down && keys[2].key == Key::Enter,
            "Mouse reports interleave with arrow and shortcut keys"
        );
        require(parser.take_mouse() == MousePosition{7, 8}, "Frequent reports keep only the latest position");
        keys.clear();
        for (char byte : std::string("\033[") + report + "A") {
            auto events = parser.feed(std::string_view(&byte, 1));
            keys.insert(keys.end(), events.begin(), events.end());
        }
        require(
            keys.size() == 1 && keys[0].key == Key::Up && parser.take_mouse() == MousePosition{30, 19},
            "A mouse report can interrupt a split arrow sequence without leaking keys"
        );
        for (const std::string &garbage :
             {std::string("\033[<qwasde\033;1;2M"),
              std::string("\033[<35;0;2M"),
              std::string("\033[<35;-1;2M"),
              std::string("\033[<35;999999999999999999;2M"),
              std::string("\033[<35;1;2;3M"),
              std::string("\033[<") + std::string(500, 'q') + "M"}) {
            require(parser.feed(garbage).empty() && !parser.take_mouse(), "Malformed SGR cannot trigger keys");
            require(parser.feed("q").front().key == Key::Back, "Keys work after malformed SGR");
        }
        auto buttons = parser.feed("\033[<0;3;4M\033[<64;3;4M\033[<65;3;4M\033[<0;3;4m");
        require(
            buttons.size() == 3 && buttons[0].key == Key::Mouse && buttons[0].mouse->kind == MouseKind::Click &&
                buttons[0].mouse->position == MousePosition{2, 3} && buttons[1].mouse->delta == -1 &&
                buttons[2].mouse->delta == 1 && !parser.take_mouse(),
            "Click and wheel reports are mouse events and releases do nothing"
        );
        auto literal = parser.feed("wasdeq\033[<0;3;4M\033[<35;3;4M", true);
        require(
            literal.size() == 7 && literal.front().key == Key::Text && literal[5].text == "q" &&
                literal.back().key == Key::Mouse,
            "Mouse reports stay separate from literal editor typing"
        );
        parser.take_mouse();
        for (std::string click_report : {"\033[<0;3;4M", "\033[<65;3;4M"}) {
            for (size_t split = 0; split <= click_report.size(); ++split) {
                InputParser split_parser;
                auto first = split_parser.feed(click_report.substr(0, split), true);
                auto second = split_parser.feed(click_report.substr(split), true);
                first.insert(first.end(), second.begin(), second.end());
                require(
                    first.size() == 1 && first[0].key == Key::Mouse,
                    "Split click and wheel reports remain mouse events inside editors"
                );
            }
        }
        parser.feed("\033[<35;1;");
        require(parser.timeout_ms() > 0 && parser.expire().empty(), "Partial mouse report has a recovery timeout");
        parser.feed("2M");
        require(parser.take_mouse() == MousePosition{0, 1}, "Delayed mouse tail completes normally");
        parser.feed("\033[<35;1;");
        auto recovered = parser.feed("\003\033[Aq");
        require(
            recovered.size() == 3 && recovered[0].key == Key::Interrupt && recovered[1].key == Key::Up &&
                recovered[2].key == Key::Back,
            "A truncated mouse report cannot swallow interrupts or a new escape sequence"
        );
        parser.feed("\033[<35;1;");
        std::this_thread::sleep_for(std::chrono::milliseconds(510));
        require(parser.expire().empty() && parser.timeout_ms() == -1, "A truncated report expires silently");
        require(parser.feed("w").front().key == Key::Up, "Ordinary keys resume after a report expires");

        ClipRegion boundary{2, 4, 118, 44};
        Gravity gravity{24.5, 35, boundary};
        ParticleMotion original{30, 20, 1.9, -10, 1, -10, 1, 0};
        ParticleMotion particle = original;
        double speed = std::hypot(original.vx, original.vy), length = 0;
        for (int frame = 0; frame < 80; ++frame) {
            double x = particle.x, y = particle.pixel_y;
            advance_particle(particle, frame % 2 ? 0.043 : 0.017, gravity);
            length += std::hypot(particle.x - x, particle.pixel_y - y);
            require(
                std::abs(std::hypot(particle.vx, particle.vy) - speed) < 1e-12,
                "Steering preserves the original velocity magnitude"
            );
            require(length <= speed * original.life + 1e-10, "Travel never exceeds original speed times lifetime");
            if (frame == 5) {
                require(
                    particle.x < original.x && particle.vy > original.vy,
                    "Particles leave leftward then bend toward a lower pointer"
                );
            }
        }
        require(
            particle.life == 0 && std::abs(particle.age - original.life) < 1e-12,
            "Steering leaves lifetime and expiry unchanged"
        );
        for (auto [x, y] : {std::pair{1.5, 20.0}, {118.5, 20.0}, {30.0, 3.0}, {30.0, 44.0}}) {
            particle = original;
            advance_particle(particle, 0.1, Gravity{x, y, boundary});
            require(
                particle.vx == original.vx && particle.vy == original.vy && particle.x == 29 &&
                    particle.pixel_y == 20.1,
                "No pull outside any boundary edge"
            );
        }
        particle = original;
        particle.age = 0.5;
        advance_particle(particle, 0.1, gravity);
        advance_particle(particle, 0.1, std::nullopt);
        require(particle.vx == original.vx && particle.vy == original.vy, "Leaving restores ordinary drift in flight");
        particle = original;
        advance_particle(particle, 0.1, Gravity{particle.x, particle.pixel_y, boundary});
        require(particle.x < original.x, "A particle at the pointer keeps moving");

        std::vector<Emitter> menu{{30, 20, 4, 1, boundary, false}};
        Particles normal, pulled;
        Grid left(120, 40), right(120, 40);
        for (int frame = 0; frame < 90; ++frame) {
            normal.step(1.0 / 30, menu, frame / 30.0);
            pulled.step(1.0 / 30, menu, frame / 30.0, gravity);
        }
        normal.draw(left);
        pulled.draw(right);
        require(left.cells == right.cells, "Menu particles remain identical even inside the logo boundary");
        menu[0].gravity = true;
        normal.clear();
        pulled.clear();
        for (int frame = 0; frame < 90; ++frame) {
            normal.step(1.0 / 30, menu, frame / 30.0);
            pulled.step(1.0 / 30, menu, frame / 30.0, gravity);
        }
        left.clear();
        right.clear();
        normal.draw(left);
        pulled.draw(right);
        require(left.cells != right.cells, "Logo emitter steering changes particle positions");

        App home([](const Json &) {}, true);
        home.render(left);
        require(!home.mouse_gravity(), "No reports means no attraction");
        home.mouse(MousePosition{30, 19});
        auto target = home.mouse_gravity();
        require(
            target && target->x == 30.5 && target->pixel_y == 39 && target->boundary.left == 2 &&
                target->boundary.right == 118 && target->boundary.top == 4 && target->boundary.bottom == 46,
            "Home boundary uses full inner width and excludes the first menu highlight"
        );
        home.input({Key::Down, {}});
        home.render(left);
        require(home.mouse_gravity()->boundary.bottom == 46, "Boundary does not follow menu selection");
        home.mouse(MousePosition{30, 25});
        require(!home.mouse_gravity(), "Menu row is outside the attraction boundary");
        MouseReporting reporting;
        require(reporting.update(home.mouse_reporting()) == mouse_enable, "Animated home enables SGR and any motion");
        require(reporting.update(true).empty(), "Reporting mode is not resent per frame");
        home.input({Key::Enter, {}});
        home.step(0.5);
        require(
            reporting.update(home.mouse_reporting()).empty() && !home.mouse_gravity(),
            "Subpages retain mouse reporting and have no gravity"
        );
        home.input({Key::Back, {}});
        require(reporting.update(home.mouse_reporting()).empty(), "Page changes do not resend mouse modes");
        require(
            terminal_restore.starts_with(mouse_disable) && terminal_restore.ends_with("\033[?25h\033[?1049l"),
            "Terminal restore disables mouse and restores cursor and screen"
        );
        App static_home([](const Json &) {}, false);
        require(
            static_home.mouse_reporting() && !static_home.mouse_gravity(),
            "Static home retains mouse support without gravity"
        );
        App keyboard([](const Json &) {}, true, false);
        require(
            !keyboard.mouse_reporting() && !keyboard.mouse_input({{55, 26}, MouseKind::Click, 0}),
            "Mouse opt-out ignores mouse actions"
        );

        Grid clipped(20, 10);
        clipped.clip_inner(true);
        clipped.box(0, 0, 20, 10);
        clipped.text(15, 4, "long text │");
        list_text(clipped, 17, 5, "界│", blue, 5);
        clipped.pixel(19, 8, blue);
        for (int y = 0; y < clipped.height; ++y) {
            for (int x = 0; x < clipped.width; ++x) {
                if (!clipped.writable(x, y)) {
                    require(
                        clipped.cells[size_t(y * clipped.width + x)] == Cell{},
                        "All page drawing stays inside the border, including wide glyphs"
                    );
                }
            }
        }
        Grid sliding(120, 40);
        sliding.text(113, 10, "界");
        fade_slide(sliding, 0);
        require(
            sliding.cells[10 * 120 + 117].glyph == " " && !sliding.cells[10 * 120 + 118].continuation,
            "Page slide never crops off half a wide glyph beside the right border"
        );
    }
}
