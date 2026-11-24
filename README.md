# FirthMail

一个用 Rust 写的桌面邮件客户端：**快、键盘优先、只做邮件**。界面和操作按自己的习惯打磨，
不是哪家客户端的复刻。

## 特点

- **三栏布局**：左侧文件夹树 / 中间邮件列表 / 右侧阅读窗格，顶部一条操作栏
- **多账户**：每个账户一组文件夹（收件箱排第一，账户标题可折叠）；
  两个以上账户时顶部多一个「所有收件箱」，合并列出各账户的收件箱
- **就地回复**：回复 / 全部回复 / 转发默认在阅读窗格里展开，邮件列表不动；
  也可以「弹出」成独立窗口
- **键盘优先**：邮件列表按 `Delete` 直接移入废纸篓（引擎 `ActionKind::Trash`），
  `↑↓/Home/End` 导航、`Ctrl+Q` 标为已读 / `Ctrl+U` 标为未读、
  `Ctrl+R` 回复 / `Ctrl+Shift+R` 全部回复 / `Ctrl+F` 转发
- **自动已读**：阅读窗格里显示满 3 秒自动标为已读（快速翻过不算）——
  时长是 `apps/desktop/src/App.tsx` 的 `AUTO_READ_DELAY_MS`
- **只做邮件**：IMAP / POP3 / SMTP + TLS；不做日历、日程
- **数据在本机**：SQLite 存邮件与全文索引，凭据进 Windows 凭据管理器
- **迁移**：Outlook 导出的邮件经 `tools/ost2eml` 转 EML/mbox 后导入；添加账户按邮箱域名自动填服务器

## 架构（路线 B）

```
┌─ apps/desktop (Tauri 2 + React 19 + Vite 8) ─ 三栏 UI + 键盘映射
│   src-tauri/src/bridge.rs —— Tauri 命令面 ⇄ 引擎 API 透传（模型自带 camelCase serde）
├─ vendor/flectar-mail/crates/flectar-mail-core —— 邮件引擎（AGPL-3.0-only）
│   账户/IMAP+SMTP+JMAP/SQLite/搜索/导入器/动作队列（perform_action）
│   事件总线 core-event → 前端刷新；凭据进 Windows 凭据管理器
├─ vendor/flectar-mail-sync-client —— 引擎的 git 依赖，已本地 patch（github git 不稳）
├─ vendor/outlook-pst-ost —— PST/OST 解析器（修了 2 个上游 bug）
└─ tools/ost2eml —— OST → EML/mbox 导出器
```

数据目录：`%APPDATA%\FirthMail`（数据库/原始邮件/队列）、`%LOCALAPPDATA%\FirthMail`（缓存）。
从旧名 fmail 升级时，首次启动会把 `%APPDATA%\fmail`、`%LOCALAPPDATA%\fmail`
整体改名过来：`keyring.json` 一起搬走（已保存的密码继续可用），数据库里记录的
绝对路径（保留的 `.eml` 原件、已缓存附件）也同步改写。改名失败（旧版还在跑、
文件被占用）则继续用旧目录，下次启动再试。

## tools/ost2eml

把 Outlook 数据文件里的邮件导出成 EML 树或 mbox，供其他客户端导入
（Flectar Mail 的导入功能两者都支持）。

```
# 先看看文件里有什么（只列文件夹和计数，不导出）
ost2eml "C:\Users\<user>\AppData\Local\Microsoft\Outlook\<账户>.ost" out-dir --list

# 先试导 20 封验证效果
ost2eml <ost> out-dir --limit 20

# 全量导出为 EML 树（每封一个 .eml，目录结构对应文件夹树）
ost2eml <ost> out-dir

# 或按文件夹导出为 mbox
ost2eml <ost> out-dir --mbox
```

