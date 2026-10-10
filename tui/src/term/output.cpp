// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "output.hpp"
#include <cerrno>
#include <cstdlib>
#include <unistd.h>

namespace bf {
    namespace {
        std::string axis_move(int distance, char positive, char negative) {
            if (distance == 0) {
                return {};
            }
            int count = std::abs(distance);
            return "\033[" + (count == 1 ? std::string{} : std::to_string(count)) +
                   (distance > 0 ? positive : negative);
        }

        void append_cursor_move(std::string &output, int from_x, int from_y, int x, int y, int width) {
            std::string absolute = "\033[" + std::to_string(y + 1) + ';' + std::to_string(x + 1) + 'H';
            if (from_x >= 0 && from_x < width && from_y >= 0) {
                std::string relative = axis_move(y - from_y, 'B', 'A') + axis_move(x - from_x, 'C', 'D');
                if (relative.size() < absolute.size()) {
                    output += relative;
                    return;
                }
            }
            output += absolute;
        }

        void append_color(std::string &output, Color color, bool background, bool truecolor) {
            output += background ? "48;" : "38;";
            if (truecolor) {
                output +=
                    "2;" + std::to_string(color.r) + ';' + std::to_string(color.g) + ';' + std::to_string(color.b);
            } else {
                output += "5;" + std::to_string(quantize(color));
            }
        }
    }

    std::string Diff::frame(const Grid &grid) {
        if (previous.width != grid.width || previous.height != grid.height) {
            invalid = true;
        }
        std::string output;
        output.reserve(8192);
        Color foreground{};
        Color background{};
        bool have_foreground = false;
        bool have_background = false;
        bool underline = false;
        int cursor_x = -1;
        int cursor_y = -1;
        for (int y = 0; y < grid.height; ++y) {
            for (int x = 0; x < grid.width; ++x) {
                size_t index = size_t(y * grid.width + x);
                const Cell &cell = grid.cells[index];
                if (cell.continuation || (!invalid && cell == previous.cells[index])) {
                    continue;
                }
                if (output.empty()) {
                    output = "\033[?2026h";
                }
                if (cursor_x != x || cursor_y != y) {
                    append_cursor_move(output, cursor_x, cursor_y, x, y, grid.width);
                }
                bool solid_pixel = (cell.glyph == "▀" || cell.glyph == "▄") && cell.fg == cell.bg;
                bool needs_foreground = cell.glyph != " " && !solid_pixel;
                bool foreground_changed = needs_foreground && (!have_foreground || foreground != cell.fg);
                bool background_changed = !have_background || background != cell.bg;
                if (foreground_changed || background_changed) {
                    output += "\033[";
                    if (foreground_changed) {
                        append_color(output, cell.fg, false, truecolor);
                        foreground = cell.fg;
                        have_foreground = true;
                    }
                    if (background_changed) {
                        if (foreground_changed) {
                            output += ';';
                        }
                        append_color(output, cell.bg, true, truecolor);
                        background = cell.bg;
                        have_background = true;
                    }
                    output += 'm';
                }
                if (cell.underline != underline) {
                    output += cell.underline ? "\033[4m" : "\033[24m";
                    underline = cell.underline;
                }
                output += solid_pixel ? " " : cell.glyph;
                cursor_x = x + (x + 1 < grid.width && grid.cells[index + 1].continuation ? 2 : 1);
                cursor_y = y;
            }
        }
        if (!output.empty()) {
            output += "\033[0m\033[?2026l";
        }
        previous = grid;
        invalid = false;
        return output;
    }

    bool write_all(int descriptor, std::string_view bytes) {
        while (!bytes.empty()) {
            auto bytes_written = ::write(descriptor, bytes.data(), bytes.size());
            if (bytes_written < 0 && errno == EINTR) {
                continue;
            }
            if (bytes_written <= 0) {
                return false;
            }
            bytes.remove_prefix(size_t(bytes_written));
        }
        return true;
    }
}
