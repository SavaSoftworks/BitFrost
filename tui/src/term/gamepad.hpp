// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "term/input.hpp"
#include <chrono>
#include <map>
#include <optional>
#include <vector>

namespace bf {
    enum class GamepadFamily { Generic, Xbox, PlayStation, Nintendo };
    struct GamepadInfo {
        std::string name;
        GamepadFamily family = GamepadFamily::Generic;
        std::string_view left_shoulder() const;
        std::string_view right_shoulder() const;
        std::string_view confirm() const;
        std::string_view cancel() const;
        bool operator==(const GamepadInfo &) const = default;
    };
    GamepadInfo identify_gamepad(std::string name, unsigned vendor);
    // One controller's buttons and sticks, turned into the keys a keyboard would send.
    class GamepadState {
      public:
        using Clock = std::chrono::steady_clock;
        struct Axis {
            int minimum = -32768, maximum = 32767;
        };
        GamepadInfo info;
        Axis stick_x, stick_y, scroll_y;

        std::vector<Input> event(int type, int code, int value, Clock::time_point now);
        std::vector<Input> repeat(Clock::time_point now);
        std::optional<Clock::time_point> next_repeat() const;
        void release();

      private:
        int dpad_x = 0, dpad_y = 0, stick_dx = 0, stick_dy = 0;
        std::optional<Key> held;
        Clock::time_point repeat_at;
        // The right stick scrolls; the further it tilts, the shorter the wait between rows.
        int scroll_direction = 0;
        Clock::duration scroll_every{};
        Clock::time_point scroll_at;
        std::vector<Input> scroll(int value, Clock::time_point now);
        std::vector<Input> steer(Clock::time_point now);
        int stick(int value, const Axis &axis, int current) const;
    };

    // Every gamepad on this machine, including ones plugged in later. Linux only.
    class Gamepads {
        int watch = -1;
        int active = -1;
        std::map<int, GamepadState> devices;
        void add(const char *path);

      public:
        Gamepads();
        ~Gamepads();
        Gamepads(const Gamepads &) = delete;
        Gamepads &operator=(const Gamepads &) = delete;
        // Descriptors to poll: the hotplug watch first, then each device.
        std::vector<int> descriptors() const;
        std::optional<GamepadInfo> connected() const;
        std::vector<Input> read(int descriptor, GamepadState::Clock::time_point now);
        std::vector<Input> repeat(GamepadState::Clock::time_point now);
        int timeout_ms(GamepadState::Clock::time_point now) const;
        // While the terminal is unfocused, held directions stop and input is ignored.
        void release();
    };
}
