// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/options.hpp"
#include "term/gamepad.hpp"
#include "term/input.hpp"
#include <stdexcept>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        constexpr int keys = 1, axes = 3;
        constexpr int south = 0x130, east = 0x131, dpad_left = 0x222, axis_x = 0x00, axis_y = 0x01, axis_ry = 0x04,
                      hat_y = 0x11;

        bool only(const std::vector<Input> &inputs, Key key) {
            return inputs.size() == 1 && inputs[0].key == key;
        }
    }

    void gamepad_selftest() {
        using namespace std::chrono_literals;
        auto now = GamepadState::Clock::now();

        GamepadState xbox;
        xbox.info = identify_gamepad("Xbox Wireless Controller", 0x045e);
        require(xbox.info.left_shoulder() == "LB" && xbox.info.confirm() == "A", "Xbox mappings use its button labels");
        require(only(xbox.event(keys, 0x136, 1, now), Key::Controls), "The left shoulder opens Controls");
        require(
            xbox.event(keys, 0x136, 0, now).empty() && xbox.event(keys, 0x136, 2, now).empty(),
            "The Controls button does not toggle again on release or repeat"
        );
        require(only(xbox.event(keys, 0x137, 1, now), Key::BackTab), "The right shoulder switches model sections");
        require(only(xbox.event(keys, south, 1, now), Key::Enter), "Xbox A confirms");
        require(xbox.event(keys, south, 0, now).empty(), "Releasing a button sends nothing");
        require(xbox.event(keys, south, 2, now).empty(), "A button's own repeat is ignored");
        require(only(xbox.event(keys, east, 1, now), Key::Back), "Xbox B goes back");

        GamepadState nintendo;
        nintendo.info = identify_gamepad("Pro Controller", 0x057e);
        require(
            nintendo.info.name == "Nintendo Switch Pro controller" && nintendo.info.left_shoulder() == "L",
            "Nintendo controllers have their name and shoulder labels"
        );
        require(only(nintendo.event(keys, east, 1, now), Key::Enter), "Nintendo A, on the right, confirms");
        require(only(nintendo.event(keys, south, 1, now), Key::Back), "Nintendo B, at the bottom, goes back");
        auto sony = identify_gamepad("DualSense Wireless Controller", 0x054c);
        require(
            sony.left_shoulder() == "L1" && sony.confirm() == "Cross" && sony.cancel() == "Circle",
            "PlayStation controllers use L1 and their face button labels"
        );
        require(
            identify_gamepad("Xbox-compatible pad", 0).family == GamepadFamily::Xbox,
            "Recognizable controller names identify third-party button layouts"
        );
        require(identify_gamepad("", 0).name == "Gamepad", "Unknown controllers retain a readable name");

        GamepadState pad;
        require(only(pad.event(axes, hat_y, -1, now), Key::Up), "The D-pad hat moves up");
        require(pad.repeat(now + 349ms).empty(), "A held direction waits before repeating");
        require(only(pad.repeat(now + 350ms), Key::Up), "Then it repeats");
        require(pad.repeat(now + 400ms).empty() && only(pad.repeat(now + 425ms), Key::Up), "And keeps repeating");
        require(pad.event(axes, hat_y, 0, now).empty() && !pad.next_repeat(), "Letting go stops the repeat");
        require(only(pad.event(keys, dpad_left, 1, now), Key::Left), "D-pad buttons move too");
        pad.event(keys, dpad_left, 0, now);

        require(only(pad.event(axes, axis_x, 30000, now), Key::Right), "Tilting the stick moves");
        require(pad.event(axes, axis_x, 10000, now).empty(), "A stick easing back but still past a quarter holds");
        require(pad.event(axes, axis_x, 7000, now).empty() && !pad.next_repeat(), "Under a quarter it lets go");
        require(pad.event(axes, axis_x, 12000, now).empty(), "A small tilt does nothing");
        require(only(pad.event(axes, axis_x, -15000, now), Key::Left), "A Bluetooth Pro Controller's half tilt moves");
        pad.event(axes, axis_x, 0, now);
        require(only(pad.event(axes, axis_x, -20000, now), Key::Left), "The stick moves left");
        require(only(pad.event(axes, axis_y, 25000, now), Key::Down), "Up or down wins over a diagonal");
        require(only(pad.event(axes, hat_y, -1, now), Key::Up), "The D-pad wins over the stick");
        require(only(pad.event(axes, hat_y, 0, now), Key::Down), "Letting go of the D-pad hands back to the stick");
        pad.release();
        require(!pad.next_repeat() && pad.repeat(now + 1s).empty(), "Losing focus lets go of everything");

        GamepadState right;
        require(right.event(axes, axis_ry, 6000, now).empty(), "A light touch on the right stick does nothing");
        require(only(right.event(axes, axis_ry, -9000, now), Key::ScrollUp), "The right stick scrolls up at once");
        require(right.repeat(now + 200ms).empty(), "A small tilt scrolls slowly");
        require(only(right.repeat(now + 240ms), Key::ScrollUp), "Then scrolls another row");
        require(right.event(axes, axis_ry, 32767, now).size() == 1, "Flipping direction scrolls the other way at once");
        require(
            right.repeat(now + 29ms).empty() && only(right.repeat(now + 30ms), Key::ScrollDown),
            "Full tilt is fast"
        );
        require(
            right.event(axes, axis_ry, 0, now).empty() && !right.next_repeat(),
            "Centering the stick stops scrolling"
        );
        require(only(right.event(axes, axis_ry, 32767, now), Key::ScrollDown), "Scrolling starts again");
        require(only(right.event(axes, hat_y, 1, now), Key::Down), "The right stick and the D-pad work together");
        right.release();
        require(right.repeat(now + 1s).empty(), "Losing focus stops scrolling too");

        GamepadState narrow;
        narrow.stick_x = {0, 255};
        require(only(narrow.event(axes, axis_x, 255, now), Key::Right), "Sticks with other ranges are scaled");
        require(narrow.event(axes, axis_x, 128, now).empty() && !narrow.next_repeat(), "Their center is still");

        InputParser parser;
        auto focus = parser.feed("\033[I\033[O");
        require(
            focus.size() == 2 && focus[0].key == Key::FocusIn && focus[1].key == Key::FocusOut,
            "The terminal's focus reports parse"
        );
        Options options;
        require(options.parse("--no-gamepad") && !options.gamepad, "Controllers can be turned off");
    }
}
