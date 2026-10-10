// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

#include "app.hpp"
#include <algorithm>

namespace bf {
    void App::presented() {
        if (current == Page::Home && transition != Transition::Enter && !helper_missing && !update.checked) {
            update.checked = true;
            request("update.check");
        }
    }

    void App::start_update() {
        if (update.busy || update.version.empty()) {
            return;
        }
        update.busy = true;
        update.failed = update.finished = update.restart = false;
        update.steps.clear();
        message.clear();
        update.age = 0;
        request("update.run", Json::object({{"version", update.version}}));
    }

    bool App::receive_update(const Json &reply) {
        auto method = reply["method"].str();
        if (method != "update.step" && method != "update.finished") {
            return false;
        }
        if (!update.busy || update.finished || update.restart) {
            return true;
        }
        const Json &params = reply["params"];
        if (method == "update.finished") {
            if (params["ok"].boolean()) {
                update.finished = true;
                update.age = 0;
                update.version = params["version"].str(update.version);
                message = "Updated to " + update.version + ". Restarting...";
            } else {
                update.busy = false;
                update.failed = true;
                update.steps.push_back({"Update failed", params["error"].str(), "fail"});
                message = "Update failed: " + params["error"].str("see the steps above");
            }
        } else {
            int64_t index = params["index"].integer(-1);
            if (index < 0 || index >= 64) {
                return true;
            }
            update.steps.resize(std::max(update.steps.size(), size_t(index + 1)));
            update
                .steps[size_t(index)] = {params["label"].str(), params["detail"].str(), params["state"].str("running")};
        }
        return true;
    }

    void App::restart_failed() {
        message = "Restart bitfrost to use " + update.version;
        update.finished = false;
        update.restart = true;
        update.failed = true;
    }
}
