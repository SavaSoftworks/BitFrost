// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include "json.hpp"

namespace bf {
    inline std::string_view model_unavailable_reason(const Json &model) {
        std::string reason = model["reason"].str();
        if (reason == "anthropic") {
            return "Anthropic, never offered";
        }
        return {};
    }

    inline bool model_toggle_allowed(const Json &model) {
        return model_unavailable_reason(model).empty();
    }
}
