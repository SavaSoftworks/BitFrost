// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "rpc/json.hpp"

namespace bf {
    std::string compact(double number);
    std::string shown(const Json &value);
    std::string setting_value(const Json &setting);
    std::string date(const Json &value);
    std::string duration(double milliseconds);
    std::string app_name(std::string_view id);
    std::string listed_age(double milliseconds);
}
