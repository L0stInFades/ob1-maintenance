# OB1 本机逆向与维护工程

已从本机 **OB1 0.1.725** 提取完整的内嵌 JavaScript，并恢复可编辑代码、附带脚本、策略、提示词和 WASM。提供保留原运行时的重新打包脚本，以及隔离的离线验证。

原安装位置：`~/.local/bin/ob1` → `~/.ob1/bin/ob1`。本工程独立存放在 `~/ob1-maintenance`。

## 已恢复的内容

| 内容 | 位置 / 数量 |
| --- | --- |
| 原始程序与附带资源快照 | `original/`，29 个文件，附 SHA-256 清单 |
| 逐字节提取的 JavaScript | `recovered/ob1.bundle.cjs`，21,077,351 字节 |
| 可编辑的格式化代码 | `src/ob1.cjs`，约 61.5 万行，包含打包依赖 |
| 模块初始化包装器索引 | `reports/module-index.json`，3,777 个 |
| 导出名称 → 压缩符号映射 | `reports/export-aliases.json`，3,734 条 |
| 按规则选取的长文本 | `recovered/text/`，81 份，包含提示词、模板和其他长文本；不是全部提示词数量 |
| 内嵌 WASM | `recovered/assets/`，2 个，均通过 WebAssembly 验证 |
| 可维护的策略与沙箱配置 | `src/policies/`、`src/sandbox-macos-*.sb` |
| 可维护的工作流优化脚本 | `scripts/optimize/` |
| 重新构建的 Intel Mac 程序 | `dist/bin/ob1` |

程序中显示的版本是 `0.1.725`；`0.0.0-99e523a15` 是另一处内部构建/遥测标识。原程序内嵌 Node **24.16.0**。

## 运行与维护

本机依赖已装好。首次重新准备本目录时使用 `npm ci --ignore-scripts --no-audit --no-fund`，需要 Node.js、Python 3.9+；macOS 打包还使用系统 `codesign`，不需要编译 Node 或运行 Homebrew。

```sh
cd ~/ob1-maintenance

# 帮助 / 隔离开发实例
npm run dev -- --help
npm run dev -- --incognito

# 按原始语义名称定位压缩代码
npm run lookup -- getApiHost
npm run lookup -- createContentGenerator
npm run lookup -- ReadFileTool

# 修改 src/ob1.cjs、src/ 下的策略，或 scripts/optimize/ 后重新打包
npm run build
./dist/bin/ob1 --version

# 校验与离线回归
npm test
npm run verify:build
npm run smoke
npm run test:offline
```

`npm run dev` / `npm start` 为子进程使用独立用户目录 `.work/dev-home`，并在其中准备优化脚本。这个目录没有原账户登录信息；自带密钥可通过应用原有的 `OB1_*_API_KEY` 环境变量配置。开发启动器默认设置 `SENTRY_ENABLED=false`；会话使用 `--incognito` 可关闭程序原有的遥测和远程会话同步。

**直接运行 `dist/bin/ob1` 会按原程序习惯使用当前用户的 `~/.ob1`。** 它没有被安装回原路径。分发时保留整个 `dist/` 目录；策略和沙箱是附带文件，优化脚本在 SEA 模式下还需要放在所用用户目录的 `.ob1/scripts/optimize/`。

`dist/ob1-node` 是使用已安装 Node 的脚本运行入口。原厂二进制快照是重新打包的运行时模板，请保留 `original/bin/ob1`；它因为体积较大而被 `.gitignore` 排除。

## 阅读入口

- [独立正确性校验结论、证据和复现命令](docs/VALIDATION.md)
- [架构、模型路由与主要修改位置](docs/ARCHITECTURE.md)
- [恢复过程、构建方式与验证范围](docs/RECOVERY.md)
- [BYOK 示例配置](examples/byok.json)
- [原始文件校验清单](reports/original-manifest.json)
- [构建完整性报告](reports/build-integrity.json)
- [CLI 比对报告](reports/smoke.json)
- [离线推理与工具回归报告](reports/offline-tests.json)
- [原包保留的第三方版权说明](THIRD_PARTY_NOTICES.txt)

## 恢复边界

这是**从发行程序恢复的客户端维护工程**。包内没有 source map，原始 TypeScript 类型、开发目录、注释、测试和构建历史无法原样恢复；仍保留压缩后的局部变量名。导出名称索引可帮助定位语义，但不会把打包包装器误称为原厂源文件。

服务端没有包含在这个客户端中。云端登录、额度、同步、分享、搜索代理等服务仍需原服务或兼容实现。BYOK 路由已从客户端代码确认存在；真实模型服务连接和云功能没有使用你的账户进行验证。

`npm run extract` 可重新提取；`npm run format` 只用于首次恢复，目标已存在时会拒绝覆盖，避免抹掉维护修改。`npm run verify:source` 验证的是初始恢复与原始代码的规范化 AST 结构一致性；格式化会改变报错行号和函数源码反射文本。进行实际功能修改后出现 AST 差异是预期情况。修改代码后用 `npm run analyze` 更新索引。
