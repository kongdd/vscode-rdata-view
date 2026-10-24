# R Data View

面向 R 的 VS Code **只读表格查看器**。复用 Grid Master 的 Svelte 表格 UI，通过 Arrow 随机读取或 R 行区间读取数据；不依赖 Python、DuckDB、Java。



## 当前扩展支持的格式

| 格式 | 读取方式 | R 包 |
|---|---|---|
| `.arrow` / `.feather` | IPC 文件按 record batch 随机读取，支持 LZ4/ZSTD | 无 |
| `.fst` | `read_fst(from, to)` 真正按行读取 | fst、arrow |
| `.qs2` / `.qdata` | 完整解码后驻留 R，仅将当前页转换为临时 Arrow | qs2、arrow |
| `.rds` / `.rda` / `.RData` | 完整解码后驻留 R，按页传输；RDA 可切换对象 | arrow |
| `.csv` / `.tsv` | 默认整表转临时 Arrow；超过 512 MiB 时尝试 `fread(skip, nrows)`，含引号则回退整表转换 | data.table、arrow |
| `.xlsx` | readxl 读取所选工作表并驻留 R，按页传输；可切换工作表 | readxl、arrow |

R 对象支持 data.frame、data.table、tibble 和矩阵；列表列显示为 R 文本。Arrow IPC **stream** 没有随机读取 footer，使用 R 一次转换为 IPC 文件。

小表完整加载到界面，支持排序、筛选、搜索和统计；大表的界面和 Arrow 批次缓存有界，但序列化 R 对象仍需整表驻留 R。关闭/隐藏标签页时释放对应表及页缓存，临时页文件在每次读取后删除。默认阈值 64 MiB，另外限制小表最多 100,000 行。压缩文件也按行列规模估算内存；Arrow 单个压缩 batch 仍必须整体解压。

**QS2/QDATA/RDS/RDA/XLSX 仍须完整解码，不能按需反序列化**；现在省去整表 Arrow 编码、压缩和落盘，仅传输请求的页。单次 R 脚本调用仍保留整表转换路径。大型对象需要足够的 R 内存，经常查看的大表建议保存为 fst 或分批写入 Feather V2。

这些差异不再在界面提示，只在文档说明：QS2/QDATA/RDS/RDA/XLSX 完整解码后驻留 R，仅当前页转 Arrow，隐藏时释放、恢复时重解码；fst 真正按行读取；CSV 默认整表转换，超大且无引号时改用 `fread(skip, nrows)`，含引号则退回整表转换。

多对象文件（rda、qs_savem 保存的 qs2）与多工作表 xlsx 在左上角显示当前对象名，点击可展开列表选择（仅一个对象时列表也只含该项）；无具名对象的文件（rds、csv、arrow、fst 等）不显示。可切换的仅限 data.frame、data.table、tibble 与 matrix。

R 工作进程按需启动并复用，默认空闲 5 分钟（300 秒）后退出，可通过 `rdataView.r.idleTimeoutSeconds` 调整（正整数秒；修改后重新打开表格生效）。计时从请求完成后开始，新请求会重置计时；后台 GC 完成也会重置计时。切换到其他文件使原标签页隐藏时，先释放对应表的引用并回复，再由宿主安排空闲 1 秒后的后台 GC；新请求会推迟尚未开始的 GC。R 的 GC 本身不能与同一进程内的读取并行。标签页恢复或进程重启后，首次翻页会按需重新解码。

`rm` 与 `gc()` 释放的是 R 对象及可复用空间，不保证 RSS 立即下降。macOS ARM64、arf 下的独立测量：R 加载 arrow/data.table 后约 235 MiB；解码 `big.rds` 后约 350 MiB，释放并 GC 后仍约 350 MiB。该数值依赖环境和历史峰值，不是内存上限；进程退出后才会释放其持有的内存。加载中取消、请求超时、扩展停用时也会结束工作进程；隐藏/关闭表格若无正在执行的 R 请求，通常只释放表引用，不立即结束进程。

## 格式读写与翻页性能

`data/big.*` 实测：200 万行 × 10 列，每页 500 行，各阶段重复 3 次取中位数。环境为 macOS ARM64、Node.js 26.10.0，R 通过 arf 执行；使用默认 64 MiB 阈值。写入与完整读取单位为**秒**，其余为**毫秒**。加载与翻页列采用最近一次复测，写入与完整读取保留此前结果；不同轮次存在波动，不据此直接推断优化收益。

