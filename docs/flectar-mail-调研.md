# Flectar Mail 调研（2026-11-23）

> 结论：**能满足"Rust + 标准协议 + 加密 + 纯邮件"的一半需求，但三个定制点全不满足**：
> ① 外观是自有设计语言（Slint），不是仿 Outlook；② 完全不能读 Outlook 的设置；
> ③ 完全不能读 OST/PST 已下载邮件（issue 搜索 "pst/ost" 结果为 0）。

## 项目概况

- 仓库：<https://github.com/flectar/mail>（组织 flectar，主语言 Rust）
- 开源时间：2026-09-03；约 2000 stars / 146 forks；AGPL-3.0 许可证
- 版本：v0.1.0-alpha.7（2026-10-08），仍在 alpha；Windows 构建未签名
- 官网/介绍：<https://flectar.com/mail/>、
  <https://flectar.com/blog/introducing-flectar-mail-email-made-fast-again/>
- 技术栈：Slint 界面、无 WebView（HTML 邮件用 Blitz 渲染，官方自述"最具实验性"）、
  idle 内存约 20 MB

## 逐项对照需求

| 需求 | 结果 | 依据 |
|---|---|---|
| Rust 编写 | ✅ | 仓库主语言 Rust |
| IMAP/SMTP + TLS | ✅（另有 JMAP；POP3 为 2026-10 底新加） | PR [#440](https://github.com/flectar/mail/pull/440)、[#414](https://github.com/flectar/mail/pull/414) |
| 加密 | ✅ rustls + GnuPG（OpenPGP）；❌ S/MIME 未做 | issue [#263](https://github.com/flectar/mail/issues/263) |
| 外观仿 Outlook | ❌ 三栏结构相似，但视觉是自有设计 | alpha.7 发布说明、官网截图 |
| 复用 Outlook 设置 | ❌ 只有 Thunderbird/K-9 账户导入（PR [#97](https://github.com/flectar/mail/pull/97)）；Thunderbird 式 autoconfig 自动发现仍是未实现的请求（issue [#478](https://github.com/flectar/mail/issues/478)，2026-11-23 提出） | GitHub |
| 直接导入 OST/PST | ❌ issue 搜索 "pst OR ost" = 0 条；连 Outlook 的 winmail.dat/.msg 附件都还是 TODO | issue [#257](https://github.com/flectar/mail/issues/257) |
| 只做邮件不做日程 | ⚠️ 自带日历/联系人/文件模块，不用可以无视 | 仓库 topics |

正面发现：**导入能力**（PR [#140](https://github.com/flectar/mail/pull/140)，已合并）支持
mbox / .eml / maildir / Apple Mail / Thunderbird Local Folders，还能把导入的本地邮件
**回传上传到 IMAP 账户**。因此存在一条 OST 复用折中路径：
`OST →（libpff 或纯 Rust 解析器转换）→ mbox/EML → Flectar 导入`。
这正是 FirthMail 第一个组件 `tools/ost2eml` 的定位——无论最终客户端是自建还是复用别的底子，
这个转换器都用得上（Flectar 缺的就是它）。

## 对目标环境的判断

- 目标环境是经典桌面版 Outlook（Office 16.0）+ IMAP 账户，
  本地 OST 十几 GB，未加锁可直接读
- 常见校园/企业邮箱参数：IMAP 993 SSL、SMTP 465 SSL（或 587 STARTTLS）；
  用户名通常为邮箱 @ 之前的部分；务必开启 SSL/TLS
- IMAP 账户的邮件都在服务器上，任何新客户端重新同步即可恢复目录；
  OST 中只存在于本地、服务器已删除的内容才需要 ost2eml 转换导入

## 四条候选路线

| 路线 | 说明 | 评估 |
|---|---|---|
| A. 直接试用 alpha.7 | 装上配 IMAP | 成本最低，先验证；已采纳 |
| B. 复用 flectar-mail-core + 自建 Tauri UI（键盘优先） | 协议/同步/存储/导入器现成 | 省大量工作；整个应用受 AGPL 约束（个人自用无碍） |
| C. 完全自建（Tauri + 自研协议栈） | 无 AGPL 依赖 | 最干净可控，工作量最大 |
| D. fork Flectar 整体改造 | 加 OST 导入 + 换皮 | Slint 换皮工作量大，放弃已选的 Tauri 路线，不推荐 |

无论最终选哪条，`ost2eml`（OST/PST → EML/mbox）都是必需组件，先行开工。
解析核心选用微软官方 Rust PST 解析器（MIT）的社区修复版
[`outlook-pst-ost`](https://crates.io/crates/outlook-pst-ost)——支持 Outlook 2013+ 的
4 KiB OST 布局（本机 wVer=36 即此布局），纯 Rust、无 AGPL 顾虑，且天然是 FirthMail
"Outlook 导入"功能的库形态。
