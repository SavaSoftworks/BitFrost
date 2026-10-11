// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "json.hpp"
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <locale.h>
#include <locale>
#include <sstream>
#include <stdexcept>
#ifdef __APPLE__
#include <xlocale.h>
#endif

namespace bf {
    std::string utf8(uint32_t code_point) {
        std::string output;
        if (code_point < 0x80) {
            output += char(code_point);
        } else if (code_point < 0x800) {
            output += char(0xc0 | (code_point >> 6));
            output += char(0x80 | (code_point & 63));
        } else if (code_point < 0x10000) {
            output += char(0xe0 | (code_point >> 12));
            output += char(0x80 | ((code_point >> 6) & 63));
            output += char(0x80 | (code_point & 63));
        } else {
            output += char(0xf0 | (code_point >> 18));
            output += char(0x80 | ((code_point >> 12) & 63));
            output += char(0x80 | ((code_point >> 6) & 63));
            output += char(0x80 | (code_point & 63));
        }
        return output;
    }

    bool valid_utf8(std::string_view text) {
        for (size_t position = 0; position < text.size();) {
            unsigned char byte = text[position++];
            if (byte < 0x80) {
                continue;
            }
            int continuations = byte >= 0xc2 && byte <= 0xdf   ? 1
                                : byte >= 0xe0 && byte <= 0xef ? 2
                                : byte >= 0xf0 && byte <= 0xf4 ? 3
                                                               : -1;
            if (continuations < 0 || position + continuations > text.size()) {
                return false;
            }
            uint32_t code_point = byte & ((1u << (6 - continuations)) - 1);
            for (int index = 0; index < continuations; ++index) {
                byte = text[position++];
                if ((byte & 0xc0) != 0x80) {
                    return false;
                }
                code_point = (code_point << 6) | (byte & 63);
            }
            if (code_point < (continuations == 1   ? 0x80u
                              : continuations == 2 ? 0x800u
                                                   : 0x10000u) ||
                code_point > 0x10ffff || (code_point >= 0xd800 && code_point <= 0xdfff)) {
                return false;
            }
        }
        return true;
    }
    namespace {
#ifndef BITFROST_FLOAT_CHARCONV
        struct NumericLocale {
            locale_t value = newlocale(LC_NUMERIC_MASK, "C", nullptr);
            NumericLocale() {
                if (!value) {
                    throw std::runtime_error("Cannot create JSON numeric locale");
                }
            }
            ~NumericLocale() {
                freelocale(value);
            }
        };
#endif
        struct Parser {
            std::string_view source;
            size_t position = 0;
            [[noreturn]] void fail() const {
                throw std::runtime_error("Invalid JSON at byte " + std::to_string(position));
            }
            void skip_whitespace() {
                while (position < source.size() && (source[position] == ' ' || source[position] == '\r' ||
                                                    source[position] == '\n' || source[position] == '\t')) {
                    ++position;
                }
            }
            bool take(char code_point) {
                skip_whitespace();
                if (position < source.size() && source[position] == code_point) {
                    ++position;
                    return true;
                }
                return false;
            }
            uint32_t read_hex_quad() {
                uint32_t code_point = 0;
                for (int digit_index = 0; digit_index < 4; ++digit_index) {
                    if (position == source.size()) {
                        fail();
                    }
                    char byte = source[position++];
                    int decoded = byte >= '0' && byte <= '9'   ? byte - '0'
                                  : byte >= 'a' && byte <= 'f' ? byte - 'a' + 10
                                  : byte >= 'A' && byte <= 'F' ? byte - 'A' + 10
                                                               : -1;
                    if (decoded < 0) {
                        fail();
                    }
                    code_point = code_point * 16 + unsigned(decoded);
                }
                return code_point;
            }
            std::string string() {
                if (!take('"')) {
                    fail();
                }
                std::string output;
                while (position < source.size()) {
                    unsigned char byte = source[position++];
                    if (byte == '"') {
                        if (!valid_utf8(output)) {
                            fail();
                        }
                        return output;
                    }
                    if (byte < 32) {
                        fail();
                    }
                    if (byte != '\\') {
                        output += char(byte);
                        continue;
                    }
                    if (position == source.size()) {
                        fail();
                    }
                    switch (source[position++]) {
                    case '"':
                        output += '"';
                        break;
                    case '\\':
                        output += '\\';
                        break;
                    case '/':
                        output += '/';
                        break;
                    case 'b':
                        output += '\b';
                        break;
                    case 'f':
                        output += '\f';
                        break;
                    case 'n':
                        output += '\n';
                        break;
                    case 'r':
                        output += '\r';
                        break;
                    case 't':
                        output += '\t';
                        break;
                    case 'u': {
                        uint32_t code_point = read_hex_quad();
                        if (code_point >= 0xd800 && code_point <= 0xdbff) {
                            if (position + 2 > source.size() || source.substr(position, 2) != "\\u") {
                                fail();
                            }
                            position += 2;
                            uint32_t low_surrogate = read_hex_quad();
                            if (low_surrogate < 0xdc00 || low_surrogate > 0xdfff) {
                                fail();
                            }
                            code_point = 0x10000 + ((code_point - 0xd800) << 10) + low_surrogate - 0xdc00;
                        } else if (code_point >= 0xdc00 && code_point <= 0xdfff) {
                            fail();
                        }
                        output += utf8(code_point);
                        break;
                    }
                    default:
                        fail();
                    }
                }
                fail();
            }
            Json read(int depth = 0) {
                if (depth > 64) {
                    fail();
                }
                skip_whitespace();
                if (position == source.size()) {
                    fail();
                }
                if (source[position] == '"') {
                    return string();
                }
                if (take('{')) {
                    Json::Object object_value;
                    if (take('}')) {
                        return object_value;
                    }
                    do {
                        std::string key = string();
                        if (!take(':')) {
                            fail();
                        }
                        Json decoded = read(depth + 1);
                        if (!object_value.emplace(std::move(key), std::move(decoded)).second) {
                            fail();
                        }
                    } while (take(','));
                    if (!take('}')) {
                        fail();
                    }
                    return object_value;
                }
                if (take('[')) {
                    Json::Array array_value;
                    if (take(']')) {
                        return array_value;
                    }
                    do {
                        array_value.push_back(read(depth + 1));
                    } while (take(','));
                    if (!take(']')) {
                        fail();
                    }
                    return array_value;
                }
                for (auto [literal, decoded] :
                     {std::pair{"true", Json(true)}, {"false", Json(false)}, {"null", Json()}}) {
                    if (source.substr(position, std::char_traits<char>::length(literal)) == literal) {
                        position += std::char_traits<char>::length(literal);
                        return decoded;
                    }
                }
                size_t start = position;
                if (source[position] == '-') {
                    ++position;
                }
                if (position == source.size()) {
                    fail();
                }
                if (source[position] == '0') {
                    ++position;
                } else {
                    if (source[position] < '1' || source[position] > '9') {
                        fail();
                    }
                    while (position < source.size() && source[position] >= '0' && source[position] <= '9') {
                        ++position;
                    }
                }
                bool integral = true;
                if (position < source.size() && source[position] == '.') {
                    integral = false;
                    ++position;
                    size_t digits_start = position;
                    while (position < source.size() && source[position] >= '0' && source[position] <= '9') {
                        ++position;
                    }
                    if (position == digits_start) {
                        fail();
                    }
                }
                if (position < source.size() && (source[position] == 'e' || source[position] == 'E')) {
                    integral = false;
                    ++position;
                    if (position < source.size() && (source[position] == '+' || source[position] == '-')) {
                        ++position;
                    }
                    size_t digits_start = position;
                    while (position < source.size() && source[position] >= '0' && source[position] <= '9') {
                        ++position;
                    }
                    if (position == digits_start) {
                        fail();
                    }
                }
                auto token = source.substr(start, position - start);
                if (integral) {
                    int64_t number;
                    auto conversion = std::from_chars(token.data(), token.data() + token.size(), number);
                    if (conversion.ec == std::errc()) {
                        return number;
                    }
                }
                double number;
#ifdef BITFROST_FLOAT_CHARCONV
                auto conversion = std::from_chars(token.data(), token.data() + token.size(), number);
                if (conversion.ec != std::errc() || !std::isfinite(number)) {
                    fail();
                }
#else
                static const NumericLocale locale;
                std::string terminated(token);
                char *end = nullptr;
                errno = 0;
                number = strtod_l(terminated.c_str(), &end, locale.value);
                // ERANGE also covers representable subnormals, which remain valid JSON numbers.
                if (end != terminated.c_str() + terminated.size() || !std::isfinite(number) ||
                    (errno == ERANGE && number == 0)) {
                    fail();
                }
#endif
                return number;
            }
        };
        std::string quote(std::string_view text) {
            if (!valid_utf8(text)) {
                throw std::runtime_error("Invalid UTF-8");
            }
            std::string output = "\"";
            constexpr char read_hex_quad[] = "0123456789abcdef";
            for (unsigned char byte : text) {
                switch (byte) {
                case '"':
                    output += "\\\"";
                    break;
                case '\\':
                    output += "\\\\";
                    break;
                case '\b':
                    output += "\\b";
                    break;
                case '\f':
                    output += "\\f";
                    break;
                case '\n':
                    output += "\\n";
                    break;
                case '\r':
                    output += "\\r";
                    break;
                case '\t':
                    output += "\\t";
                    break;
                default:
                    if (byte < 32) {
                        output += "\\u00";
                        output += read_hex_quad[byte >> 4];
                        output += read_hex_quad[byte & 15];
                    } else {
                        output += char(byte);
                    }
                }
            }
            return output + '"';
        }
    }

