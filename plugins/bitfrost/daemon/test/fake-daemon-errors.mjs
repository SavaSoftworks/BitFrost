// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

setTimeout(() => { throw new Error('fixture uncaught exception') }, 400)
setTimeout(() => { void Promise.reject(new Error('fixture unhandled rejection')) }, 500)
