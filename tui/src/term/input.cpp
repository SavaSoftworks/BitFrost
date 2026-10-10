// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "input.hpp"
#include "rpc/json.hpp"
#include <algorithm>
#include <charconv>

namespace bf {
    std::vector<Input> InputParser::feed(std::string_view bytes, bool editing) {
        std::vector<Input> events;
        if (mouse_at && timeout_ms() == 0) {
            events = expire();
        }
        pending += bytes;
        while (!pending.empty()) {
            if (mouse_sequence) {
                char next = pending[0];
                if (next == '\033') {
                    if (pending.size() == 1) {
                        if (!escape_at) {
                            escape_at = std::chrono::steady_clock::now();
                        }
                        break;
                    }
                    if (pending[1] != '[' && pending[1] != 'O') {
                        // Embedded junk is still part of the bad report. A real key sequence
                        // starts with CSI/SS3, while a lone Escape uses its ordinary timeout.
                        pending.erase(0, 1);
                        mouse_overflow = true;
                        escape_at.reset();
                        continue;
                    }
                }
                // A new escape or control key cannot be part of SGR coordinates. Recover without
                // swallowing it, even if a terminal report was cut off before its final M/m.
                if (static_cast<unsigned char>(next) < 32 || next == 127) {
                    mouse_sequence = mouse_overflow = false;
                    mouse_report.clear();
                    interrupted_sequence.clear();
                    mouse_at.reset();
                    continue;
                }
                pending.erase(0, 1);
                if (next == 'M' || next == 'm') {
                    int values[3]{};
                    const char *position = mouse_report.data();
                    const char *end = position + mouse_report.size();
                    bool valid = !mouse_overflow;
                    for (int index = 0; valid && index < 3; ++index) {
                        auto parsed = std::from_chars(position, end, values[index]);
                        valid = parsed.ec == std::errc{} && values[index] >= 0;
                        position = parsed.ptr;
                        if (index < 2) {
                            valid = valid && position < end && *position == ';';
                            if (valid) {
                                ++position;
                            }
                        }
                    }
                    if (valid && position == end && values[1] > 0 && values[2] > 0 && next == 'M') {
                        MousePosition cell{values[1] - 1, values[2] - 1};
                        if (values[0] & 64) {
                            if ((values[0] & 3) < 2) {
                                events.push_back(
                                    {Key::Mouse, {}, MouseEvent{cell, MouseKind::Wheel, (values[0] & 1) ? 1 : -1}}
                                );
                            }
                        } else if (values[0] & 32) {
                            mouse = cell;
                        } else if ((values[0] & 3) == 0) {
                            events.push_back({Key::Mouse, {}, MouseEvent{cell, MouseKind::Click, 0}});
                        }
                    }
                    mouse_sequence = mouse_overflow = false;
                    mouse_at.reset();
                    mouse_report.clear();
                    pending.insert(0, interrupted_sequence);
                    interrupted_sequence.clear();
                } else if (mouse_report.size() < 64) {
                    mouse_report += next;
                } else {
                    mouse_overflow = true;
                }
                continue;
            }
            unsigned char byte = pending[0];
            if (byte == 27) {
                if (!escape_at) {
                    escape_at = std::chrono::steady_clock::now();
                }
                if (pending.size() == 1) {
                    break;
                }
                if (pending[1] == '[' || pending[1] == 'O') {
                    if (pending[1] == '[' && pending.size() >= 3 && pending[2] == '<') {
                        pending.erase(0, 3);
                        escape_at.reset();
                        mouse_sequence = true;
                        mouse_at = std::chrono::steady_clock::now();
                        continue;
                    }
                    size_t sequence_end = 2;
                    bool interrupted = false, incomplete = false;
                    while (sequence_end < pending.size() &&
                           !(pending[sequence_end] >= '@' && pending[sequence_end] <= '~')) {
                        if (pending[sequence_end] == '\033') {
                            if (pending.size() < sequence_end + 3) {
                                interrupted = true;
                                incomplete = true;
                                break;
                            }
                            if (pending.compare(sequence_end, 3, "\033[<") == 0) {
                                interrupted_sequence = pending.substr(0, sequence_end);
                                pending.erase(0, sequence_end + 3);
                                escape_at.reset();
                                mouse_sequence = true;
                                mouse_at = std::chrono::steady_clock::now();
                            } else {
                                pending.erase(0, sequence_end);
                            }
                            interrupted = true;
                            break;
                        }
                        ++sequence_end;
                    }
                    if (interrupted) {
                        if (incomplete) {
                            break;
                        }
                        continue;
                    }
                    if (sequence_end == pending.size()) {
                        if (pending.size() > 32) {
                            pending.clear();
                            escape_at.reset();
                        }
                        break;
                    }
                    char final_byte = pending[sequence_end];
                    std::optional<Key> key;
                    if (final_byte == 'A') {
                        key = Key::Up;
                    }
                    if (final_byte == 'B') {
                        key = Key::Down;
                    }
                    if (final_byte == 'C') {
                        key = Key::Right;
                    }
                    if (final_byte == 'D') {
                        key = Key::Left;
                    }
                    if (final_byte == 'H') {
                        key = Key::Home;
                    }
                    if (final_byte == 'F') {
                        key = Key::End;
                    }
                    if (final_byte == 'Z') {
                        key = Key::BackTab;
                    }
                    // The terminal says when its window gains or loses focus.
                    if (sequence_end == 2 && (final_byte == 'I' || final_byte == 'O')) {
                        key = final_byte == 'I' ? Key::FocusIn : Key::FocusOut;
                    }
                    if (final_byte == '~') {
                        auto code = pending.substr(2, sequence_end - 2);
                        if (code == "1" || code == "7") {
                            key = Key::Home;
                        } else if (code == "4" || code == "8") {
                            key = Key::End;
                        } else if (code == "3") {
                            key = Key::Delete;
                        } else if (code == "5") {
                            key = Key::PageUp;
                        } else if (code == "6") {
                            key = Key::PageDown;
                        }
                    }
                    if (key) {
                        events.push_back({*key, {}});
                    }
                    pending.erase(0, sequence_end + 1);
                    escape_at.reset();
                    continue;
                }
                events.push_back({Key::Back, {}});
                pending.erase(0, 1);
                escape_at.reset();
                continue;
            }
            size_t byte_count = byte < 128 ? 1 : byte < 224 ? 2 : byte < 240 ? 3 : 4;
            if (pending.size() < byte_count) {
                break;
            }
            std::string text = pending.substr(0, byte_count);
            pending.erase(0, byte_count);
            if (byte == 3) {
                events.push_back({Key::Interrupt, {}});
            } else if (byte == 26) {
                events.push_back({Key::Suspend, {}});
            } else if (byte == '\r' || byte == '\n') {
                events.push_back({Key::Enter, {}});
            } else if (byte == 127 || byte == 8) {
                events.push_back({Key::Backspace, {}});
            } else if (byte == '\t') {
                events.push_back({Key::Tab, {}});
            } else if (!editing && (byte == 'w' || byte == 'W')) {
                events.push_back({Key::Up, {}});
            } else if (!editing && (byte == 's' || byte == 'S')) {
                events.push_back({Key::Down, {}});
            } else if (!editing && (byte == 'a' || byte == 'A')) {
                events.push_back({Key::Left, {}});
            } else if (!editing && (byte == 'd' || byte == 'D')) {
                events.push_back({Key::Right, {}});
            } else if (!editing && (byte == 'e' || byte == 'E')) {
                events.push_back({Key::Enter, {}});
            } else if (!editing && (byte == 'q' || byte == 'Q')) {
                events.push_back({Key::Back, {}});
            } else if (byte >= 32 && valid_utf8(text)) {
                events.push_back({Key::Text, std::move(text)});
            }
        }
        return events;
    }

