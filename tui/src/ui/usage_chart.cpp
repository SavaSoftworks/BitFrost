// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "usage_chart.hpp"
#include "fx/mosaic.hpp"
#include "ui/format.hpp"
#include <algorithm>
#include <cmath>

namespace bf {
    UsageChart usage_chart(const Json &daily, int days, int width, int height) {
        UsageChart chart;
        const auto &entries = daily.array();
        int count = days > 0 ? std::min(days, int(entries.size())) : int(entries.size());
        if (!count || width <= 0 || height <= 0) {
            return chart;
        }
        size_t first = entries.size() - size_t(count);
        chart.least = entries[first]["tokens"].number();
        for (size_t index = first; index < entries.size(); ++index) {
            double tokens = entries[index]["tokens"].number();
            chart.most = std::max(chart.most, tokens);
            chart.least = std::min(chart.least, tokens);
            chart.average += tokens;
        }
        chart.average /= count;
        chart.tokens.resize(size_t(width));
        for (int column = 0; column < width; ++column) {
            int begin = column * count / width;
            int end = std::max(begin + 1, (column + 1) * count / width);
            for (int day = begin; day < end; ++day) {
                chart.tokens[size_t(column)] += entries[first + size_t(day)]["tokens"].number();
            }
        }
        auto [minimum, maximum] = std::minmax_element(chart.tokens.begin(), chart.tokens.end());
        int levels = height * 8;
        for (double tokens : chart.tokens) {
            int level = *maximum > *minimum
                            ? 1 + int(std::round((tokens - *minimum) * (levels - 1) / (*maximum - *minimum)))
                            : levels;
            chart.levels.push_back(tokens > 0 ? std::clamp(level, 1, levels) : 0);
        }
        return chart;
    }

    void draw_usage_chart(Grid &grid, int x, int y, int width, int height, const Json &daily, int days) {
        UsageChart chart = usage_chart(daily, days, width, height);
        constexpr std::string_view blocks[]{" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"};
        for (size_t column = 0; column < chart.levels.size(); ++column) {
            for (int row = 0; row < height; ++row) {
                int level = std::clamp(chart.levels[column] - (height - row - 1) * 8, 0, 8);
                grid.put(
                    x + int(column),
                    y + row,
                    std::string(blocks[level]),
                    mosaic_palette[column % mosaic_palette.size()]
                );
            }
        }
        std::string legend =
            "most " + compact(chart.most) + "   avg " + compact(chart.average) + "   least " + compact(chart.least);
        if (text_width(legend) > width) {
            legend =
                "most " + compact(chart.most) + " avg " + compact(chart.average) + " least " + compact(chart.least);
        }
        grid.text(x, y + height, ellipsis(legend, width), dim);
    }
}
