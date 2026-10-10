// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app/app.hpp"
#include "fx/glyphs.hpp"
#include "ui/list.hpp"
#include <algorithm>
#include <string_view>
#include <vector>

namespace bf {
    namespace {
        struct AboutLink {
            std::string display, url;
        };
        struct AboutAuthor {
            std::string name;
            std::vector<AboutLink> links;
        };

        std::string link_display(std::string_view url) {
            std::string display(url);
            if (display.starts_with("https://")) {
                display.erase(0, 8);
            } else if (display.starts_with("http://")) {
                display.erase(0, 7);
            }
            if (display.ends_with('/')) {
                display.pop_back();
            }
            return display;
        }

        std::vector<AboutAuthor> about_authors(const Json &meta) {
            std::vector<AboutAuthor> authors;
            for (const Json &author : meta["authors"].array()) {
                std::string name = author["name"].str();
                if (name.empty()) {
                    continue;
                }
                AboutAuthor entry{name, {}};
                for (const Json &link : author["links"].array()) {
                    std::string url = link.str();
                    if (!url.starts_with("https://") && !url.starts_with("http://")) {
                        continue;
                    }
                    std::string display = link_display(url);
                    if (display.empty()) {
                        continue;
                    }
                    entry.links.push_back({std::move(display), std::move(url)});
                }
                authors.push_back(std::move(entry));
            }
            return authors;
        }

        int about_link_count(const std::vector<AboutAuthor> &authors) {
            int count = 0;
            for (const AboutAuthor &author : authors) {
                count += int(author.links.size());
            }
            return count;
        }
    }

