# AGENTS.md

## 开发原则

- 中文交流，回答简短；先给结论，再说明必要细节。
- 遵循 Linux 极简主义：一次做好一件事，不做无关重构。
- 代码简短、清晰、排版规范；避免过度抽象、重复校验和层层异常包装。
- 可参考`/mnt/z/GitHub/kongdd/vscode_grid_master`的实现

## 项目定位与结构

R Data View 是面向 R 数据的 VS Code 只读表格查看器，支持 CSV 导出，不修改源文件。

- `src/extension/TableView.ts`：面板、加载、消息和导出生命周期。
- `src/extension/reader/`：Arrow 随机读取、R 读取及 R 进程复用。
- `src/extension/paging/`：分页接口、串行读取和资源管理。
- `src/extension/scripts/`：扩展运行所需的 R 脚本。
- `src/shared/`：消息协议、类型、筛选和 Arrow 压缩解码。
- `src/webview-ui/src/`：Svelte 5 表格 UI、状态和主机通信。
- `src/webview-ui/tests/`：UI 测试统一放在此处，不与 `src/` 源码混放。
- `scripts/`：独立 R 工具及数据生成脚本。
- `tests/fixtures/`：测试数据；业务样例放 `data/`，图片放 `images/`。
- `release/`：VSIX 构建产物，不手改 `dist/` 中的生成文件。

## 数据读取约定

- 小表可完整加载；大表按视口读取，缓存有界，不能先整表载入再切片冒充分页。
- Arrow IPC/Feather V2 按 record batch 读取，保留 LZ4/ZSTD 支持。不要要求用户为绕过解码问题而重导出无压缩文件。
- Parquet 按 row group 读取；压缩行组或批次可能需要整体解压，不能承诺任意行数对应严格内存上限。
- fst 使用真实行区间；QS2/QDATA/RDS/RDA/XLSX 的一次性解码与临时文件开销必须如实说明。
- CSV 的 `fread(skip, nrows)` 仍需扫描文本；引号内换行不能按物理换行数直接分页。
- `scripts/read-arrow-rows.R` 是独立工具，不代表扩展已支持 Parquet。新增格式须同步入口、选择器、测试及 README。
- R 接口采用 snake_case、原生管道、tidyselect，返回 tibble；保留日期、缺失值和大整数语义。
- 文件与对象名通过参数或环境变量传递，不拼接进 shell/R 代码。

## 生命周期与界面

- 隐藏时取消加载和导出、释放页缓存；关闭时关闭句柄、清理临时文件。
- 异步结果须防止过期页面或对象切换后的旧数据回写。
- 分页模式不伪装提供全表排序、筛选、搜索或统计；不完整支持应明确禁用并说明。
- 导出不覆盖源文件；取消或失败时不破坏已有目标文件。
- 编辑器对支持格式声明 `priority: default`，但尊重用户显式关联，不在激活时强行改写用户设置。

## 验证与交付

```bash
npm run check
npm test
npm run package

# R 格式集成测试
RDATA_TEST_R=/path/to/R-or-arf npm test

# 独立 R 行区间读取测试
arf --vanilla --slave -f tests/read-arrow-rows.R

# data: 真实大文件测试
```

- 按改动范围运行测试；纯文档修改不必重复构建。
- 每次功能或界面修改完成后，重新打包、安装 VSIX，并重载 VS Code 窗口，不只交付源码。
- 涉及读取时覆盖压缩、跨批次、空表、边界、取消及隐藏后恢复；不能只测未压缩小文件。
- 部分 arf 调用遇到 R 错误仍返回零退出码，须检查错误输出和测试成功标记。
- 打包后确认 JS、CSS、R 脚本齐全；版本修改同步 `package.json` 和 `package-lock.json`。
- 源码、VSIX 和已安装扩展是不同状态；排错先确认实际运行的版本及编辑器，避免误用旧 Grid Master。
- 交付时明确已验证、跳过和未验证的内容；自动测试通过不等于已完成人工界面验收。
- 保留上游 MIT 授权及 `NOTICE.md`，功能边界变化同步 README。
