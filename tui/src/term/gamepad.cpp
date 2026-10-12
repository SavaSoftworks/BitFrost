// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "term/gamepad.hpp"
#include <algorithm>
#include <cctype>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#ifdef __linux__
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <linux/input.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace bf {
    namespace {
        // Linux input codes, spelled out so the mapping also builds and tests elsewhere.
        constexpr int key_event = 1, axis_event = 3;
        constexpr int button_south = 0x130, button_east = 0x131;
        constexpr int shoulder_left = 0x136, shoulder_right = 0x137;
        constexpr int dpad_up = 0x220, dpad_down = 0x221, dpad_left = 0x222, dpad_right = 0x223;
        constexpr int axis_x = 0x00, axis_y = 0x01, axis_ry = 0x04, hat_x = 0x10, hat_y = 0x11;
        constexpr auto repeat_delay = std::chrono::milliseconds(350), repeat_every = std::chrono::milliseconds(75);
    }

    GamepadInfo identify_gamepad(std::string name, unsigned vendor) {
        std::string lower = name;
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) { return std::tolower(ch); });
        GamepadFamily family = GamepadFamily::Generic;
        if (vendor == 0x057e || lower.find("nintendo") != std::string::npos ||
            lower.find("switch") != std::string::npos) {
            family = GamepadFamily::Nintendo;
            if (name.empty() || lower == "pro controller") {
                name = "Nintendo Switch Pro controller";
            }
        } else if (
            vendor == 0x054c || lower.find("playstation") != std::string::npos ||
            lower.find("dualsense") != std::string::npos || lower.find("dualshock") != std::string::npos
        ) {
            family = GamepadFamily::PlayStation;
        } else if (
            vendor == 0x045e || lower.find("xbox") != std::string::npos || lower.find("x-box") != std::string::npos
        ) {
            family = GamepadFamily::Xbox;
        }
        if (name.empty()) {
            name = "Gamepad";
        }
        return {std::move(name), family};
    }

    std::string_view GamepadInfo::left_shoulder() const {
        return family == GamepadFamily::Nintendo      ? "L"
               : family == GamepadFamily::PlayStation ? "L1"
               : family == GamepadFamily::Xbox        ? "LB"
                                                      : "L shoulder";
    }

    std::string_view GamepadInfo::right_shoulder() const {
        return family == GamepadFamily::Nintendo      ? "R"
               : family == GamepadFamily::PlayStation ? "R1"
               : family == GamepadFamily::Xbox        ? "RB"
                                                      : "R shoulder";
    }

    std::string_view GamepadInfo::confirm() const {
        return family == GamepadFamily::PlayStation ? "Cross" : family == GamepadFamily::Generic ? "South button" : "A";
    }

    std::string_view GamepadInfo::cancel() const {
        return family == GamepadFamily::PlayStation ? "Circle" : family == GamepadFamily::Generic ? "East button" : "B";
    }

    // A stick tilts past 40% to move and must come back under 25% to stop, so it never chatters.
    // Some controllers, like a Pro Controller over Bluetooth, only reach about half way.
    int GamepadState::stick(int value, const Axis &axis, int current) const {
        double half = (axis.maximum - axis.minimum) / 2.0;
        if (half <= 0) {
            return 0;
        }
        double position = (value - (axis.maximum + axis.minimum) / 2.0) / half;
        if (position > 0.4 || (current > 0 && position > 0.25)) {
            return 1;
        }
        if (position < -0.4 || (current < 0 && position < -0.25)) {
            return -1;
        }
        return 0;
    }

    std::vector<Input> GamepadState::event(int type, int code, int value, Clock::time_point now) {
        if (type == key_event) {
            if (value == 2) {
                return {};
            }
            // Nintendo puts A on the right, so A and B swap places there.
            bool nintendo = info.family == GamepadFamily::Nintendo;
            int confirm = nintendo ? button_east : button_south;
            int cancel = nintendo ? button_south : button_east;
            if (code == shoulder_left || code == shoulder_right) {
                std::vector<Input> pressed;
                if (value == 1) {
                    pressed.push_back({code == shoulder_left ? Key::Controls : Key::BackTab, {}});
                }
                return pressed;
            }
            if (code == confirm || code == cancel) {
                std::vector<Input> pressed;
                if (value == 1) {
                    pressed.push_back({code == confirm ? Key::Enter : Key::Back, {}});
                }
                return pressed;
            }
            if (code == dpad_up || code == dpad_down) {
                dpad_y = value ? (code == dpad_up ? -1 : 1) : 0;
            } else if (code == dpad_left || code == dpad_right) {
                dpad_x = value ? (code == dpad_left ? -1 : 1) : 0;
            } else {
                return {};
            }
        } else if (type == axis_event) {
            if (code == hat_x) {
                dpad_x = std::clamp(value, -1, 1);
            } else if (code == hat_y) {
                dpad_y = std::clamp(value, -1, 1);
            } else if (code == axis_x) {
                stick_dx = stick(value, stick_x, stick_dx);
            } else if (code == axis_y) {
                stick_dy = stick(value, stick_y, stick_dy);
            } else if (code == axis_ry) {
                return scroll(value, now);
            } else {
                return {};
            }
        } else {
            return {};
        }
        return steer(now);
    }

    // The D-pad wins over the stick, and up or down wins over a diagonal, since lists run down the page.
    std::vector<Input> GamepadState::steer(Clock::time_point now) {
        int x = dpad_x || dpad_y ? dpad_x : stick_dx;
        int y = dpad_x || dpad_y ? dpad_y : stick_dy;
        std::optional<Key> direction;
        if (y) {
            direction = y < 0 ? Key::Up : Key::Down;
        } else if (x) {
            direction = x < 0 ? Key::Left : Key::Right;
        }
        if (direction == held) {
            return {};
        }
        held = direction;
        if (!held) {
            return {};
        }
        repeat_at = now + repeat_delay;
        return {{*held, {}}};
    }

    // Past a quarter tilt the view scrolls a row every 250 ms, down to every 30 ms at full tilt.
    std::vector<Input> GamepadState::scroll(int value, Clock::time_point now) {
        double half = (scroll_y.maximum - scroll_y.minimum) / 2.0;
        double position = half > 0 ? (value - (scroll_y.maximum + scroll_y.minimum) / 2.0) / half : 0;
        double tilt = std::min(1.0, std::abs(position));
        int direction = tilt > 0.25 ? (position < 0 ? -1 : 1) : 0;
        if (direction) {
            double speed = std::min(1.0, (tilt - 0.25) / 0.5);
            scroll_every = std::chrono::duration_cast<Clock::duration>(
                std::chrono::duration<double, std::milli>(250 - 220 * speed)
            );
        }
        bool started = direction && direction != scroll_direction;
        scroll_direction = direction;
        if (!started) {
            return {};
        }
        scroll_at = now + scroll_every;
        return {{direction < 0 ? Key::ScrollUp : Key::ScrollDown, {}}};
    }

    std::vector<Input> GamepadState::repeat(Clock::time_point now) {
        std::vector<Input> inputs;
        if (held && now >= repeat_at) {
            repeat_at = std::max(repeat_at + repeat_every, now + repeat_every / 2);
            inputs.push_back({*held, {}});
        }
        if (scroll_direction && now >= scroll_at) {
            scroll_at = std::max(scroll_at + scroll_every, now + scroll_every / 2);
            inputs.push_back({scroll_direction < 0 ? Key::ScrollUp : Key::ScrollDown, {}});
        }
        return inputs;
    }

    std::optional<GamepadState::Clock::time_point> GamepadState::next_repeat() const {
        std::optional<Clock::time_point> next;
        if (held) {
            next = repeat_at;
        }
        if (scroll_direction) {
            next = next ? std::min(*next, scroll_at) : scroll_at;
        }
        return next;
    }

    void GamepadState::release() {
        dpad_x = dpad_y = stick_dx = stick_dy = scroll_direction = 0;
        held.reset();
    }

    int Gamepads::timeout_ms(GamepadState::Clock::time_point now) const {
        int timeout = -1;
        for (const auto &[descriptor, state] : devices) {
            if (auto at = state.next_repeat()) {
                int wait = int(
                    std::max<long long>(0, std::chrono::duration_cast<std::chrono::milliseconds>(*at - now).count() + 1)
                );
                timeout = timeout < 0 ? wait : std::min(timeout, wait);
            }
        }
        return timeout;
    }

    std::vector<Input> Gamepads::repeat(GamepadState::Clock::time_point now) {
        std::vector<Input> inputs;
        for (auto &[descriptor, state] : devices) {
            for (Input &input : state.repeat(now)) {
                inputs.push_back(std::move(input));
            }
        }
        return inputs;
    }

    void Gamepads::release() {
        for (auto &[descriptor, state] : devices) {
            state.release();
        }
    }

    std::vector<int> Gamepads::descriptors() const {
        std::vector<int> result;
        if (watch >= 0) {
            result.push_back(watch);
        }
        for (const auto &[descriptor, state] : devices) {
            result.push_back(descriptor);
        }
        return result;
    }

    std::optional<GamepadInfo> Gamepads::connected() const {
        auto selected = devices.find(active);
        if (selected == devices.end()) {
            selected = devices.begin();
        }
        return selected == devices.end() ? std::nullopt : std::optional<GamepadInfo>(selected->second.info);
    }

