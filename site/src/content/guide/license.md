---
title: "License"
summary: "The project license and where the third-party notices live."
order: 19
---
resmon is released under the **MIT License**. Copyright (c) 2026 Ryan Kamp. The full text is in [LICENSE](LICENSE) at the root of the repository, and in **Settings › About resmon**, under "The license in full".

In short, the MIT License permits use, copying, modification, merging, publication, distribution, sublicensing, and sale of the software, on the condition that the copyright notice and permission notice go with all copies or substantial portions of it. The software is provided "as is", without warranty of any kind. That covers the software. It does not extend to the third-party services you point it at, whose terms bind you. See [Sources and their terms](/resmon/guide/sources/).

## Third-party notices

resmon's installers redistribute one component whose published package carries no license file of its own: **sqlite-vec 0.1.9**, the loadable SQLite extension behind search by meaning. Its MIT and Apache-2.0 texts are reproduced verbatim in **[docs/third-party-notices.md](docs/third-party-notices.md)**, because a wheel that ships a native binary and no notice would otherwise be redistributed without one. Every other dependency ships its own license inside its own distribution, and the installer copies it along with the package.