- 解析基于微软官方的 Rust PST 解析器 [microsoft/outlook-pst-rs](https://github.com/microsoft/outlook-pst-rs)，
  使用社区修复版 crate `outlook-pst-ost`（含 Outlook 2013+ 的 4 KiB OST 布局支持）
- 头部优先使用 Outlook 存储的原始 `PR_TRANSPORT_MESSAGE_HEADERS`（保留 Received 链、
  RFC 2047 编码、列表头），缺失字段从 MAPI 属性补齐
- 正文取 HTML（`PR_HTML`）/ 纯文本（`PR_BODY`），统一转 UTF-8 base64
- 附件按 `PR_ATTACH_DATA_BIN` 还原字节，内嵌消息递归渲染为 `message/rfc822`
- 8 位字符串按邮件的代码页（GBK/Shift-JIS/…）解码

## 已读行为

| 操作 | 结果 |
| --- | --- |
| 在阅读窗格停留 ≥ 3 秒 | 自动标为已读（`mark_read`，同步 `\Seen` 到服务器） |
| 打开后 3 秒内翻走 / 关窗 | 保持未读 |
| 阅读窗格「📌 标为已读」/「📨 标为未读」 | 手动切换，并停掉这一封的自动已读 |
| `Ctrl+Q` / `Ctrl+U` | 同上（已读 / 未读） |

- 自动已读只对**当前选中的那一封**生效：翻到别的邮件时等待作废，
  所以 `↑↓` 快速浏览不会把一路经过的邮件都读掉。
- 引擎对「已经是目标状态」的请求是安静的空操作（不写库、不发事件），
  因此界面不依赖 `core-event`，动作成功后自己把状态写回列表与阅读窗格。
- 导入的本机邮件默认按「早就读过」入库；IMAP 邮件沿用服务器的 `\Seen`。

## 构建与运行

```
开发（热更新）：cd apps/desktop && pnpm tauri dev
正式安装包：  cd apps/desktop && pnpm tauri build
  → target/release/bundle/nsis/FirthMail_0.1.0_x64-setup.exe
  → target/release/bundle/msi/FirthMail_0.1.0_x64_en-US.msi
```

测试：

```
cd apps/desktop && pnpm test          # 前端已读规则（node --test，无额外依赖）
cargo test -p firthmail-desktop       # 引擎桥接：Delete / 回复草稿 / 已读 / 改名迁移
```

## 版本管理

源码在 git 里（分支 `main`），引擎与 PST 解析器以 `path` 依赖放在 `vendor/`，**随仓库一起提交**，
所以克隆下来就能构建，不依赖 GitHub 拉取。

不入库的东西：

| 路径 | 原因 |
| --- | --- |
| `out/`、`test-out*/` | ost2eml 导出的**真实邮件**（21 GB / 44975 封），含隐私 |
| `target/` | Rust 构建产物（约 18 GB） |
| `apps/desktop/node_modules/`、`dist/` | 前端依赖与构建产物 |
| `apps/desktop/src-tauri/gen/schemas/` | Tauri 每次构建重新生成 |

`Cargo.lock` 与 `pnpm-lock.yaml` 都提交，保证依赖可复现。克隆后：

```
cargo build --release                       # 引擎 + 桌面端
cd apps/desktop && pnpm install
```

远端在 GitHub：`git@github.com:revive/firthmail.git`。

## 许可证

**AGPL-3.0-only**，完整条款见 [LICENSE](LICENSE)。

邮件引擎 `vendor/flectar-mail` 本身是 AGPL-3.0-only，GPLv3 与 AGPLv3 只能单向兼容，
所以整个程序按 AGPL-3.0 发布。`vendor/` 中各组件的来源与许可证见
[THIRD_PARTY.md](THIRD_PARTY.md)。

## 路线图

- [x] 调研 Flectar Mail（[docs/flectar-mail-调研.md](docs/flectar-mail-调研.md)）
- [x] ost2eml：OST → EML 全量导出（44975 封 / 21.22 GB / 0 失败）
- [x] 客户端主体：Tauri 2 + React 三栏布局（含本地导入与账户 UI）
- [x] Delete 键引擎管线集成测试 `bridge::tests::delete_moves_imported_mail_to_trash`
- [x] 回复草稿请求形状测试 `bridge::tests::reply_draft_saves_with_thread_linkage`
      （引擎完整解析请求；本机账户无发件身份按契约拒绝——编写器会把引擎错误呈现给用户）
- [x] IMAP 账户接入同步（13 文件夹 / 1717 封入库，账户 idle）
- [x] 回复/转发/新邮件编写器（Ctrl+R、Ctrl+F、✉ 按钮 → `save_draft` + `queue_send` 撤销队列）
- [x] 搜索框接入引擎 FTS（Enter 搜索、`from:/to:` 语法、Esc 清除、结果横幅）
- [x] 已读按钮/Ctrl+Q/Ctrl+U 修复：参数极性反了，一直在发「标为未读」（2026-11-24）
- [x] 自动已读：阅读窗格显示满 3 秒标为已读，翻走或手动切换即取消
      （引擎回归测试 `bridge::tests::mark_read_and_unread_reach_the_store`）
- [x] 更名为 **FirthMail**（产品名/标识 `app.firthmail.desktop`/包名/窗口标题/数据目录），
      旧 `fmail` 数据目录首次启动自动迁移
- [ ] 用户 UI 验收：Delete 键 / Ctrl+R 回复 / 已读按钮与 3 秒自动已读实测

## vendor 补丁记录：outlook-pst-ost

解析器以 path 依赖 vendor 在 `vendor/outlook-pst-ost/`（MIT，微软官方
outlook-pst 1.2.0 + 社区修复 1.3.0），我们在其上修了两个真实 OST 上暴露的 bug：

1. **Outlook 2013+ OST 的 HID 块号按 8-KiB 单位编码**（`src/ltp/heap.rs`）。
   wVer=36 布局中，NDB 数据块是 zlib 压缩到 4-KiB 磁盘页的 64-KiB 逻辑块，
   而 Outlook 写入 HID 时仍按经典 PST 的 8-KiB 堆块编号（实测：同步问题文件夹
   4829 行引用的 ibn 恰为 {0,8,...,320}，正好 41 个块；收件箱的行索引 B 树根
   引用 ibn=1520 → 真实块 190）。原版直接把 ibn 当物理块号，导致大文件夹
   contents 表整体解析失败（HeapBlockIndexNotFound）。修复：按首个数据块的
   大小推导缩放系数（64 KiB → ibn/8；经典 8 KiB → 不变），位图页判定只在
   经典布局启用。
2. **行索引 B 树读取失败不应毁掉整张表**（`src/ltp/table_context.rs`）。
   行迭代走已收集的 rows 向量，不依赖行索引；读取失败时降级为空映射。

修复后实测（真实 16.5 GB OST 全量导出）：**44975 封 / 21.22 GB / 0 失败**，
约 11 分钟。分布：收件箱 30252、Sent 8600、同步问题 4829、old_tongzhi 1138、
Trash 114、Junk 36、Archives 4。头部（含完整 Received 链与线程头）、RFC2047
中文主题与显示名、HTML 正文、附件（RFC2231 编码中文文件名）全部正确还原。

### 踩坑记录：白屏事故的两次教训

1. **字段名对齐**（2026-11-24 修）：引擎的 `Address` 序列化为
   `{ name, email }`，前端类型却写成 `address`。发件人无显示名的邮件使
   `initials()` 读到 undefined，React 整树崩溃成白屏。修法：类型改为
   `email`，所有显示处兜底 `(无名发件人)`。前端类型必须对着引擎的
   serde 输出写，不能凭直觉。
2. **巨型内联图片**（预防性）：引擎把 CID 图变成 data URI，单张可达
   8 MB、一封 32 张；实测收件箱有 17.7 MB 与 179 MB 的海报邮件。
   `sanitize.ts` 现在双预算放行（单张 300 KB、单封 2 MB，超出换占位图）。
3. **ErrorBoundary 必须第一天就有**：未捕获的渲染错误默认是"整窗白屏、
   无任何线索"；包一层后变成"红字错误 + 重新加载按钮"，第 1 条就是这样
   被 5 秒定位的。
4. **Tauri 2 的 capabilities 不能漏**（2026-11-24 修）：手搓工程没写
   `capabilities/default.json`，`listen()` 被权限系统静默拒绝——命令能用
   （应用自定义命令默认放行）而事件永远到不了。症状是"一切看似正常，
   唯独事件 ×0"。另外事件转发循环要把 `Lagged` 当丢包跳过而不是退出，
   否则首次同步的事件洪峰会杀死转发器。
5. **布尔参数的语义要写进名字**（2026-11-24 修，已读按钮"点了没反应"）：
   `setRead(unread: boolean)` 的参数含义是"是否未读"，按钮却调
   `setRead(!body?.isRead)`——点「标为已读」发的是 `mark_unread`，点
   「标为未读」发的是 `mark_read`，两者都恰好是邮件当前状态，于是引擎
   按设计静默跳过（同状态不写库、不发事件），界面看上去毫无反应；
   `pending_actions` 里从头到尾没有一条 `mark_read`/`mark_unread` 就是
   这个症状的证据。修法：参数改成 `setRead(read: boolean)`，动作名由
   `readMarking.ts` 的 `readActionKind()` 统一导出，并用 `pnpm test`
   锁住"切换 ⇒ 反向状态 ⇒ 对应动作"这一条。教训：**引擎对幂等请求不
   发事件，所以 UI 不能把自己的状态更新寄托在事件上**——动作成功后
   要自己写回列表与阅读窗格。
