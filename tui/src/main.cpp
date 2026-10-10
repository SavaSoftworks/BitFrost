// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "app/options.hpp"
#include "rpc/broker.hpp"
#include "term/caps.hpp"
#include "term/gamepad.hpp"
#include "term/output.hpp"
#include "term/session.hpp"
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <clocale>
#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <iostream>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>

namespace {
    // Detaches the browser with a double fork. The middle child exits at once
    // and gets reaped here, so the UI never blocks and no zombie is left.
    // Starts the browser in its own session with no terminal, and waits only for it to start.
    bool open_in_browser(const std::string &url) {
        if (!url.starts_with("https://") && !url.starts_with("http://")) {
            return false;
        }
        int started[2];
        if (pipe(started) < 0) {
            return false;
        }
        fcntl(started[0], F_SETFD, FD_CLOEXEC);
        fcntl(started[1], F_SETFD, FD_CLOEXEC);
        pid_t middle = fork();
        if (middle < 0) {
            close(started[0]);
            close(started[1]);
            return false;
        }
        if (middle == 0) {
            close(started[0]);
            setsid();
            int null_fd = open("/dev/null", O_RDWR);
            if (null_fd >= 0) {
                dup2(null_fd, STDIN_FILENO);
                dup2(null_fd, STDOUT_FILENO);
                dup2(null_fd, STDERR_FILENO);
                if (null_fd > STDERR_FILENO) {
                    close(null_fd);
                }
            }
            pid_t browser = fork();
            if (browser == 0) {
                // The TUI ignores SIGPIPE, and an ignored signal survives exec.
                signal(SIGPIPE, SIG_DFL);
#ifdef __APPLE__
                const char *tool = "open";
#else
                const char *tool = "xdg-open";
#endif
                char *arguments[] = {const_cast<char *>(tool), const_cast<char *>(url.c_str()), nullptr};
                execvp(tool, arguments);
                // Exec failed, so say so; on success exec closes the pipe instead.
                char failed = 1;
                (void)!write(started[1], &failed, 1);
                _exit(127);
            }
            if (browser < 0) {
                char failed = 1;
                (void)!write(started[1], &failed, 1);
            }
            _exit(0);
        }
        close(started[1]);
        while (waitpid(middle, nullptr, 0) < 0 && errno == EINTR) {
        }
        char failed = 0;
        ssize_t got;
        while ((got = read(started[0], &failed, 1)) < 0 && errno == EINTR) {
        }
        close(started[0]);
        return got == 0;
    }
}