#ifdef __linux__
    namespace {
        bool has_bit(const unsigned long *bits, int bit) {
            constexpr int word = int(sizeof(unsigned long) * CHAR_BIT);
            return (bits[bit / word] >> (bit % word)) & 1UL;
        }
    }

    Gamepads::Gamepads() {
        watch = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
        if (watch >= 0 && inotify_add_watch(watch, "/dev/input", IN_CREATE | IN_ATTRIB) < 0) {
            close(watch);
            watch = -1;
        }
        if (DIR *directory = opendir("/dev/input")) {
            while (dirent *entry = readdir(directory)) {
                if (std::string_view(entry->d_name).starts_with("event")) {
                    add((std::string("/dev/input/") + entry->d_name).c_str());
                }
            }
            closedir(directory);
        }
    }

    Gamepads::~Gamepads() {
        for (const auto &[descriptor, state] : devices) {
            close(descriptor);
        }
        if (watch >= 0) {
            close(watch);
        }
    }

    // Opens a device only if it has the face buttons every gamepad reports.
    void Gamepads::add(const char *path) {
        int descriptor = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (descriptor < 0) {
            return;
        }
        constexpr int word = int(sizeof(unsigned long) * CHAR_BIT);
        unsigned long keys[(KEY_MAX + word) / word] = {};
        input_id id{};
        struct stat opened{};
        bool duplicate = false;
        if (fstat(descriptor, &opened) == 0) {
            for (const auto &[other, state] : devices) {
                struct stat known{};
                duplicate = duplicate || (fstat(other, &known) == 0 && known.st_rdev == opened.st_rdev);
            }
        }
        if (duplicate || ioctl(descriptor, EVIOCGBIT(EV_KEY, sizeof(keys)), keys) < 0 || !has_bit(keys, button_south) ||
            !has_bit(keys, button_east)) {
            close(descriptor);
            return;
        }
        GamepadState state;
        ioctl(descriptor, EVIOCGID, &id);
        char name[256]{};
        ioctl(descriptor, EVIOCGNAME(sizeof(name) - 1), name);
        state.info = identify_gamepad(name, id.vendor);
        input_absinfo info{};
        if (ioctl(descriptor, EVIOCGABS(ABS_X), &info) == 0 && info.maximum > info.minimum) {
            state.stick_x = {info.minimum, info.maximum};
        }
        if (ioctl(descriptor, EVIOCGABS(ABS_Y), &info) == 0 && info.maximum > info.minimum) {
            state.stick_y = {info.minimum, info.maximum};
        }
        if (ioctl(descriptor, EVIOCGABS(ABS_RY), &info) == 0 && info.maximum > info.minimum) {
            state.scroll_y = {info.minimum, info.maximum};
        }
        devices[descriptor] = state;
    }

    std::vector<Input> Gamepads::read(int descriptor, GamepadState::Clock::time_point now) {
        std::vector<Input> inputs;
        if (descriptor == watch) {
            alignas(inotify_event) char buffer[4096];
            ssize_t size;
            while ((size = ::read(watch, buffer, sizeof(buffer))) > 0) {
                for (ssize_t offset = 0; offset < size;) {
                    auto *change = reinterpret_cast<inotify_event *>(buffer + offset);
                    if (change->len && std::string_view(change->name).starts_with("event")) {
                        add((std::string("/dev/input/") + change->name).c_str());
                    }
                    offset += ssize_t(sizeof(inotify_event) + change->len);
                }
            }
            return inputs;
        }
        auto device = devices.find(descriptor);
        if (device == devices.end()) {
            return inputs;
        }
        input_event events[64];
        ssize_t size;
        while ((size = ::read(descriptor, events, sizeof(events))) > 0) {
            for (ssize_t index = 0; index < size / ssize_t(sizeof(input_event)); ++index) {
                for (Input &input :
                     device->second.event(events[index].type, events[index].code, events[index].value, now)) {
                    inputs.push_back(std::move(input));
                    active = descriptor;
                }
            }
        }
        if (size == 0 || (size < 0 && errno != EAGAIN && errno != EINTR)) {
            close(descriptor);
            devices.erase(device);
        }
        return inputs;
    }
#else
    Gamepads::Gamepads() {}
    Gamepads::~Gamepads() {}
    void Gamepads::add(const char *) {}
    std::vector<Input> Gamepads::read(int, GamepadState::Clock::time_point) {
        return {};
    }
#endif
}