    Json Json::parse(std::string_view source) {
        Parser parser{source};
        auto parsed_value = parser.read();
        parser.skip_whitespace();
        if (parser.position != source.size()) {
            parser.fail();
        }
        return parsed_value;
    }

    std::string Json::dump() const {
        return std::visit(
            [](const auto &stored_value) -> std::string {
                using T = std::decay_t<decltype(stored_value)>;
                if constexpr (std::is_same_v<T, std::nullptr_t>) {
                    return "null";
                } else if constexpr (std::is_same_v<T, bool>) {
                    return stored_value ? "true" : "false";
                } else if constexpr (std::is_same_v<T, int64_t>) {
                    return std::to_string(stored_value);
                } else if constexpr (std::is_same_v<T, double>) {
                    if (!std::isfinite(stored_value)) {
                        throw std::runtime_error("Non-finite JSON number");
                    }
#ifdef BITFROST_FLOAT_CHARCONV
                    char buffer[64];
                    auto conversion = std::to_chars(
                        buffer,
                        buffer + sizeof(buffer),
                        stored_value,
                        std::chars_format::general,
                        std::numeric_limits<double>::max_digits10
                    );
                    return std::string(buffer, conversion.ptr);
#else
                    std::ostringstream output;
                    output.imbue(std::locale::classic());
                    output << std::setprecision(std::numeric_limits<double>::max_digits10) << stored_value;
                    return output.str();
#endif
                } else if constexpr (std::is_same_v<T, std::string>) {
                    return quote(stored_value);
                } else {
                    std::string output = std::is_same_v<T, Array> ? "[" : "{";
                    bool first = true;
                    for (const auto &entry : stored_value) {
                        if (!first) {
                            output += ',';
                        }
                        first = false;
                        if constexpr (std::is_same_v<T, Array>) {
                            output += entry.dump();
                        } else {
                            output += quote(entry.first) + ':' + entry.second.dump();
                        }
                    }
                    return output + (std::is_same_v<T, Array> ? ']' : '}');
                }
            },
            value
        );
    }

