---
title: "License"
summary: "The project license and where the third-party notices live."
order: 14
readmeLines:
  - "1511-1520"
---
## License

resmon is released under the **MIT License**. Copyright (c) 2026 Ryan Kamp. The full license text is available in [LICENSE](LICENSE) at the project root.

In short, the MIT License permits use, copying, modification, merging, publication, distribution, sublicensing, and sale of the software, subject to the condition that the copyright notice and permission notice be included in all copies or substantial portions of the software. The software is provided "as is," without warranty of any kind.

### Third-party notices

resmon's installers redistribute one component whose published package carries no licence file of its own — **sqlite-vec 0.1.9**, the loadable SQLite extension behind semantic search. Its MIT and Apache-2.0 texts are reproduced verbatim in **[docs/third-party-notices.md](docs/third-party-notices.md)**, because a wheel that ships a native binary and no notice would otherwise be redistributed without one. Every other dependency ships its own licence inside its own distribution and the installer copies it along with the package.
