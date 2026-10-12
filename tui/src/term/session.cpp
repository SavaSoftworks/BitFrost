// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "session.hpp"
#include "output.hpp"
#include "render/grid.hpp"
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <sys/ioctl.h>
#include <unistd.h>

namespace bf {
    namespace {
        volatile sig_atomic_t flags = 0;
        volatile sig_atomic_t signal_write = -1;
        constexpr int signal_numbers[] =
            {SIGINT, SIGTERM, SIGHUP, SIGTSTP, SIGCONT, SIGWINCH, SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE};
        termios restore_settings{};
        volatile sig_atomic_t terminal_active = 0;
        volatile sig_atomic_t mouse_used = 0;
    }

    void Session::handler(int signal_number) {
        int saved_errno = errno;
        if (signal_number == SIGABRT || signal_number == SIGSEGV || signal_number == SIGBUS ||
            signal_number == SIGILL || signal_number == SIGFPE) {
            if (terminal_active) {
                auto restore = mouse_used ? terminal_restore : keyboard_restore;
                auto ignored = ::write(STDOUT_FILENO, restore.data(), restore.size());
                (void)ignored;
                tcsetattr(STDIN_FILENO, TCSANOW, &restore_settings);
            }
            struct sigaction action{};
            action.sa_handler = SIG_DFL;
            sigemptyset(&action.sa_mask);
            sigaction(signal_number, &action, nullptr);
            ::kill(getpid(), signal_number);
            errno = saved_errno;
            return;
        }
        flags = flags | (signal_number == SIGWINCH  ? Resize
                         : signal_number == SIGTSTP ? Suspend
                         : signal_number == SIGCONT ? Continue
                                                    : Terminate);
        if (signal_write >= 0) {
            char byte = 1;
            auto ignored_result = ::write(int(signal_write), &byte, 1);
            (void)ignored_result;
        }
        errno = saved_errno;
    }

    Session::Session(bool resume) {
        if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO)) {
            throw std::runtime_error(
                "the config screen needs a terminal; edit the config file or run bitfrost config in one"
            );
        }
        if (tcgetattr(STDIN_FILENO, &original) < 0) {
            throw std::runtime_error("Cannot read terminal settings");
        }
        bool inherited = false;
        if (resume) {
            const char *encoded = std::getenv("BITFROST_TUI_TERMIOS");
            if (encoded && std::strlen(encoded) == sizeof(termios) * 2 + 1 &&
                (encoded[0] == '0' || encoded[0] == '1')) {
                termios restored{};
                auto bytes = reinterpret_cast<unsigned char *>(&restored);
                auto digit = [](char value) {
                    return value >= '0' && value <= '9'   ? value - '0'
                           : value >= 'a' && value <= 'f' ? value - 'a' + 10
                                                          : -1;
                };
                inherited = true;
                for (size_t index = 0; index < sizeof(termios); ++index) {
                    int high = digit(encoded[index * 2 + 1]), low = digit(encoded[index * 2 + 2]);
                    if (high < 0 || low < 0) {
                        inherited = false;
                        break;
                    }
                    bytes[index] = static_cast<unsigned char>(high * 16 + low);
                }
                if (inherited) {
                    original = restored;
                    used_mouse = encoded[0] == '1';
                }
            }
        }
        unsetenv("BITFROST_TUI_TERMIOS");
        saved = true;
        restore_settings = original;
        if (pipe(pipefd) < 0) {
            throw std::runtime_error("Cannot create signal pipe");
        }
        for (int descriptor : pipefd) {
            fcntl(descriptor, F_SETFL, O_NONBLOCK);
            fcntl(descriptor, F_SETFD, FD_CLOEXEC);
        }
        signal_write = pipefd[1];
        flags = 0;
        mouse_used = 0;
        struct sigaction action{};
        action.sa_handler = handler;
        sigemptyset(&action.sa_mask);
        for (int signal_number : signal_numbers) {
            sigaddset(&action.sa_mask, signal_number);
        }
        try {
            for (int signal_number : signal_numbers) {
                if (sigaction(signal_number, &action, &previous[installed]) < 0) {
                    throw std::runtime_error("Cannot install terminal signal handler");
                }
                ++installed;
            }
            if (inherited) {
                active = true;
                terminal_active = 1;
                mouse_used = used_mouse;
            } else {
                enter(!resume);
            }
        } catch (...) {
            for (int index = 0; index < installed; ++index) {
                sigaction(signal_numbers[index], &previous[index], nullptr);
            }
            signal_write = -1;
            close(pipefd[0]);
            close(pipefd[1]);
            throw;
        }
    }

    Session::~Session() {
        leave();
        signal_write = -1;
        for (int index = 0; index < installed; ++index) {
            sigaction(signal_numbers[index], &previous[index], nullptr);
        }
        close(pipefd[0]);
        close(pipefd[1]);
    }

    void Session::enter(bool clear) {
        if (active) {
            return;
        }
        termios raw = original;
        cfmakeraw(&raw);
        raw.c_cc[VMIN] = 1;
        raw.c_cc[VTIME] = 0;
        if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) < 0) {
            throw std::runtime_error("Cannot enter terminal mode");
        }
        active = true;
        terminal_active = 1;
        write_all(STDOUT_FILENO, "\033[?1049h\033[?25l\033[?1004h\033[0m\033[48;2;0;0;0m");
        write_all(STDOUT_FILENO, clear ? "\033[2J\033[H" : "\033[H");
    }

    void Session::leave() {
        if (!active) {
            return;
        }
        write_all(STDOUT_FILENO, used_mouse ? terminal_restore : keyboard_restore);
        reporting.update(false);
        if (saved) {
            tcsetattr(STDIN_FILENO, TCSANOW, &original);
        }
        active = false;
        terminal_active = 0;
    }

    void Session::mouse_reporting(bool enabled) {
        used_mouse = used_mouse || enabled;
        mouse_used = used_mouse;
        write_all(STDOUT_FILENO, reporting.update(active && enabled));
    }

    bool Session::prepare_reload() {
        // The resumed process must restore the settings saved before raw mode.
        constexpr char digits[] = "0123456789abcdef";
        std::string encoded = used_mouse ? "1" : "0";
        const auto bytes = reinterpret_cast<const unsigned char *>(&original);
        for (size_t index = 0; index < sizeof(termios); ++index) {
            encoded += digits[bytes[index] >> 4];
            encoded += digits[bytes[index] & 15];
        }
        return setenv("BITFROST_TUI_TERMIOS", encoded.c_str(), 1) == 0;
    }

    void Session::cancel_reload() {
        unsetenv("BITFROST_TUI_TERMIOS");
        leave();
        enter();
    }

    unsigned Session::signals() {
        char buffer[64];
        while (read(pipefd[0], buffer, sizeof(buffer)) > 0) {
        }
        sigset_t blocked_signals, previous_mask;
        sigemptyset(&blocked_signals);
        for (int signal_number : signal_numbers) {
            sigaddset(&blocked_signals, signal_number);
        }
        sigprocmask(SIG_BLOCK, &blocked_signals, &previous_mask);
        unsigned pending_signals = unsigned(flags);
        flags = 0;
        sigprocmask(SIG_SETMASK, &previous_mask, nullptr);
        return pending_signals;
    }

    std::pair<int, int> Session::size() const {
        winsize dimensions{};
        if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &dimensions) == 0 && dimensions.ws_col && dimensions.ws_row) {
            return {dimensions.ws_col, dimensions.ws_row};
        }
        return {80, 24};
    }

    void Session::suspend() {
        leave();
        ::kill(getpid(), SIGSTOP);
        enter();
    }
}