| 格式 | 文件大小（MiB） | 写入 | 完整读取 | 冷加载 | 热加载 | 首页 | 中页 | 尾页 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Arrow | 87.0 | 0.15 | 0.10 | 1.4 | 1.6 | 4.6 | 4.6 | 3.3 |
| Feather | 87.0 | 0.15 | 0.10 | 2.6 | 1.5 | 10.1 | 6.3 | 3.2 |
| CSV | 173.9 | 0.07 | 0.15 | 1350.6 | 521.5 | 25.7 | 25.9 | 14.4 |
| fst | 84.0 | 0.07 | 0.09 | 677.7 | 4.1 | 11.6 | 4.8 | 4.9 |
| qdata | 41.1 | 0.25 | 0.16 | 996.3 | 242.2 | 6.1 | 3.4 | 3.4 |
| qs2 | 42.2 | 0.31 | 0.22 | 1090.4 | 299.3 | 6.1 | 3.4 | 3.6 |
| rda | 46.2 | 4.57 | 0.57 | 1368.8 | 664.7 | 6.0 | 3.4 | 3.2 |
| rds | 46.2 | 4.57 | 0.58 | 1359.3 | 650.2 | 5.9 | 3.4 | 3.1 |
| DuckDB | 46.5 | 0.74 | 0.15 | — | — | — | — | — |

- **冷／热加载**：冷加载使用新 R 进程；热加载复用 R 进程，但仍重新打开文件、解码对象，并非旧表缓存命中。Arrow／Feather 无需 R，其“冷加载”列仅表示重新打开 reader，不代表全新 Node.js 进程的首次加载。
- **翻页**：打开后依次读取首／中／尾页，耗时不含加载阶段；首屏可用时间还需加上首页读取耗时。
- **测量边界**：仅测扩展 reader，不含 Webview 通信、预取和绘制；未清理系统文件缓存。此 CSV 小于 512 MiB，走整表转换路径。
- **DuckDB**：仅作格式对照，扩展不支持该格式，故无加载与翻页数据。写入为 `dbWriteTable`，读取为全表 `SELECT *` 加 `as.data.table`，含连接建立；由 R duckdb 1.5.5（conda `r-4.5`）测得。
- **写入／完整读取**：纯 R 层直接调用 `fwrite`、`write_fst`、`qs_save`、`qd_save`、`saveRDS`、`save`、`write_ipc_file` 及对应读取函数，不含扩展逻辑，文件已进系统缓存。计时包含读取、`as.data.table()` 转换及 `value` 列求和；未单独验证所有列的底层物化情况，不将仅调用 `as.data.frame()` 的耗时解释为全表逐列扫描成本。

此前同一轮优化对照中，与整表转 Arrow、每次请求强制 GC 的原实现相比，热加载耗时变化如下（历史结果，非上表最新轮次）。fst 未改变按行读取方式，其收益来自取消前台强制 GC。

| 格式 | 优化前热加载 | 优化后热加载 | 耗时降低 |
|---|---:|---:|---:|
| fst | 50.5 | 15.4 | 69.5% |
| qdata | 396.3 | 228.7 | 42.3% |
| qs2 | 477.0 | 288.7 | 39.5% |
| rda | 821.9 | 614.4 | 25.2% |
| rds | 734.2 | 650.1 | 11.5% |

冷加载仍含 R 启动开销，跨轮次波动较大；正常连续使用应关注热加载列。本轮序列化对象翻页约 3–7 ms，但需整表驻留 R；隐藏后恢复须重新解码。原始结果写入 `data/test-perform.json`，复测命令：

```bash
RDATA_PERF=1 RDATA_TEST_R=arf npx vitest run tests/test-perform.test.ts
arf --vanilla --slave -f scripts/bench-format-io.R   # 写入与完整读取
```

### R 内存分页：临时文件与管道直传

将 `big.rds` 解码为同一份 R 内存表，对照临时 Arrow 文件、stdout Arrow 二进制和 stdout JSON。三种方式共用长度帧协议（4 字节小端长度 + 负载），轮换执行顺序；每种页大小在首／中／尾各测 15 次，预热后合并 45 次取中位数，单位为毫秒。两种 Arrow 均使用 ZSTD 压缩。

| 每页行数 | 临时 Arrow | 二进制 Arrow 管道 | JSON 管道 | 二进制较文件耗时降低 |
|---|---:|---:|---:|---:|
| 500 | 3.11 | 2.15 | 1.85 | 30.8% |
| 5,000 | 12.51 | 11.03 | 14.40 | 11.8% |
| 50,000 | 103.73 | 102.21 | 163.28 | 1.5% |

二进制管道省去落盘，每页节约约 **1–1.5 ms**；默认 500 行时 JSON 仍略快，批量较大时 Arrow 更快。不能据此推导原文件加载耗时会同幅下降。

计时包含 R 编码、进程通信、JS 解码，以及文件路径下临时目录／文件的创建和清理；不含 R 启动、原文件解码、界面通信／绘制及断言。三种方式已逐值对齐日期、缺失值、大整数、Unicode 和规范化后的列表列；JSON 使用 `digits = 17` 避免 double 精度损失。二进制通过 Buffer 分帧读取，不转字符串、不反复拼接已有负载；这不是共享内存或零拷贝。

管道直传仍为测试原型，未改生产传输方式。二进制输出使用 `/dev/stdout`，目前仅在 macOS 验证，Windows 尚未适配。

逐位置的中位数、P95 及原始样本保存于 `data/test-perform-transport.json`。复测：

