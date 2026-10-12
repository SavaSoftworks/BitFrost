// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace bf {
    struct Json {
        using Array = std::vector<Json>;
        using Object = std::map<std::string, Json, std::less<>>;
        std::variant<std::nullptr_t, bool, int64_t, double, std::string, Array, Object> value;
        Json()
            : value(nullptr) {}
        Json(std::nullptr_t)
            : value(nullptr) {}
        Json(bool initial_value)
            : value(initial_value) {}
        Json(int initial_value)
            : value(int64_t(initial_value)) {}
        Json(int64_t initial_value)
            : value(initial_value) {}
        Json(double initial_value)
            : value(initial_value) {}
        Json(const char *initial_value)
            : value(std::string(initial_value)) {}
        Json(std::string initial_value)
            : value(std::move(initial_value)) {}
        Json(Array initial_value)
            : value(std::move(initial_value)) {}
        Json(Object initial_value)
            : value(std::move(initial_value)) {}
        static Json object(std::initializer_list<Object::value_type> initial_value) {
            return Object(initial_value);
        }
        static Json parse(std::string_view);
        std::string dump() const;
        const Json &operator[](std::string_view key) const;
        Json &operator[](std::string_view key);
        const Array &array() const;
        const Object &object() const;
        std::string str(std::string fallback = {}) const;
        double number(double fallback = 0) const;
        int64_t integer(int64_t fallback = 0) const;
        bool boolean(bool fallback = false) const;
        bool null() const {
            return std::holds_alternative<std::nullptr_t>(value);
        }
        bool operator==(const Json &) const = default;
    };
    std::string utf8(uint32_t code_point);
    bool valid_utf8(std::string_view text);
}
