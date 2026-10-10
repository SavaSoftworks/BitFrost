// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "json.hpp"
#include <string>
#include <sys/types.h>
#include <vector>

namespace bf {
    class Broker {
        pid_t child = -1;
        int input = -1, output = -1;
        std::string received, queued;
        std::string failure;

      public:
        Broker();
        ~Broker();
        Broker(const Broker &) = delete;
        Broker &operator=(const Broker &) = delete;
        int read_fd() const {
            return output;
        }
        int write_fd() const {
            return queued.empty() ? -1 : input;
        }
        std::string error() const {
            return failure;
        }
        void send(const Json &request);
        void flush();
        void close_stdin();
        std::vector<Json> read();
    };
}
