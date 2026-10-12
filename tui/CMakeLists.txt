# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

cmake_minimum_required(VERSION 3.20)
project(bitfrost_tui LANGUAGES CXX)
option(BITFROST_STATIC "Link the TUI statically" OFF)
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../plugins/bitfrost/.claude-plugin/plugin.json" PLUGIN_JSON)
string(JSON BITFROST_VERSION GET "${PLUGIN_JSON}" version)
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/meta/metadata.json" METADATA_JSON)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/meta/metadata.json")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/metadata.hpp"
"// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// Generated from meta/metadata.json at configure time. Edit the JSON, not this file.

#pragma once
#include <string_view>

namespace bf {
    inline constexpr std::string_view about_metadata = R\"bfmeta(${METADATA_JSON})bfmeta\";
}
")
add_executable(bitfrost-tui
    src/main.cpp
    src/app/app.cpp
    src/app/view.cpp
    src/app/controls.cpp
    src/app/configuration.cpp
    src/app/status.cpp
    src/app/update.cpp
    src/pages/home.cpp
    src/pages/update.cpp
    src/pages/models.cpp
    src/pages/model_stats.cpp
    src/pages/settings.cpp
    src/pages/status.cpp
    src/pages/about.cpp
    src/ui/list.cpp
    src/ui/scrollbar.cpp
    src/ui/hit.cpp
    src/app/mouse.cpp
    src/ui/model_list.cpp
    src/ui/grouped_list.cpp
    src/ui/subagent_list.cpp
    src/ui/popup.cpp
    src/ui/editor.cpp
    src/ui/sidebar.cpp
    src/ui/format.cpp
    src/ui/usage_chart.cpp
    src/fx/border.cpp
    src/fx/mosaic.cpp
    src/fx/particles.cpp
    src/fx/glyphs.cpp
    src/fx/transition.cpp
    src/rpc/json.cpp
    src/rpc/broker.cpp
    src/term/caps.cpp
    src/term/output.cpp
    src/term/session.cpp
    src/term/gamepad.cpp
    src/term/input.cpp
    src/render/color.cpp
    src/render/text.cpp
    src/render/grid.cpp
    tests/selftest.cpp
    tests/status_selftest.cpp
    tests/protocol_selftest.cpp
    tests/settings_selftest.cpp
    tests/update_selftest.cpp
    tests/mouse_selftest.cpp
    tests/hit_selftest.cpp
    tests/about_selftest.cpp
    tests/scrollbar_selftest.cpp
    tests/scroll_selftest.cpp
    tests/gamepad_selftest.cpp
    tests/controls_selftest.cpp
    tests/configuration_selftest.cpp
)
target_compile_features(bitfrost-tui PRIVATE cxx_std_20)
target_compile_options(bitfrost-tui PRIVATE -Wall -Wextra -Wpedantic)
target_compile_definitions(bitfrost-tui PRIVATE BITFROST_VERSION="${BITFROST_VERSION}")
target_include_directories(bitfrost-tui PRIVATE src ${CMAKE_CURRENT_BINARY_DIR})
# Floating-point charconv is newer than our macOS minimum. Probe at the shipped
# deployment target, retaining the faster conversions on platforms that have them.
include(CheckCXXSourceCompiles)
include(CMakePushCheckState)
cmake_push_check_state(RESET)
set(CMAKE_REQUIRED_FLAGS "-std=c++20")
if(APPLE)
    string(APPEND CMAKE_REQUIRED_FLAGS " -mmacosx-version-min=12.3")
endif()
check_cxx_source_compiles("#include <charconv>
#include <limits>
int main() {
    char buffer[64] = \"1.25\";
    double value = 0;
    auto parsed = std::from_chars(buffer, buffer + 4, value);
    auto written = std::to_chars(buffer, buffer + sizeof(buffer), value,
        std::chars_format::general, std::numeric_limits<double>::max_digits10);
    return parsed.ec != std::errc() || written.ec != std::errc();
}" BITFROST_FLOAT_CHARCONV)
cmake_pop_check_state()
if(BITFROST_FLOAT_CHARCONV)
    target_compile_definitions(bitfrost-tui PRIVATE BITFROST_FLOAT_CHARCONV=1)
endif()
if(APPLE)
    target_compile_options(bitfrost-tui PRIVATE -mmacosx-version-min=12.3)
    target_link_options(bitfrost-tui PRIVATE -mmacosx-version-min=12.3)
    if(BITFROST_STATIC)
        find_library(STATIC_CXX NAMES libc++.a)
        find_library(STATIC_CXXABI NAMES libc++abi.a)
        if(STATIC_CXX AND STATIC_CXXABI)
            target_link_options(bitfrost-tui PRIVATE -nostdlib++)
            target_link_libraries(bitfrost-tui PRIVATE ${STATIC_CXX} ${STATIC_CXXABI})
        else()
            message(WARNING "Static libc++ unavailable; using system libc++")
        endif()
    endif()
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    if(BITFROST_STATIC)
        target_link_options(bitfrost-tui PRIVATE -static)
    endif()
else()
    message(FATAL_ERROR "BitFrost TUI supports Linux and macOS only")
endif()
enable_testing()
add_test(NAME selftest COMMAND bitfrost-tui --selftest)
# The style check needs a clang-format new enough for every key in .clang-format.
find_program(CLANG_FORMAT clang-format)
if(CLANG_FORMAT)
    execute_process(COMMAND ${CLANG_FORMAT} --version OUTPUT_VARIABLE CLANG_FORMAT_VERSION)
    string(REGEX MATCH "version ([0-9]+)" _ "${CLANG_FORMAT_VERSION}")
    if(CMAKE_MATCH_1 GREATER_EQUAL 23)
        file(GLOB_RECURSE TUI_STYLED_FILES CONFIGURE_DEPENDS
            ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/src/*.hpp
            ${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/tests/*.hpp)
        add_test(NAME format COMMAND ${CLANG_FORMAT} --dry-run --Werror ${TUI_STYLED_FILES})
    else()
        message(STATUS "clang-format 23 or newer not found; skipping the style check")
    endif()
endif()
find_package(Python3 COMPONENTS Interpreter QUIET)
find_program(NODE_EXECUTABLE node)
if(Python3_Interpreter_FOUND)
    add_test(NAME pty-io COMMAND ${Python3_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/pty_io_selftest.py)
    set_tests_properties(pty-io PROPERTIES TIMEOUT 10)
endif()
if(Python3_Interpreter_FOUND AND NODE_EXECUTABLE)
    add_test(NAME pty-smoke COMMAND ${Python3_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/pty_smoke.py $<TARGET_FILE:bitfrost-tui>)
    add_test(NAME pty-static COMMAND ${Python3_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/pty_smoke.py $<TARGET_FILE:bitfrost-tui> --no-anim)
    # Each suite exercises several complete PTY sessions, including updates
    # and configuration. Hosted macOS runs can exceed the old 90-second cap;
    # individual process/input checks keep their shorter internal deadlines.
    set_tests_properties(pty-smoke pty-static PROPERTIES TIMEOUT 180)
endif()
