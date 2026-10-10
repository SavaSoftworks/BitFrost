// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "broker.hpp"
#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>

namespace bf {
    Broker::Broker() {
        const char *command = std::getenv("BITFROST_TUI_BROKER");
        const char *node = std::getenv("BITFROST_NODE");
        const char *entry = std::getenv("BITFROST_ENTRY");
        if ((!command || !*command) && (!node || !*node || !entry || !*entry)) {
            failure = "BitFrost helper not found";
            return;
        }
        int input_pipe[2], output_pipe[2];
        if (pipe(input_pipe) < 0) {
            failure = "Cannot create helper pipe";
            return;
        }
        if (pipe(output_pipe) < 0) {
            close(input_pipe[0]);
            close(input_pipe[1]);
            failure = "Cannot create helper pipe";
            return;
        }
        for (int descriptor : {input_pipe[0], input_pipe[1], output_pipe[0], output_pipe[1]}) {
            fcntl(descriptor, F_SETFD, FD_CLOEXEC);
        }
        child = fork();
        if (child == 0) {
            dup2(input_pipe[0], STDIN_FILENO);
            dup2(output_pipe[1], STDOUT_FILENO);
            const char *log = std::getenv("BITFROST_TUI_LOG");
            int error_fd = open(log && *log ? log : "/dev/null", O_WRONLY | O_CREAT | O_APPEND, 0600);
            if (error_fd >= 0) {
                dup2(error_fd, STDERR_FILENO);
                if (error_fd > 2) {
                    close(error_fd);
                }
            }
            for (int descriptor : {input_pipe[0], input_pipe[1], output_pipe[0], output_pipe[1]}) {
                if (descriptor > 2) {
                    close(descriptor);
                }
            }
            if (command && *command) {
                execl("/bin/sh", "sh", "-c", command, static_cast<char *>(nullptr));
            } else {
                execl(
                    node,
                    node,
                    "--disable-warning=ExperimentalWarning",
                    entry,
                    "tui-rpc",
                    static_cast<char *>(nullptr)
                );
            }
            _exit(127);
        }
        close(input_pipe[0]);
        close(output_pipe[1]);
        if (child < 0) {
            close(input_pipe[1]);
            close(output_pipe[0]);
            failure = "Cannot start BitFrost helper";
            return;
        }
        input = input_pipe[1];
        output = output_pipe[0];
        fcntl(input, F_SETFL, O_NONBLOCK);
        fcntl(output, F_SETFL, O_NONBLOCK);
    }

    Broker::~Broker() {
        close_stdin();
        if (output >= 0) {
            close(output);
        }
        if (child > 0) {
            for (int attempt = 0; attempt < 20; ++attempt) {
                if (waitpid(child, nullptr, WNOHANG) == child) {
                    return;
                }
                poll(nullptr, 0, 10);
            }
        }
    }

    void Broker::close_stdin() {
        if (input >= 0) {
            close(input);
            input = -1;
        }
        queued.clear();
    }

    void Broker::send(const Json &request) {
        if (input < 0) {
            return;
        }
        if (queued.size() > 1024 * 1024) {
            failure = "BitFrost helper is not reading requests";
            return;
        }
        queued += request.dump() + '\n';
        flush();
    }

    void Broker::flush() {
        while (input >= 0 && !queued.empty()) {
            ssize_t bytes_count = write(input, queued.data(), queued.size());
            if (bytes_count < 0 && errno == EINTR) {
                continue;
            }
            if (bytes_count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                return;
            }
            if (bytes_count <= 0) {
                failure = "BitFrost helper disconnected";
                close(input);
                input = -1;
                queued.clear();
                return;
            }
            queued.erase(0, size_t(bytes_count));
        }
    }

    std::vector<Json> Broker::read() {
        std::vector<Json> messages;
        char buffer[8192];
        while (output >= 0) {
            ssize_t bytes_count = ::read(output, buffer, sizeof(buffer));
            if (bytes_count < 0 && errno == EINTR) {
                continue;
            }
            if (bytes_count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                break;
            }
            if (bytes_count <= 0) {
                failure = "BitFrost helper disconnected";
                close(output);
                output = -1;
                break;
            }
            received.append(buffer, size_t(bytes_count));
            if (received.size() > 8 * 1024 * 1024) {
                failure = "BitFrost helper reply is too large";
                close(output);
                output = -1;
                received.clear();
                break;
            }
            size_t newline;
            while ((newline = received.find('\n')) != std::string::npos) {
                try {
                    if (newline) {
                        messages.push_back(Json::parse(std::string_view(received).substr(0, newline)));
                    }
                } catch (const std::exception &) {
                    failure = "Invalid JSON from BitFrost helper";
                }
                received.erase(0, newline + 1);
            }
        }
        return messages;
    }
}
