# 第三方组件与许可证

FirthMail 自身以 **AGPL-3.0-only** 发布，完整条款见 [LICENSE](LICENSE)。

仓库里 `vendor/` 下是构建所需的第三方源码，**随仓库一起分发，各自保留原有许可证**，
未被本项目重新授权：

| 目录 | 来源 | 许可证 |
| --- | --- | --- |
| `vendor/flectar-mail/` | [flectar/mail](https://github.com/flectar/mail) 的邮件引擎（含 fork 的 `jmap-client`、`vello`、`blitz` 等 crate） | AGPL-3.0-only，见 `vendor/flectar-mail/LICENSE` |
| `vendor/flectar-mail-sync-client/` | flectar/mail-sync-client | Apache-2.0，见 `vendor/flectar-mail-sync-client/LICENSE.md` |
| `vendor/outlook-pst-ost/` | [microsoft/outlook-pst-rs](https://github.com/microsoft/outlook-pst-rs) 的社区修复版 | MIT，见 `vendor/outlook-pst-ost/LICENSE` |

本仓库对 `vendor/` 做的本地修改（见 README 的「vendor 补丁记录」）同样在各自原许可证下分发。

其余 Rust 依赖的许可证可用 `cargo metadata` 或 `cargo deny check licenses` 导出；
前端依赖见 `apps/desktop/pnpm-lock.yaml`。

## 为什么是 AGPL 而不是 GPLv3

邮件引擎 `flectar-mail-core` 是 AGPL-3.0-only。GPLv3 与 AGPLv3 只能单向兼容：
GPLv3 代码可以并入 AGPLv3 作品，反之不行。把引擎和外壳作为**一个程序**分发时，
整体必须按 AGPL-3.0 提供，因此本仓库统一采用 AGPL-3.0-only。
