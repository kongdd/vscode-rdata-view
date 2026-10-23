# R Data View

面向 R 的 VS Code **只读表格查看器**。复用 Grid Master 的 Svelte 表格 UI，统一通过 Arrow 或磁盘行索引读取数据；不依赖 Python、DuckDB、Java。

## 支持格式

| 格式 | 读取方式 | R 包 |
|---|---|---|
| `.arrow` / `.feather` | IPC 文件按 record batch 随机读取，支持 LZ4/ZSTD | 无 |
| `.fst` | `read_fst(from, to)` 真正按行读取 | fst、arrow |
| `.qs2` / `.qdata` | 一次完整反序列化 → 临时 Arrow → 分页 | qs2、arrow |
| `.rds` / `.rda` / `.RData` | 一次完整反序列化 → 临时 Arrow → 分页；RDA 可切换对象 | arrow |
| `.csv` / `.tsv` | 一次流式建立临时磁盘行索引 | 无 |
| `.xlsx` | readxl 读取所选工作表 → 临时 Arrow；可切换工作表 | readxl、arrow |

R 对象支持 data.frame、data.table、tibble 和矩阵；列表列显示为 R 文本。不执行工作区中的 `.Rprofile`。Arrow IPC **stream** 没有随机读取 footer，使用 R 一次转换为 IPC 文件。

小表完整加载，支持排序、筛选、搜索和统计；大表仅保留当前页缓存，关闭/隐藏标签页释放内存，关闭后删除临时文件。默认阈值 64 MiB，另外限制小表最多 100,000 行。压缩文件也按行列规模估算内存；Arrow 单个压缩 batch 仍必须整体解压。

**QS2/QDATA/RDS/RDA/XLSX 的首次转换不是按需反序列化**，大型对象仍需要足够的 R 内存和临时磁盘空间。经常查看的大表建议保存为 fst 或分批写入 Feather V2。

## 使用

1. 安装需要的 R 包（CSV 和 Arrow IPC 文件无需 R）：

   ```r
   install.packages(c("arrow", "fst", "qs2", "readxl"))
   ```

2. 可选：在用户设置中指定 **R 或 arf** 可执行文件：

   ```json
   {
     "rdataView.r.executable": "/opt/homebrew/bin/arf",
     "rdataView.r.timeoutSeconds": 120,
     "rdataView.pagingThresholdMB": 64
   }
   ```

   留空时复用 vscode-R 的 `r.rpath.<platform>`，其次查找 `r.consolePath` / `r.rterm.<platform>` 中的 R/arf，最后使用 PATH 中的 R。不把 radian 当成脚本执行器。

3. 资源管理器右键 → **Open with R Data View**，或 **Reopen Editor With… → R Data View**。默认不接管其他扩展的文件关联；可在 VS Code 中设为默认编辑器。

保留列宽调整、隐藏/重排/冻结列、冻结行、单元格/范围选择、复制、列配色与统计。分页模式明确禁用全表排序/筛选/搜索/统计；复制最多 10,000 行。CSV 导出在主机端分批写入：小表导出当前筛选/排序结果，大表导出完整原表；不允许覆盖源文件。源数据只读，不写旁车文件。

仅支持本地文件系统与受信任工作区；SSH/WSL 等远程工作区在扩展所在主机配置 R。这里只打开磁盘文件，不连接正在运行的 R 会话。

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm run package
```

F5 启动 Extension Development Host。VSIX 输出到 `release/`。

R 集成测试（需要上述 R 包）：

```bash
RDATA_TEST_R=/opt/homebrew/bin/arf npm test
# 可选：附加真实大 Arrow 文件的分页/释放/重新打开测试
RDATA_TEST_ARROW=/path/to/large.arrow npm test
```

## 结构

- `src/extension/`：单一只读编辑器、Arrow/CSV/R reader、CSV 导出。
- `src/extension/scripts/read-table.R`：唯一 R 入口，负责格式转换与 fst 行区间。
- `src/shared/`：消息与类型。
- `webview-ui/src/`：复用的 Svelte UI；无解析 worker、WASM 或重复数据通道。
- `tests/fixtures/`：压缩 Arrow 与多工作表 Excel 测试数据。

UI 与 Arrow reader 源自 MIT 授权的 [Grid Master](https://github.com/sciro24/vscode_grid_master)；见 [NOTICE.md](NOTICE.md)。
