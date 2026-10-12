// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "text.hpp"
#include "rpc/json.hpp"
#include <algorithm>
#include <cwchar>

namespace bf {
    std::vector<Rune> runes(std::string_view text) {
        std::vector<Rune> decoded;
        for (size_t position = 0; position < text.size();) {
            unsigned char byte = text[position];
            size_t byte_count = byte < 128 ? 1 : byte < 224 ? 2 : byte < 240 ? 3 : 4;
            if (position + byte_count > text.size() || !valid_utf8(text.substr(position, byte_count))) {
                decoded.push_back({"?", 1});
                ++position;
                continue;
            }
            uint32_t code_point = byte & (byte_count == 1 ? 127 : ((1u << (7 - byte_count)) - 1));
            for (size_t index = 1; index < byte_count; ++index) {
                code_point = (code_point << 6) | (static_cast<unsigned char>(text[position + index]) & 63);
            }
            int columns = ::wcwidth(wchar_t(code_point));
            if (columns < 0 || code_point < 32 || (code_point >= 127 && code_point < 160)) {
                decoded.push_back({"?", 1});
            } else {
                decoded.push_back({std::string(text.substr(position, byte_count)), columns});
            }
            position += byte_count;
        }
        return decoded;
    }

    int text_width(std::string_view text) {
        int width = 0;
        for (auto &rune : runes(text)) {
            width += rune.width;
        }
        return width;
    }

    std::string ellipsis(std::string_view text, int width) {
        if (width <= 0) {
            return {};
        }
        if (text_width(text) <= width) {
            return std::string(text);
        }
        std::string output;
        int used = 0;
        for (auto &rune : runes(text)) {
            if (used + rune.width > width - 1) {
                break;
            }
            output += rune.bytes;
            used += rune.width;
        }
        return output + "…";
    }

    std::string middle_ellipsis(std::string_view text, int width) {
        if (width <= 0) {
            return {};
        }
        if (text_width(text) <= width) {
            return std::string(text);
        }
        auto slash = text.find_last_of('/');
        int suffix_width = slash == std::string_view::npos ? width / 2 : text_width(text.substr(slash + 1));
        suffix_width = std::min(suffix_width, (width - 1) * 2 / 3);
        auto decoded = runes(text);
        std::string suffix;
        int used = 0;
        for (auto rune = decoded.rbegin(); rune != decoded.rend(); ++rune) {
            if (used + rune->width > suffix_width) {
                break;
            }
            suffix = rune->bytes + suffix;
            used += rune->width;
        }
        return ellipsis(text, width - used) + suffix;
    }
}
