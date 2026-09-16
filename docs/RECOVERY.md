# 恢复记录与验证范围

追加的独立复核见 [VALIDATION.md](VALIDATION.md)，包括 V8 实际加载脚本的逐字节核对、Apple 工具解析、扩展行为对照、本地 HTTP 回合和重复构建。本文保留首次恢复时的方法记录。

## 证据与提取

2026-09-17 从 `/Users/Apple/.ob1/bin/ob1` 建立独立快照。程序为 Intel x86_64 Mach-O，原始大小 **143,912,048 字节**。

原文件 SHA-256：

```text
5e70c83694b55dcb43dbf71a507baba30f4c1da96b73604495e0d0abcb8ec4ac
```

`NODE_SEA/__NODE_SEA_BLOB` 位于文件偏移 **93,900,800**，长度 **21,077,397**。本版本采用 9 字节 SEA 头：magic、flags、exec argv extension，然后是按长度编码的入口路径和 JavaScript。flags=1，没有 V8 snapshot、code cache 或独立 SEA assets。脚本内部另外含有 Base64 WASM 和文本资源。

入口路径为 `bundle/gemini-sea.cjs`，代码位于 SEA 段内偏移 46，长度 **21,077,351**。提取器校验所有读取边界并要求完整消费 SEA 段，避免只截取一段碰巧能解析的字符串。原始脚本 SHA-256：

```text
ef19b0cb412f46429fcdbb93c5bc7e44b317753b5713480a5fb08665497c28e9
```

格式化使用锁定版本 Prettier，代码结构检查使用 Acorn。规范化 AST 比对仅忽略位置、等价字面量/属性键拼写、相同逻辑运算符的结合方式以及正则标志顺序；不改动运算数次序。完整基线通过，见 `reports/source-equivalence.json`。

SEA 格式参考 [Node 官方序列化实现](https://github.com/nodejs/node/blob/v25.5.0/src/node_sea.cc) 和 [Node SEA 文档](https://nodejs.org/api/single-executable-applications.html)；本文件的布局结论以本地二进制解析与逐字节比对为准。

## 构建方式

`npm run build` 以 `src/ob1.cjs` 和可维护资源为输入，保留快照中的 **Node 24.16.0** 运行时。它复制模板到工作目录，移除旧签名，替换 SEA 载荷，扩展该段，并同步调整 LINKEDIT 段和引用它的文件偏移，最后使用 macOS ad-hoc 签名。

这不是重新编译 Node。18 个原生节的地址/布局保持一致，非零填充节的字节也与原文件一致；构建出的 SEA JavaScript 与当前 `src/ob1.cjs` 逐字节一致，见 `reports/build-integrity.json`。符号/导出等 LINKEDIT 表的数据未重写，只移动其文件位置。

使用本机 Node 26 的 `--build-sea` 曾得到在 dyld 初始化器阶段崩溃的产物，因此最终构建采用经过验证的原运行时模板。通用 Postject 覆盖此大体积样本也未成功，最终使用限定布局的本地重打包脚本。`repack_macho.py` 会拒绝不支持的 load command、异常布局或未移除的签名，不能视为通用任意 Mach-O 重写器。

新文件是本地签名；原厂签名无法也没有被保留为有效签名。现有原安装保持原样。产物目标为这份快照对应的 **macOS x86_64**，没有验证跨系统或其他架构。

## 已执行的验证

| 验证 | 实际检查 |
| --- | --- |
| 提取器测试 | 8/9/10 字节头、截断/尾随数据、V8 snapshot 拒绝、资源路径逃逸、错误 Mach-O，以及真实样本逐字节比对 |
| JavaScript 语法 | `node --check` |
| 恢复等价性 | 完整规范化 AST 哈希一致 |
| 构建完整性 | 原生节保留、载荷等于可编辑代码、原快照清单校验 |
| 代码签名 | `codesign --verify --strict` |
| CLI 对比 | 原程序、提取版、可读版、重构建版的 version/help/mcp help，共 12 次运行 |
| 离线推理 | 原程序、可读版、重构建版通过应用原有模拟生成器返回固定响应 |
| 真实本地工具回合 | 模拟模型发出 read_file 与 run_shell_command，校验工具成功、Shell 实际输出和本轮会话中记录的文件内容，再校验最终响应 |

动态测试使用 macOS `sandbox-exec` 禁止网络访问，并使用独立的测试用户目录及工作目录。测试期间没有使用原账户密钥。工具测试确实执行本地文件读取和简单 `printf`；模拟的是模型响应，不是工具实现。

原程序启动本身带有 punycode/指标配置弃用提示，恢复版与它一致。CLI 的比较条件是退出码和 stdout；stderr 中的 PID、Node 版本提示不是字节一致性条件。

根目录 `package.json` 和 `package-lock.json` 描述本次新增的恢复工具依赖，不是原厂工程的包清单。产品依赖大部分已内嵌在主脚本里；`reports/embedded-packages.json` 仅列出仍保留 name/version 的对象证据，不能当作完整 SBOM。

没有验证真实计费模型调用、OAuth 刷新、远程搜索/同步/分享、GUI 交互的每个分支或所有可选原生依赖。`reports/requires.json` 保存可能动态加载的模块线索，例如 sharp、PTY 与 WebSocket 加速模块；存在字符串引用不等于这些模块在所有路径上必需。

## 复现

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm run verify:build
npm run smoke
npm run test:offline
```

如需重新做提取，可运行 `npm run extract`。不要把 `npm run format` 当作日常编辑步骤：它从原始载荷生成可读基线，已有 `src/ob1.cjs` 时会拒绝覆盖。维护改动后运行 `npm run analyze` 更新索引；原始恢复的 AST 等价性检查届时不再要求通过。

`original/` 未包含用户凭据、聊天历史、缓存或私人设置。第三方版权信息来自二进制末尾的原始许可注释，单独保存在 `THIRD_PARTY_NOTICES.txt`。新建的工具脚本与恢复出来的产品代码在目录结构和说明中分别标识。
