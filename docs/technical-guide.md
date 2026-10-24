# 技术说明与开发

[← 返回 README](../README.md)

## 分页与资源释放

- 小表完整加载，默认阈值 64 MiB、最多 100,000 行；内存估算考虑行列规模，不只看压缩文件大小。
- 大表按视口加载，界面与 Arrow 批次缓存有界；单个压缩 batch 仍需整体解压。
- **QS2/QDATA/RDS/RData/XLSX 必须完整解码并驻留 R**，分页只减少传输量，不保证整表内存有界。
- 隐藏时取消加载和导出，释放表引用及页缓存；恢复时按需重新解码。临时页文件读完即删，关闭时清理句柄与临时文件。
- R 进程按需启动、复用，默认空闲 300 秒退出。请求结束或后台 GC 完成后重新计时；修改超时设置须重新打开表格。
- 隐藏时先释放表引用，空闲 1 秒后执行 GC；新请求会推迟待执行的 GC，但不能中断已开始的 GC。
- `rm()` / `gc()` 不保证 RSS 下降；进程退出才释放其持有的全部内存。取消加载、请求超时或扩展停用也会结束 R 进程。

## 使用

安装和打开文件见 [快速开始](../README.md#快速开始)。支持本地文件系统与受信任工作区；SSH/WSL 须在扩展所在主机配置 R，不连接已有 R 会话。

### 配置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `rdataView.r.executable` | 空 | R 或 arf 路径 |
| `rdataView.r.timeoutSeconds` | 120 | R 请求超时秒数 |
| `rdataView.r.idleTimeoutSeconds` | 300 | R 进程空闲退出秒数，正整数 |
| `rdataView.pagingThresholdMB` | 64 | 小表内存阈值，0 表示始终分页 |

R 路径留空时依次使用 vscode-R 的 `r.rpath.<platform>`、`r.consolePath` / `r.rterm.<platform>` 中的 R/arf、PATH 中的 R；不使用 radian 执行脚本。

所有支持格式注册为默认编辑器，但尊重用户已有关联。需手动指定时，使用 **Reopen Editor With… → Configure default editor… → R Data View**。

### 表格操作

- `Row…` 输入从 1 开始的行号，回车或点击 `Go` 跳转；按当前筛选、排序后的视图计数。
- 支持调整、重排、隐藏、冻结列和冻结行，以及区域选择、复制和列配色。列头右键打开操作菜单，`Columns` 恢复隐藏列。
- 筛选默认排除空值；列统计基于完整原列，不受筛选影响。
- 分页模式禁用全表排序、筛选、搜索和统计；冻结、隐藏仍可用。
- 复制最多 10,000 行，超限时建议导出。CSV 分批导出：小表导出当前视图，大表导出完整原表；不覆盖源文件，取消或失败不破坏已有目标。
- 源文件只读，不写旁车文件。

## 格式读写与翻页性能

结果见 [README 性能表](../README.md#读取性能)。测试为 200 万行 × 10 列、每页 500 行，重复 3 次取中位数；macOS ARM64、Node.js 26.10.0、arf，默认 64 MiB 阈值。耗时统一为 ms。

| 指标 | 计时范围 |
|---|---|
| 冷加载 | 新 R 进程启动、包加载及文件读取；fst 只读元数据和 1 行 |
| 热加载 | 复用 R 进程和包，重新打开文件；非已加载表缓存命中 |
| 首页／中页／尾页 | 打开后依次读取对应页，不含加载；首屏数据就绪耗时为加载加首页读取 |
| 写入／完整读取 | 纯 R 格式读写；读取含 `as.data.table()` 和 `sum(value)`，未验证所有列完全物化 |

- Arrow / Feather 无需 R；冷、热加载均为重新打开 reader，不代表全新 Node.js 进程启动。
- 仅测 reader，不含 Webview 通信、预取和绘制；未清理系统文件缓存。CSV 样例不足 512 MiB，走整表转换。
- 写入与完整读取来自此前轮次，加载与翻页为最新复测，不宜跨轮次推断优化收益。
- DuckDB 仅作格式对照：R duckdb 1.5.5（conda `r-4.5`），写入用 `dbWriteTable()`，读取用全表 `SELECT *`，均含连接建立。

```bash
RDATA_PERF=1 RDATA_TEST_R=arf npx vitest run tests/test-perform.test.ts
arf --vanilla --slave -f scripts/bench-format-io.R
```

reader 原始结果：`data/test-perform.json`；[历史优化与传输实验](performance-notes.md)。

## 独立 R 行区间工具

[`read_arrow_rows()`](../scripts/read-arrow-rows.R) 支持 Parquet 和 Arrow IPC/Feather V2，返回 tibble；这是独立工具，不代表扩展支持 Parquet。

```r
source("scripts/read-arrow-rows.R")

read_arrow_rows(
  "data.parquet",
  skip = 1000,
  nrows = 100,
  col_select = c(site, starts_with("Tair"))
)
```

- `skip` 跳过指定行数；超出末尾返回保留列类型的空表，但 factor levels 可能为空。`nrows = Inf` 读取剩余全部行。
- 仅解码覆盖区间的 row group / record batch；单个大块仍可能占用较多内存。
- `col_select` 支持 tidyselect，`where()` 根据列原型判断；Parquet 下推列选择，IPC 解码批次后选列。
- 不支持 IPC stream、Feather V1、CSV、NDJSON。

```bash
arf --vanilla --slave -f tests/read-arrow-rows.R
```

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm run package
```

F5 启动 Extension Development Host，VSIX 输出到 `release/`。

```bash
RDATA_TEST_R=/opt/homebrew/bin/arf npm test
RDATA_TEST_ARROW=/path/to/large.arrow npm test  # 可选：真实大 Arrow 文件
```
