// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include <string>
#include <string_view>

namespace bf {
    struct Options {
        bool animations = true, mouse = true, gamepad = true, resume = false, version = false, selftest = false;
        std::string message;
        bool parse(std::string_view argument) {
            if (argument == "--no-anim") {
                animations = false;
            } else if (argument == "--no-mouse") {
                mouse = false;
            } else if (argument == "--no-gamepad") {
                gamepad = false;
            } else if (argument == "--resume") {
                resume = true;
            } else if (argument.starts_with("--message=")) {
                message = argument.substr(10);
            } else if (argument == "--version") {
                version = true;
            } else if (argument == "--selftest") {
                selftest = true;
            } else {
                return false;
            }
            return true;
        }
    };
}