    std::vector<Input> InputParser::expire() {
        if (mouse_at && timeout_ms() == 0) {
            mouse_sequence = mouse_overflow = false;
            mouse_at.reset();
            mouse_report.clear();
            interrupted_sequence.clear();
        }
        if (escape_at && timeout_ms() == 0) {
            bool bare_escape = pending.size() == 1;
            pending.clear();
            escape_at.reset();
            if (bare_escape) {
                return {{Key::Back, {}}};
            }
        }
        return {};
    }

    int InputParser::timeout_ms() const {
        if (mouse_at) {
            int remaining = std::max(
                0,
                500 - int(std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::steady_clock::now() - *mouse_at
                      )
                              .count())
            );
            if (escape_at) {
                remaining = std::min(
                    remaining,
                    std::max(
                        0,
                        30 - int(std::chrono::duration_cast<std::chrono::milliseconds>(
                                     std::chrono::steady_clock::now() - *escape_at
                             )
                                     .count())
                    )
                );
            }
            return remaining;
        }
        if (!escape_at || pending.size() > 1) {
            return -1;
        }
        return std::max(
            0,
            30 -
                int(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - *escape_at)
                        .count())
        );
    }

    std::optional<MousePosition> InputParser::take_mouse() {
        auto latest = mouse;
        mouse.reset();
        return latest;
    }
}