```bash
RDATA_PERF=1 RDATA_TEST_R=arf npx vitest run tests/test-perform-transport.test.ts
```

## R arrow 的格式支持与当前边界

R `arrow` 原生支持 Parquet、Arrow IPC/Feather（含 IPC stream）、CSV/TSV 等分隔文本及 NDJSON，并可通过 `open_dataset()` 读取所支持格式的多文件、分区数据集。NDJSON 是每行一个 JSON 对象，不等同于任意结构的 JSON。

**当前扩展尚未接入 Parquet、NDJSON 和分区数据集**，不能将 R `arrow` 的能力等同于扩展已实现的功能。这些格式无需依赖 Python 或 DuckDB。

fst、qs2、qdata、RDS、RData、XLSX 不属于 `arrow` 原生文件格式；本扩展分别通过 fst、qs2、base R、readxl 读取，并通过临时 Arrow 传输数据；常驻 R 中的序列化对象只转换当前页。

格式能力以 [R arrow 官方文档](https://arrow.apache.org/docs/r/reference/index.html) 为准。

## R 中按行区间读取

独立函数 [`scripts/read-arrow-rows.R`](scripts/read-arrow-rows.R) 提供类似 `fread(skip, nrows)` 的接口，支持 Parquet 和 Arrow IPC/Feather V2，返回 tibble；`col_select` 使用 tidyselect 语法，`where()` 按列原型判断类型，不扫描列值。

```r
library(dplyr)
source("scripts/read-arrow-rows.R")

"data.parquet" |>
  read_arrow_rows(
    skip = 1000,
    nrows = 100,
    col_select = c(site, starts_with("Tair"))
  )
```

`skip = 1000` 表示跳过前 1000 行，从第 1001 行开始；不足 `nrows` 时返回实际剩余行数，超出末尾返回保留列类型的空 tibble（不读取列字典，因此空结果的 factor levels 可能为空）。`nrows = Inf` 返回剩余全部行，大表应显式限制行数。

函数先读取行数索引，再仅解码覆盖目标区间的 row group/record batch；不会先加载前 `skip` 行。Parquet 同时下推列选择；IPC 需解码目标批次，再选择列；单个大行组或批次仍可能占用较多内存。不支持 IPC stream、Feather V1、CSV 或 NDJSON；它们不能直接套用此随机读取路径。此函数是独立 R 工具，**尚未接入扩展的 Parquet 支持**。

测试：`arf --vanilla --slave -f tests/read-arrow-rows.R`。

## 使用

1. 安装需要的 R 包（Arrow IPC 文件无需 R）：

   ```r
   install.packages(c("arrow", "fst", "qs2", "readxl", "data.table"))
   ```

2. 可选：在用户设置中指定 **R 或 arf** 可执行文件：

   ```json
   {
     "rdataView.r.executable": "/opt/homebrew/bin/arf",
     "rdataView.r.timeoutSeconds": 120,
     "rdataView.r.idleTimeoutSeconds": 300,
     "rdataView.pagingThresholdMB": 64
   }
   ```

   留空时复用 vscode-R 的 `r.rpath.<platform>`，其次查找 `r.consolePath` / `r.rterm.<platform>` 中的 R/arf，最后使用 PATH 中的 R。不把 radian 当成脚本执行器。

3. 扩展以 `priority: default` 注册上述全部格式。已有的用户文件关联仍优先；若其他扩展也声明默认，可通过 **Reopen Editor With… → Configure default editor… → R Data View** 指定。也可在资源管理器右键选择 **Open with R Data View**。

工具栏 `Row…` 输入从 1 开始的行号，按回车或点击 `Go` 跳转并选中该行；行号以当前排序/筛选后的视图为准，大表按需加载目标页。

保留列宽调整、隐藏/重排/冻结列、冻结行、单元格/范围选择、复制、列配色与统计。列头右键菜单提供排序、筛选、复制、统计、冻结和隐藏；隐藏列可从工具栏 `Columns` 恢复。筛选默认排除空值，可在筛选栏修改条件；列统计基于完整原列，不受筛选影响。分页模式灰显全表排序/筛选/统计并说明原因，搜索也禁用；冻结和隐藏仍可用。复制最多 10,000 行，超限时禁用整列复制并提示导出。CSV 导出在主机端分批写入：小表导出当前筛选/排序结果，大表导出完整原表；不允许覆盖源文件。源数据只读，不写旁车文件。

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
- `src/extension/scripts/read-table-server.R`：常驻 R 入口，管理活动对象、分页与释放；`read-table.R` 保留单次转换入口。
- `src/shared/`：消息与类型。
- `webview-ui/src/`：复用的 Svelte UI；无解析 worker、WASM 或重复数据通道。
- `webview-ui/tests/`：UI 状态、行跳转与主机通信测试。
- `tests/fixtures/`：压缩 Arrow 与多工作表 Excel 测试数据。

UI 与 Arrow reader 源自 MIT 授权的 [Grid Master](https://github.com/sciro24/vscode_grid_master)；见 [NOTICE.md](NOTICE.md)。