    void App::draw_about(Grid &frame, int x, int width, int rows) {
        list_visible = std::max(1, rows);
        const std::vector<AboutAuthor> authors = about_authors(about);
        int logo_width = pixel_text_width("BITFROST", 1, PixelFont::Bold);
        bool logo = width >= logo_width;
        int logo_cells = logo ? (pixel_text_height(1, PixelFont::Bold) + 1) / 2 : 1;
        int link_rows = 0;
        for (const AboutAuthor &author : authors) {
            link_rows += std::max(1, int(author.links.size()));
        }
        // Up to five rows above the wordmark and five below it; short terminals shrink both before scrolling.
        int fixed = authors.empty() ? 0 : 1 + link_rows + int(authors.size()) - 1;
        int spare = rows - logo_cells - fixed;
        int block_gap = authors.empty() ? 0 : std::clamp(spare - 1, 1, 5);
        int content_rows = authors.empty() ? 0 : block_gap + fixed;
        int gap = std::clamp(spare - block_gap, 1, 5);
        int total = gap + logo_cells + content_rows;
        about_total = total;
        about_link_rows.clear();
        int link_row = gap + logo_cells + block_gap + 1;
        for (const AboutAuthor &author : authors) {
            for (int link = 0; link < int(author.links.size()); ++link) {
                about_link_rows.push_back(link_row + link);
            }
            link_row += std::max(1, int(author.links.size())) + 1;
        }
        bool overflow = total > rows;
        if (overflow) {
            int selected_row =
                about_selection < int(about_link_rows.size()) ? about_link_rows[size_t(about_selection)] : 0;
            about_first = std::clamp(about_first, 0, total - rows);
            if (about_following) {
                if (about_selection == 0) {
                    about_first = 0;
                } else if (selected_row < about_first) {
                    about_first = selected_row;
                } else if (selected_row >= about_first + rows) {
                    about_first = std::min(total - rows, selected_row - rows + 1);
                }
            }
        } else {
            about_first = 0;
        }
        if (overflow) {
            int height = std::clamp(std::max(frame.height, total + 10), 1, 500);
            if (!about_canvas || about_canvas->width != frame.width || about_canvas->height != height) {
                about_canvas.emplace(frame.width, height);
            } else {
                about_canvas->clear();
            }
        }
        Grid &grid = overflow ? *about_canvas : frame;
        hits.scroll({x, 5, width, rows}, HitKind::Link);
        int top = 5 + gap;
        int logo_x = x + (width - logo_width) / 2;
        if (logo) {
            pixel_text(grid, logo_x, top * 2, "BITFROST", 1, clock, 1, PixelFont::Bold);
            // The wordmark sheds particles like the home logo, kept to this page's content area.
            if (animations && !overflow) {
                ClipRegion area{x, 10, x + width, (5 + rows) * 2};
                emitters.push_back({logo_x, top * 2, pixel_text_height(1, PixelFont::Bold), 1, area, true});
                logo_boundary = area;
            }
        } else {
            grid.text(x + (width - 8) / 2, top, "BitFrost", blue);
        }
        if (authors.empty()) {
            return;
        }
        int widest = 0, longest_name = 0;
        for (const AboutAuthor &author : authors) {
            longest_name = std::max(longest_name, text_width(author.name));
            for (const AboutLink &entry : author.links) {
                widest = std::max(widest, text_width(entry.display));
            }
        }
        // As narrow as the wordmark when names and links fit beside each other with room to spare.
        bool fits = logo && longest_name + 4 + widest + 1 <= logo_width;
        int block_width = std::clamp(fits ? logo_width : std::min(100, width - 4), 1, width);
        int block_x = fits ? logo_x : x + (width - block_width) / 2;
        int block_top = top + logo_cells + block_gap;
        grid.text(block_x, block_top, authors.size() > 1 ? "Authors" : "Author", dim, black, block_width);
        bool focused = focus.back() == Focus::List;
        // Like the home menu, the highlight is as wide as the widest link plus a cell on each side.
        widest = std::min(widest, block_width);
        int y = block_top + 1;
        int index = 0;
        for (size_t author_index = 0; author_index < authors.size(); ++author_index) {
            if (author_index > 0) {
                ++y;
            }
            if (!overflow && y >= 5 + rows) {
                break;
            }
            const AboutAuthor &author = authors[author_index];
            list_text(grid, block_x, y, author.name, white, std::max(0, block_width - widest - 2));
            int rows_here = std::max(1, int(author.links.size()));
            for (int link = 0; link < int(author.links.size()); ++link) {
                int link_y = y + link;
                if (overflow || link_y < 5 + rows) {
                    bool selected = focused && index == about_selection;
                    int box_x = block_x + block_width - widest - 1;
                    if (selected) {
                        highlight(grid, box_x, link_y, widest + 2, "", clock);
                    }
                    const AboutLink &entry = author.links[size_t(link)];
                    int link_width = std::min(text_width(entry.display), block_width);
                    int link_x = block_x + block_width - link_width;
                    list_text(grid, link_x, link_y, entry.display, selected ? black : blue, link_width, true);
                    if (link_y - about_first >= 5 && link_y - about_first < 5 + rows) {
                        hits.add({box_x, link_y - about_first, widest + 2, 1}, HitKind::Link, index);
                    }
                }
                ++index;
            }
            y += rows_here;
        }
        if (overflow) {
            for (int row = 5; row < 5 + rows; ++row) {
                for (int column = x; column < x + width; ++column) {
                    if (frame.writable(column, row)) {
                        frame.cells[size_t(row * frame.width + column)] =
                            grid.cells[size_t((row + about_first) * grid.width + column)];
                    }
                }
            }
            draw_scrollbar(frame, "about", x, 5, width, rows, total, about_first, rows);
        }
    }

    void App::about_input(const Input &event) {
        const std::vector<AboutAuthor> authors = about_authors(about);
        int count = about_link_count(authors);
        int selected_row =
            about_selection < int(about_link_rows.size()) ? about_link_rows[size_t(about_selection)] : -1;
        if (!about_following &&
            select_first_visible(selected_row, event.key, about_first, list_visible, about_link_rows)) {
            about_selection =
                int(std::lower_bound(about_link_rows.begin(), about_link_rows.end(), selected_row) -
                    about_link_rows.begin());
            return;
        }
        navigate(about_selection, event.key, size_t(count), list_visible);
        if (list_navigation(event.key)) {
            about_following = true;
        }
        if (event.key == Key::Enter && about_selection < count) {
            open_about_link(about_selection);
        }
    }

    void App::open_about_link(int index) {
        if (index < 0) {
            return;
        }
        const std::vector<AboutAuthor> authors = about_authors(about);
        const AboutLink *selected = nullptr;
        int position = 0;
        for (const AboutAuthor &author : authors) {
            for (const AboutLink &link : author.links) {
                if (position == index) {
                    selected = &link;
                }
                ++position;
            }
        }
        if (!selected) {
            return;
        }
        message = opener && opener(selected->url) ? "Opened " + selected->display + " in your browser"
                                                  : "Couldn't open a browser; the link is " + selected->url;
    }
}