    const Json &Json::operator[](std::string_view key) const {
        static const Json empty;
        if (auto object_value = std::get_if<Object>(&value)) {
            auto entry = object_value->find(key);
            if (entry != object_value->end()) {
                return entry->second;
            }
        }
        return empty;
    }

    Json &Json::operator[](std::string_view key) {
        if (!std::holds_alternative<Object>(value)) {
            value = Object{};
        }
        return std::get<Object>(value)[std::string(key)];
    }

    const Json::Array &Json::array() const {
        static const Array empty;
        if (auto array_value = std::get_if<Array>(&value)) {
            return *array_value;
        }
        return empty;
    }

    const Json::Object &Json::object() const {
        static const Object empty;
        if (auto object_value = std::get_if<Object>(&value)) {
            return *object_value;
        }
        return empty;
    }

    std::string Json::str(std::string fallback) const {
        if (auto string_value = std::get_if<std::string>(&value)) {
            return *string_value;
        }
        return fallback;
    }

    double Json::number(double fallback) const {
        if (auto double_value = std::get_if<double>(&value)) {
            return *double_value;
        }
        if (auto integer_value = std::get_if<int64_t>(&value)) {
            return double(*integer_value);
        }
        return fallback;
    }

    int64_t Json::integer(int64_t fallback) const {
        if (auto integer_value = std::get_if<int64_t>(&value)) {
            return *integer_value;
        }
        if (auto double_value = std::get_if<double>(&value); double_value && *double_value >= -9223372036854775808.0 &&
                                                             *double_value < 9223372036854775808.0 &&
                                                             std::floor(*double_value) == *double_value) {
            return int64_t(*double_value);
        }
        return fallback;
    }

    bool Json::boolean(bool fallback) const {
        if (auto bool_value = std::get_if<bool>(&value)) {
            return *bool_value;
        }
        return fallback;
    }
}
