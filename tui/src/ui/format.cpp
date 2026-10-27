// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "format.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <sstream>

namespace bf {
    std::string app_name(std::string_view id) {
        constexpr std::pair<std::string_view, std::string_view> names[]{
            {"codex", "Codex"},
            {"zcode", "ZCode"},
            {"opencode", "OpenCode"},
            {"oh-my-pi", "Oh My Pi"},
            {"omp", "Oh My Pi"},
            {"gemini", "Gemini CLI"},
            {"crush", "Crush"},
            {"grok", "Grok Build"},
            {"agy", "Antigravity"}
        };
        for (auto [key, name] : names) {
            if (id == key) {
                return std::string(name);
            }
        }
        return std::string(id);
    }

    std::string listed_age(double milliseconds) {
        int64_t seconds = int64_t(std::max(0.0, milliseconds) / 1000);
        std::string age;
        if (seconds >= 86400) {
            age += std::to_string(seconds / 86400) + "d ";
            seconds %= 86400;
        }
        if (seconds >= 3600) {
            age += std::to_string(seconds / 3600) + "h ";
            seconds %= 3600;
        }
        if (seconds >= 60) {
            age += std::to_string(seconds / 60) + "m ";
        }
        return "listed " + age + std::to_string(seconds % 60) + "s ago";
    }

    std::string compact(double number) {
        std::ostringstream stream;
        if (number >= 1000000) {
            stream << std::fixed << std::setprecision(1) << number / 1000000 << 'M';
        } else if (number >= 1000) {
            stream << std::fixed << std::setprecision(1) << number / 1000 << 'k';
        } else {
            stream << std::fixed << std::setprecision(0) << number;
        }
        return stream.str();
    }

    std::string shown(const Json &value) {
        if (std::holds_alternative<std::string>(value.value)) {
            return value.str().empty() ? "(empty)" : value.str();
        }
        if (std::holds_alternative<bool>(value.value)) {
            return value.boolean() ? "On" : "Off";
        }
        if (std::holds_alternative<Json::Array>(value.value)) {
            return std::to_string(value.array().size()) + (value.array().size() == 1 ? " item" : " items");
        }
        return value.null() ? "Default" : value.dump();
    }

    std::string setting_value(const Json &setting) {
        const Json &value = setting["value"];
        std::string type = setting["type"].str();
        if (type == "bool") {
            const auto &states = setting["states"].array();
            return states.size() == 2 ? states[size_t(value.boolean())].str() : value.boolean() ? "On" : "Off";
        }
        if (type == "list") {
            std::string result;
            for (const Json &entry : value.array()) {
                result += (result.empty() ? "" : ", ") + entry.str(entry.dump());
            }
            return value.array().empty() ? "none" : result;
        }
        if (setting["label"].str() == "Location") {
            if (!value.str().empty()) {
                return value.str() + " (set by you)";
            }
            auto found = setting.object().find("found");
            return found == setting.object().end() ? "automatic"
                   : found->second.null()          ? "not found"
                                                   : found->second.str() + " (found automatically)";
        }
        if (type == "text") {
            return value.str();
        }
        std::string unit = setting["unit"].str();
        return shown(value) + (unit.empty() ? "" : " " + unit);
    }

    std::string date(const Json &value) {
        if (value.null()) {
            return "Never";
        }
        time_t timestamp = time_t(value.number() / 1000);
        tm local_time{};
        if (!localtime_r(&timestamp, &local_time)) {
            return "Unknown";
        }
        time_t now = std::time(nullptr);
        tm today{};
        if (localtime_r(&now, &today)) {
            if (local_time.tm_year == today.tm_year && local_time.tm_yday == today.tm_yday) {
                return "Today";
            }
            today.tm_mday -= 1;
            today.tm_isdst = -1;
            std::mktime(&today);
            if (local_time.tm_year == today.tm_year && local_time.tm_yday == today.tm_yday) {
                return "Yesterday";
            }
        }
        constexpr const char
            *months[]{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
        return std::string(months[local_time.tm_mon]) + ' ' + std::to_string(local_time.tm_mday) + ", " +
               std::to_string(local_time.tm_year + 1900);
    }

    std::string duration(double milliseconds) {
        if (milliseconds < 1000) {
            return std::to_string(int(std::round(milliseconds))) + "ms";
        }
        double seconds = milliseconds / 1000;
        return std::to_string(int(std::round(seconds < 60 ? seconds : seconds / 60))) + (seconds < 60 ? "s" : "m");
    }
}
