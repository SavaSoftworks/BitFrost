// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "fx/glyphs.hpp"
#include "term/output.hpp"
#include <algorithm>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bf {
    namespace {
        void require(bool condition, const char *message) {
            if (!condition) {
                throw std::runtime_error(message);
            }
        }

        std::string all_text(const Grid &grid) {
            std::string text;
            for (const Cell &cell : grid.cells) {
                text += cell.glyph;
            }
            return text;
        }

        std::optional<std::pair<int, int>> locate(const Grid &grid, std::string_view needle, int start_column = 0) {
            for (int y = 0; y < grid.height; ++y) {
                for (int x = start_column; x + int(needle.size()) <= grid.width; ++x) {
                    bool match = true;
                    for (size_t offset = 0; offset < needle.size(); ++offset) {
                        if (grid.cells[size_t(y * grid.width + x + int(offset))].glyph != needle.substr(offset, 1)) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        return std::make_pair(x, y);
                    }
                }
            }
            return std::nullopt;
        }

        size_t occurrences(const std::string &text, std::string_view needle) {
            size_t count = 0;
            for (size_t at = text.find(needle); at != std::string::npos; at = text.find(needle, at + 1)) {
                ++count;
            }
            return count;
        }
    }

    void about_selftest() {
        std::vector<std::string> opened;
        App app(
            [](const Json &) {},
            false,
            true,
            false,
            {},
            [&](const std::string &url) {
                opened.push_back(url);
                return true;
            }
        );
        auto key = [&](Key input_key) {
            app.input({input_key, {}});
        };
        Grid grid(120, 40);
        key(Key::End);
        key(Key::Enter);
        app.render(grid);
        auto sidebar_about = locate(grid, "About");
        require(
            sidebar_about && sidebar_about->second == 11 && sidebar_about->first == 4,
            "About is the third Status sidebar item"
        );
        key(Key::Down);
        key(Key::Down);
        app.render(grid);
        std::string title_row;
        for (int x = 27; x < grid.width - 3; ++x) {
            title_row += grid.cells[size_t(3 * grid.width + x)].glyph;
        }
        require(title_row.find_first_not_of(' ') == std::string::npos, "About has no page title");
        std::string page = all_text(grid);
        for (std::string_view expected :
             {"Author",
              "Nick Germaine",
              "x.com/SavaSoftworks",
              "github.com/SavaSoftworks",
              "github.com/nickgermaine"}) {
            require(page.find(expected) != std::string::npos, "About page is missing expected text");
        }
        require(page.find("https://") == std::string::npos, "About page leaks full URLs into its link text");
        auto heading = locate(grid, "Author");
        auto name = locate(grid, "Nick Germaine");
        auto first = locate(grid, "x.com/SavaSoftworks");
        auto second = locate(grid, "github.com/SavaSoftworks");
        auto third = locate(grid, "github.com/nickgermaine");
        require(heading && name && first && second && third, "About block text is drawable");
        // The block is as wide as the wordmark and lines up under it.
        int wordmark = pixel_text_width("BITFROST", 1, PixelFont::Bold);
        int right = 27 + (89 - wordmark) / 2 + wordmark;
        require(
            name->second == first->second && first->first + 19 == right && name->first == heading->first,
            "The first link shares the name row and ends at the block right edge"
        );
        require(
            second->second == name->second + 1 && third->second == name->second + 2 && second->first + 24 == right &&
                third->first + 23 == right,
            "Further links each take their own right aligned row"
        );
        for (int offset = 0; offset < 19; ++offset) {
            const Cell &cell = grid.cells[size_t(first->second * grid.width + first->first + offset)];
            require(cell.fg == blue && cell.underline, "Link cells are blue and underlined");
        }
        const Cell &name_cell = grid.cells[size_t(name->second * grid.width + name->first)];
        const Cell &heading_cell = grid.cells[size_t(heading->second * grid.width + heading->first)];
        require(
            name_cell.fg == white && !name_cell.underline && heading_cell.fg == dim,
            "Names stay plain white and the heading is grey"
        );
        bool logo_drawn = false;
        for (int y = 10; y < 15 && !logo_drawn; ++y) {
            for (int x = 44; x < 99; ++x) {
                if (grid.cells[size_t(y * grid.width + x)].glyph == "▀") {
                    logo_drawn = true;
                    break;
                }
            }
        }
        require(logo_drawn, "The small logo sits five rows below the content top");

        key(Key::Enter);
        key(Key::Enter);
        require(
            opened.size() == 1 && opened.back() == "https://x.com/SavaSoftworks" &&
                app.status() == "Opened x.com/SavaSoftworks in your browser",
            "Enter opens the focused link with its full URL"
        );
        key(Key::Down);
        key(Key::Enter);
        require(opened.back() == "https://github.com/SavaSoftworks", "Down moves focus to the second link");
        app.render(grid);
        const Cell &selected = grid.cells[size_t(second->second * grid.width + second->first)];
        // The widest link is 24 cells, so the highlight runs from one cell before it to one after.
        auto lit = [&](int x) {
            return grid.cells[size_t(second->second * grid.width + x)].bg != black;
        };
        require(
            selected.fg == black && selected.underline && lit(right - 25) && lit(right) && !lit(right - 26) &&
                !lit(right + 1),
            "The focused link's highlight is the widest link plus a cell on each side"
        );
        key(Key::Up);
        key(Key::Up);
        key(Key::Enter);
        require(opened.back() == "https://github.com/nickgermaine", "Up wraps focus to the last link");
        key(Key::Home);
        key(Key::End);
        key(Key::Enter);
        require(opened.back() == "https://github.com/nickgermaine", "Home and End reach the first and last links");
        app.render(grid);
        require(
            all_text(grid).find("[Tab] - Controls") != std::string::npos,
            "About content shows the persistent Controls hint"
        );
        auto version = locate(grid, "v" BITFROST_VERSION);
        require(
            version && version->second == grid.height - 3 &&
                version->first + int(std::string_view("v" BITFROST_VERSION).size()) == grid.width - 3 &&
                grid.cells[size_t(version->second * grid.width + version->first)].fg == dim,
            "Subpages show the grey version right aligned on the hints row"
        );

        require(app.mouse(MousePosition{right - 3, second->second}), "Hovering a link reports a repaint");
        app.render(grid);
        require(
            grid.cells[size_t(second->second * grid.width + right - 3)].fg == Color{210, 225, 240},
            "Hovering brightens the hovered link"
        );
        app.mouse(std::nullopt);
        app.render(grid);
        size_t opened_before = opened.size();
        require(
            app.mouse_input({{right - 3, second->second}, MouseKind::Click, 0}),
            "Clicking a link reports a repaint"
        );
        require(
            opened.size() == opened_before + 1 && opened.back() == "https://github.com/SavaSoftworks",
            "A mouse click on the second link opens its full URL"
        );

        for (auto [width, height, main_x, main_width, wide] :
             {std::tuple{120, 40, 27, 89, true}, {80, 24, 19, 57, true}, {40, 18, 19, 17, false}}) {
            Grid sized(width, height);
            app.render(sized);
            std::string text = all_text(sized);
            require(text.find("https://") == std::string::npos, "Narrow About pages never leak full URLs");
            std::vector<std::string_view> pieces{"Author"};
            if (wide) {
                pieces.push_back("Nick Germaine");
                pieces.push_back("x.com/SavaSoftworks");
            } else {
                // A thirteen cell block leaves the name no room beside its link.
                pieces.push_back("x.com/SavaSo");
            }
            for (std::string_view piece : pieces) {
                auto found = locate(sized, piece);
                require(
                    found && found->first >= main_x && found->first + int(piece.size()) <= main_x + main_width,
                    "About text stays inside the main area"
                );
            }
            if (!wide) {
                auto plain = locate(sized, "BitFrost", main_x);
                require(
                    plain && plain->first >= main_x && plain->first + 8 <= main_x + main_width &&
                        sized.cells[size_t(plain->second * width + plain->first)].fg == blue,
                    "Narrow terminals show plain blue BitFrost text instead of the logo"
                );
            }
        }

        Grid short_about(120, 16);
        key(Key::Home);
        app.render(short_about);
        auto about_bar = [&] {
            std::string result;
            for (int y = 5; y < 11; ++y) {
                const Cell &cell = short_about.cells[size_t(y * 120 + 116)];
                require(
                    cell.bg == black && (cell.fg == blue || cell.fg == dim),
                    "About text and highlights leave the scrollbar column clear"
                );
                result += cell.glyph;
            }
            return result;
        };
        std::string about_top = about_bar();
        require(about_top.starts_with("▌"), "Overflowing About content shows a scrollbar at the top");
        key(Key::End);
        app.render(short_about);
        require(
            about_bar() != about_top && about_bar().ends_with("▌") && locate(short_about, "github.com/nickgermaine"),
            "About End scrolls the last link into view and places the thumb at the bottom"
        );
        key(Key::Enter);
        std::string selected_link = opened.back();
        size_t before_wheel = opened.size();
        require(app.mouse_input({{30, 6}, MouseKind::Wheel, -1}), "About overflow accepts wheel scrolling");
        require(opened.size() == before_wheel, "About wheel navigation does not open a link");
        app.render(short_about);
        require(about_bar() != about_top, "About scrollbar follows the independent view");
        key(Key::Enter);
        require(
            opened.back() == selected_link && opened.size() == before_wheel + 1,
            "About wheel leaves the selected off-screen link intact for Enter"
        );
        for (Key direction : {Key::Up, Key::Down}) {
            key(Key::End);
            app.render(short_about);
            key(Key::ScrollUp);
            key(Key::ScrollUp);
            app.render(short_about);
            std::string scrolled_bar = about_bar();
            key(direction);
            app.render(short_about);
            auto visible_link = locate(short_about, "x.com/SavaSoftworks");
            require(
                visible_link &&
                    short_about.cells[size_t(visible_link->second * 120 + visible_link->first)].fg == black &&
                    about_bar() == scrolled_bar,
                "Either About arrow selects the first visible link without moving the view"
            );
            key(Key::Enter);
            require(opened.back() == "https://x.com/SavaSoftworks", "The adopted visible link activates normally");
            key(Key::Down);
            key(Key::Enter);
            require(opened.back() == "https://github.com/SavaSoftworks", "Further About arrows continue normally");
        }
        key(Key::Home);
        app.render(short_about);
        require(about_bar() == about_top, "About Home returns the scrollbar to the top");

        for (bool fades : {false, true}) {
            App timed([](const Json &) {}, fades);
            timed.error("Saved");
            timed.step(0);
            require(
                timed.needs_tick() && timed.tick_timeout_ms() == 5000,
                "A status message wakes the loop at five seconds"
            );
            timed.step(4.9);
            require(timed.status() == "Saved", "A status message shows for five seconds");
            timed.step(0.2);
            require(
                fades ? timed.status() == "Saved" && timed.tick_timeout_ms() == 33 : timed.status().empty(),
                "Then it fades out frame by frame, or goes at once without animations"
            );
            timed.step(0.4);
            require(
                timed.status().empty() && !timed.needs_tick(),
                "A faded message is cleared and stops waking the loop"
            );
        }

        App home([](const Json &) {}, false);
        Grid home_grid(120, 40);
        home.render(home_grid);
        require(!locate(home_grid, "v" BITFROST_VERSION), "The home menu leaves the version out of the status bar");

        App animated([](const Json &) {}, true);
        animated.input({Key::End, {}});
        animated.input({Key::Enter, {}});
        animated.step(0.5);
        animated.input({Key::Down, {}});
        animated.input({Key::Down, {}});
        animated.step(0.5);
        animated.render(grid);
        require(
            animated.page() == Page::Status && animated.particles_active(),
            "Animated About sheds particles from its wordmark"
        );
        animated.mouse(MousePosition{60, 12});
        require(animated.mouse_gravity().has_value(), "The mouse pulls About particles");
        animated.input({Key::Up, {}});
        animated.render(grid);
        require(!animated.particles_active(), "Leaving About for another section drops the particles");
        animated.stop();

        Diff underlined;
        Grid styled(20, 2);
        styled.text(2, 1, "ab", blue, black, -1, true);
        std::string underline_frame = underlined.frame(styled);
        size_t underline_on = occurrences(underline_frame, "\033[4m");
        size_t underline_off = occurrences(underline_frame, "\033[24m");
        require(
            underline_on == 1 && underline_off == 1 &&
                underline_frame.find("\033[4m") < underline_frame.find("\033[24m") &&
                underline_frame.find("\033[4ma") != std::string::npos &&
                underline_frame.find("b", underline_frame.find("\033[4m")) < underline_frame.find("\033[24m"),
            "Consecutive underlined cells emit one SGR 4 followed by one SGR 24"
        );
        styled.text(3, 1, " ", blue, black, -1, false);
        require(occurrences(underlined.frame(styled), "\033[4m") == 0, "A cell dropping underline never re-enables it");
        Diff spaced;
        Grid mixed(10, 2);
        mixed.text(2, 1, "a", blue, black, -1, true);
        mixed.text(4, 1, "c", blue, black, -1, true);
        std::string mixed_frame = spaced.frame(mixed);
        require(
            occurrences(mixed_frame, "\033[4m") == 2 && occurrences(mixed_frame, "\033[24m") == 2,
            "Underlined cells around a plain gap toggle SGR 4 and 24"
        );
    }
}
