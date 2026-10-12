// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "output.hpp"
#include <csignal>
#include <termios.h>
#include <utility>

namespace bf {
    class Session {
        termios original{};
        bool active = false, saved = false;
        int pipefd[2]{-1, -1};
        struct sigaction previous[11]{};
        int installed = 0;
        MouseReporting reporting;
        bool used_mouse = false;
        static void handler(int signal);

      public:
        explicit Session(bool resume = false);
        ~Session();
        Session(const Session &) = delete;
        Session &operator=(const Session &) = delete;
        void enter(bool clear = true);
        void leave();
        int signal_fd() const {
            return pipefd[0];
        }
        unsigned signals();
        std::pair<int, int> size() const;
        void suspend();
        void mouse_reporting(bool enabled);
        bool prepare_reload();
        void cancel_reload();
    };
    enum SignalFlag : unsigned { Resize = 1, Terminate = 2, Suspend = 4, Continue = 8 };
}