// I was originally going to put model config, and stats inside claude via ui mods,
// but then I noticed it just lets you create Boxes and Lines or wtv, and you really don't
// have a log of flexibility for design, so here, have some c++
int main(int argc, char **argv) {
    std::setlocale(LC_ALL, "");
    if (MB_CUR_MAX == 1 && !std::setlocale(LC_CTYPE, "C.UTF-8")) {
        std::setlocale(LC_CTYPE, "en_US.UTF-8");
    }
    bf::Options options;
    options.animations = !(std::getenv("BITFROST_NO_ANIM") && std::string_view(std::getenv("BITFROST_NO_ANIM")) == "1");
    options.mouse = !(std::getenv("BITFROST_NO_MOUSE") && std::string_view(std::getenv("BITFROST_NO_MOUSE")) == "1");
    options.gamepad =
        !(std::getenv("BITFROST_NO_GAMEPAD") && std::string_view(std::getenv("BITFROST_NO_GAMEPAD")) == "1");
    for (int index = 1; index < argc; ++index) {
        std::string_view argument = argv[index];
        if (!options.parse(argument)) {
            std::cerr << "Usage: bitfrost-tui [--version | --selftest | --no-anim | --no-mouse | --resume | "
                         "--message=text]\n";
            return 1;
        }
    }
    if (options.version) {
        std::cout << BITFROST_VERSION << '\n';
        return 0;
    }
    if (options.selftest) {
        return bf::selftest();
    }
    bool animations = options.animations;
    struct sigaction ignore{}, previous_sigpipe{};
    ignore.sa_handler = SIG_IGN;
    sigemptyset(&ignore.sa_mask);
    sigaction(SIGPIPE, &ignore, &previous_sigpipe);
    int result = 0;
    try {
        bf::Session session(options.resume);
        auto broker = std::make_unique<bf::Broker>();
        bf::InputParser input;
        auto gamepads = options.gamepad ? std::make_unique<bf::Gamepads>() : nullptr;
        bool focused = true;
        bf::App app(
            [&](const bf::Json &request) { broker->send(request); },
            animations,
            options.mouse,
            options.resume,
            options.message,
            open_in_browser
        );
        app.set_controller(gamepads ? gamepads->connected() : std::nullopt);
        app.start();
        if (!broker->error().empty()) {
            app.error(broker->error());
        }
        bf::Diff output(bf::truecolor_terminal());
        auto [width, height] = session.size();
        bf::Grid grid(width, height);
        using Clock = std::chrono::steady_clock;
        constexpr auto frame_time = std::chrono::nanoseconds(33333333);
        auto next = Clock::now();
        auto last_step = next;
        bool dirty = true;
        std::string last_error = broker->error();
        while (app.alive()) {
            auto now = Clock::now();
            bool frame_due = now >= next;
            if (frame_due) {
                dirty = app.step(std::chrono::duration<double>(now - last_step).count()) || dirty;
                last_step = now;
            }
            session.mouse_reporting(app.mouse_reporting());
            if (frame_due) {
                dirty = animations || dirty;
                next = now + frame_time;
            }
            if (dirty && frame_due) {
                app.render(grid);
                if (!bf::write_all(STDOUT_FILENO, output.frame(grid))) {
                    break;
                }
                dirty = false;
                app.presented();
            }
            if (!app.restart_version().empty()) {
                const char *launcher_env = std::getenv("BITFROST_LAUNCHER");
                std::string launcher = launcher_env ? launcher_env : "";
                if (!launcher.empty() && session.prepare_reload()) {
                    if (!options.animations) {
                        setenv("BITFROST_NO_ANIM", "1", 1);
                    }
                    if (!options.mouse) {
                        setenv("BITFROST_NO_MOUSE", "1", 1);
                    }
                    if (!options.gamepad) {
                        setenv("BITFROST_NO_GAMEPAD", "1", 1);
                    }
                    // A pretend version only tests the check; the new version is the real one.
                    unsetenv("BITFROST_PRETEND_VERSION");
                    std::string message = "--message=Updated to " + app.restart_version();
                    char *arguments[] = {
                        launcher.data(),
                        const_cast<char *>("config"),
                        const_cast<char *>("--resume"),
                        message.data(),
                        nullptr
                    };
                    broker->close_stdin();
                    broker.reset();
                    execv(launcher.c_str(), arguments);
                    broker = std::make_unique<bf::Broker>();
                    app.start();
                    last_error = broker->error();
                }
                session.cancel_reload();
                app.restart_failed();
                output.reset();
                dirty = true;
            }
            int timeout =
                animations || dirty
                    ? std::max(
                          0,
                          int(std::chrono::duration_cast<std::chrono::milliseconds>(next - Clock::now()).count()) + 1
                      )
                : app.needs_tick() ? app.tick_timeout_ms()
                                   : -1;
            for (int wait : {input.timeout_ms(), gamepads ? gamepads->timeout_ms(Clock::now()) : -1}) {
                if (wait >= 0) {
                    timeout = timeout < 0 ? wait : std::min(timeout, wait);
                }
            }
            std::vector<pollfd> descriptors = {
                {STDIN_FILENO, POLLIN, 0},
                {session.signal_fd(), POLLIN, 0},
                {broker->read_fd(), POLLIN, 0},
                {broker->write_fd(), POLLOUT, 0}
            };
            if (gamepads) {
                for (int descriptor : gamepads->descriptors()) {
                    descriptors.push_back({descriptor, POLLIN, 0});
                }
            }
            int ready = poll(descriptors.data(), nfds_t(descriptors.size()), timeout);
            if (ready < 0 && errno != EINTR) {
                throw std::runtime_error("Terminal poll failed");
            }
            if (descriptors[0].revents & (POLLIN | POLLHUP)) {
                char bytes[4096];
                ssize_t bytes_read = read(STDIN_FILENO, bytes, sizeof(bytes));
                if (bytes_read == 0) {
                    break;
                }
                if (bytes_read > 0) {
                    for (ssize_t index = 0; index < bytes_read; ++index) {
                        for (const auto &event : input.feed(std::string_view(bytes + index, 1), app.text_input())) {
                            if (event.key == bf::Key::FocusIn || event.key == bf::Key::FocusOut) {
                                focused = event.key == bf::Key::FocusIn;
                                if (gamepads && !focused) {
                                    gamepads->release();
                                }
                            } else if (event.key == bf::Key::Suspend) {
                                session.suspend();
                                app.mouse(std::nullopt);
                                output.reset();
                                dirty = true;
                            } else {
                                if (event.mouse) {
                                    dirty = app.mouse_input(*event.mouse) || dirty;
                                } else {
                                    app.input(event);
                                    dirty = true;
                                }
                            }
                        }
                    }
                    if (auto pointer = input.take_mouse()) {
                        dirty = app.mouse(pointer) || dirty;
                    }
                }
            }
            for (const auto &event : input.expire()) {
                app.input(event);
                dirty = true;
            }
            if (descriptors[1].revents & POLLIN) {
                auto signals = session.signals();
                if (signals & bf::Terminate) {
                    break;
                }
                if (signals & bf::Suspend) {
                    session.suspend();
                    app.mouse(std::nullopt);
                }
                if (signals & bf::Continue) {
                    session.enter();
                }
                if (signals & (bf::Resize | bf::Continue | bf::Suspend)) {
                    auto [columns, rows] = session.size();
                    grid = bf::Grid(columns, rows);
                    output.reset();
                    dirty = true;
                }
            }
            if (descriptors[2].revents & (POLLIN | POLLHUP | POLLERR)) {
                for (const auto &reply : broker->read()) {
                    app.receive(reply);
                }
                dirty = true;
            }
            if (descriptors[3].revents & (POLLOUT | POLLHUP | POLLERR)) {
                broker->flush();
            }
            // A controller only steers while this terminal has focus; its events are still read and dropped.
            if (gamepads) {
                auto now = Clock::now();
                std::vector<bf::Input> pressed;
                for (size_t index = 4; index < descriptors.size(); ++index) {
                    if (descriptors[index].revents & (POLLIN | POLLHUP | POLLERR)) {
                        for (bf::Input &event : gamepads->read(descriptors[index].fd, now)) {
                            pressed.push_back(std::move(event));
                        }
                    }
                }
                for (bf::Input &event : gamepads->repeat(now)) {
                    pressed.push_back(std::move(event));
                }
                if (!focused) {
                    gamepads->release();
                    pressed.clear();
                }
                dirty = app.set_controller(gamepads->connected()) || dirty;
                for (const bf::Input &event : pressed) {
                    app.input(event);
                    dirty = true;
                }
            }
            if (broker->error() != last_error) {
                last_error = broker->error();
                app.error(last_error);
                dirty = true;
            }
        }
        app.stop();
    } catch (const std::exception &exception) {
        std::cerr << "BitFrost: " << exception.what() << '\n';
        result = 1;
    }
    sigaction(SIGPIPE, &previous_sigpipe, nullptr);
    return result;
}
