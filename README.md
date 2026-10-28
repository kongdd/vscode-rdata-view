<h1>R Data View</h1>

> **View R data.frame like data in VSCode**

## 1 Motivation

CSV预览数据很方便，但是性能极低，通过Office Excel打开速度极慢；同时文件极大，浪费存储。

R语言很多数据格式，支持高性能压缩，支持高性能读写，但数据预览不方面。

本repo为了填补上述空白，支持R语言data.frame数据格式的预览，实现CSV、Excel的替代。

**支持**：

- R语言数据：rds、rda、fst、qs2、qdata，无惰性读取支持
- 通用数据：CSV、Arrow / Feather、Excel
- 空间数据：SHP、GPKG、GeoJSON 的属性表

<!-- - **像表格一样浏览**：调整列宽、隐藏与冻结列，跳转到指定行，选择并复制单元格或区域。
- **小表灵活探索，大表分页浏览**：小表支持排序、筛选、搜索和列统计；大表按需加载页面。
- **随手导出 CSV**：小表导出当前筛选、排序后的结果，大表导出完整原表，不覆盖源文件。
-->

**读取方式**

| 格式                 | 读取方式                                                                         | R 包                              |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------- |
| Arrow / Feather V2   | 无筛选时用 TS 按 record batch 随机读取；dplyr 筛选时用 R 流式扫描，支持 LZ4/ZSTD | 无筛选无需 R；筛选需 arrow、dplyr |
| fst                  | `read_fst(from, to)` 按行区间读取                                                | fst、arrow                        |
| qs2 / qdata          | 完整解码驻留 R，当前页转临时 Arrow                                               | qs2、arrow                        |
| RDS / RData          | 完整解码驻留 R，当前页转临时 Arrow                                               | arrow                             |
| CSV                  | 默认整表转临时 Arrow；超过 512 MiB 时尝试行区间读取，含引号则回退整表转换        | data.table、arrow                 |
| XLSX                 | 所选工作表完整读入 R，当前页转临时 Arrow                                         | readxl、arrow                     |
| SHP / GPKG / GeoJSON | 所选图层完整读入 R，仅属性和几何类型驻留，当前页转临时 Arrow                     | sf、arrow                         |

- RData、`qs_savem()` 多对象文件及 XLSX 可在左上角切换对象或工作表；只列出可查看的表和矩阵。
- SHP 需要同名 `.shx`、`.dbf` 等配套文件；GPKG 可在左上角切换图层。空间图层显示 CRS、几何类型和属性，几何列仅显示类型，不显示坐标或地图。CSV 只导出属性，不含几何列。
- SHP / GPKG / GeoJSON 使用 `sf::st_read()` 完整读取图层，加载期间可能占用大量内存；分页仅限读取后的属性表，并非源文件随机读取。
- IPC stream 需通过 R 整体转换为 IPC 文件；单次 R 脚本调用仍保留整表转换路径。
- CSV 的 `fread(skip, nrows)` 仍需扫描文本，不等于随机访问。
- 扩展暂不支持 Parquet、NDJSON 和分区数据集；[R arrow 本身的支持范围](https://arrow.apache.org/docs/r/reference/index.html)不代表扩展功能。

## 2 读取性能

**测试数据**：200 万行 × 10 列，每页 500 行（**单位ms**，重复3次取中位数）

| 格式        |    大小 | 写入 | 完整读取 | 冷加载 | 热加载 | 首页 | 中页 | 尾页 |
| ----------- | ------: | ---: | -------: | -----: | -----: | ---: | ---: | ---: |
| **Arrow**   |  87.0 M |  150 |      100 |    1.4 |    1.6 |  4.6 |  4.6 |  3.3 |
| **Feather** |  87.0 M |  150 |      100 |    2.6 |    1.5 | 10.1 |  6.3 |  3.2 |
| CSV         | 173.9 M |   70 |      150 | 1350.6 |  521.5 | 25.7 | 25.9 | 14.4 |
| fst         |  84.0 M |   70 |       90 |  677.7 |    4.1 | 11.6 |  4.8 |  4.9 |
| qdata       |  41.1 M |  250 |      160 |  996.3 |  242.2 |  6.1 |  3.4 |  3.4 |
| qs2         |  42.2 M |  310 |      220 | 1090.4 |  299.3 |  6.1 |  3.4 |  3.6 |
| rda         |  46.2 M | 4570 |      570 | 1368.8 |  664.7 |    6 |  3.4 |  3.2 |
| rds         |  46.2 M | 4570 |      580 | 1359.3 |  650.2 |  5.9 |  3.4 |  3.1 |
| DuckDB      |  46.5 M |  740 |      150 |      — |      — |    — |    — |    — |

- `冷加载`: R启动 + R包加载 + 文件读取/解码
- `热加载`: 文件读取/解码

> Arrow / Feather 默认读取无需 R；筛选和执行 R 命令时才使用 R。`fst`: 支持按需读取，未读取全部数据。

**总结**：推荐使用arrow/feather保存数据：

1. 读写速度快（超过qdata/qs2/rda/rds），vscode table view预览速度快
2. 兼容性好（fst到rds仅支持R语言格式, arrow/feather支持R/Julia/Python）
<!-- docs/technical-guide.md#格式读写与翻页性能 -->

### R＋dplyr 对照测试

保留现有 JS Arrow reader，另用独立脚本测试 R＋dplyr，不改变默认读取路径：

```bash
arf --vanilla -f tests/bench-arrow-dplyr.R
arf --vanilla -f scripts/bench-arrow-dplyr.R
```

需安装 `arrow`、`dplyr`。默认读取 `data/big.arrow`、`big.feather`、`big2.arrow`，每页 500 行，重复 3 次取中位数；原始耗时保存至 `data/bench-arrow-dplyr.csv`。

- `open_dataset`：打开单文件数据集，不含数据扫描。
- `batch_random`：复用现有 R 行区间工具，按批次定位读取。
- `dplyr_scan`：单线程流式扫描，保持文件行序并跳过前面的行，读取首页、中页和尾页。
- `dplyr_filter`：先执行 `filter(!is.na(temperature), temperature > 10, flag)`，再 `select(id, site, date, temperature)`；页偏移针对筛选结果。
- `filter_count`：完整执行筛选计数，单独记录耗时。

实测：R 4.5.3、arrow 25.0.0、dplyr 1.2.1；200 万行 × 10 列，单位 ms：

| 文件      | R 读取路径       | 首页 |  中页 |  尾页 |
| --------- | ---------------- | ---: | ----: | ----: |
| big.arrow | 按批次随机读取   | 7.14 |  6.89 |  6.66 |
| big.arrow | dplyr 顺序扫描   | 5.26 |  7.22 |  9.52 |
| big.arrow | dplyr 筛选＋选列 | 4.42 | 17.20 | 29.60 |

`open_dataset` 约 4.1–4.5 ms；全表筛选计数约 14.5–14.9 ms（Arrow 默认 18 线程）。筛选路径只返回 4 列，不能把其首页耗时当作同等工作量的全列读取比较。

所有页均与整表 dplyr 结果核对；整表参考仅用于测试校验，不属于分页实现。计时前已读取参考数据，因此是 **OS 文件缓存已热** 的 R 内部耗时，不含 R 启动、扩展通信及 UI 渲染，不能直接等同于上表端到端性能。流式筛选不是随机访问，尾页仍可能扫描全表；压缩批次解压与预读也不受页行数严格限制。Arrow 后端仅支持其可翻译的 dplyr 表达式，并非完整 R 语法。

## 3 快速开始

1. 在 VS Code 中通过 **Install from VSIX…** 安装扩展。
2. 在 R 中安装所需依赖（只看 Arrow / Feather 文件可跳过）：

```r
install.packages(c("arrow", "dplyr", "magrittr", "lubridate", "fst", "qs2", "readxl", "data.table", "sf"))
```

已有 vscode-R 配置通常无需额外设置。找不到 R 时，在设置中指定 `rdataView.r.executable`，支持 R 或 arf。

### Arrow 筛选

在 `filter` 框输入 `dplyr::filter()` 的条件，例如 `temperature > 10, !is.na(site)`，按 Enter 或点击 Apply。非空时自动切换 R＋dplyr，显示全文件筛选结果；清空后切回 TS。只保留当前批次，连续翻页复用扫描游标，回跳可能重新扫描；首次计数可能扫描全表。仅限 IPC 文件 / Feather V2，Arrow 无法翻译的表达式会报错，不静默整表载入 R。

### R 命令与查询结果

在命令框编写 R 代码，点击“执行 R”或按 `Cmd+Enter` / `Ctrl+Enter`；普通 Enter 换行；`Cmd+Shift+M` 在光标处插入 `%>%` 并附加一个空格，Tab 插入 2 个空格，选中文本会被替换（Shift+Tab 仍切换焦点）。`df` 是当前对象或工作表；Arrow 为惰性数据集，并包含已应用的 dplyr 条件，不包含前端的搜索、排序或列筛选。执行时默认加载 `data.table`、`magrittr`、`dplyr`、`lubridate`，可直接使用 `%>%`、`filter()`、`as.data.table()`、`ymd()` 等；其他包请显式加载或使用 `包名::函数`。

```r
df |>
  filter(!is.na(temperature), temperature > 10) |>
  group_by(site) |>
  summarise(mean_temperature = mean(temperature), .groups = "drop")
```

最后一个表达式可返回 **Arrow 查询、Dataset、Table、RecordBatch、`data.frame`、`tibble`、`data.table` 或矩阵**。Arrow 结果由内部自动 `collect()`，例如直接写 `df |> head(10)` 即可；不会预先物化输入整表。其他类型会报错。成功后在同一编辑器组新开只读结果标签页，可点击标签切换，不分屏、不替换原表，编号复用最小空闲值（关闭后释放，存续标签编号不变）；结果可导出 CSV，但不能覆盖原始输入或上游查询文件；关闭标签页后清理临时文件。最终结果会完整物化并写入临时 Arrow 文件；返回整个 `df`、排序或其他 R 运算可能整表占用内存，不属于有界分页。

R 文件在打开面板时即预热 R，与界面资源传输重叠；Arrow 在应用筛选或聚焦命令框时才预热，默认预览不依赖 R。隐藏、关闭、切换数据或点击“取消”会取消当前命令。工作进程会复用，空闲后按设置退出。

R 命令的工作目录为源文件所属工作区文件夹；文件不属于任何工作区时使用第一个工作区文件夹，未打开工作区时使用源文件所在目录。查询结果继续沿用源文件的工作目录。

**安全**：筛选及命令仅在可信工作区执行。命令是本地 R 代码，不是沙箱；不要执行不可信代码，用户代码本身也可以读写文件。

## 4 使用前了解

- 大表的前端列菜单不提供全表排序、筛选、搜索和统计；Arrow 全表筛选使用专用 dplyr 框，其他数据处理使用 R 命令。
- RDS、RData、qs2、qdata、Excel、SHP、GPKG 和 GeoJSON 仍需完整解码到 R 内存；常看大表，优先选择 fst 或分批写入的 Feather V2。
- 查看磁盘文件，不连接已有 R 会话；暂不支持 Parquet。

<!-- ## 5 更多

[配置与技术说明](docs/technical-guide.md#使用) · [性能测试](docs/technical-guide.md#格式读写与翻页性能) · [参与开发](docs/technical-guide.md#开发)

基于 Grid Master 的表格界面构建，遵循 [MIT 许可](LICENSE.md)，上游声明见 [NOTICE.md](NOTICE.md)。 -->

<h2>TODO</h2>

- [ ] `RDS、RData、fst、qs2、qdata`：这些数据全部都是读取内存的，所有右键菜单都要支持
- [x] `Arrow / Feather`测试R语言作为后端的性能
- [x] `Arrow / Feather`结合 `dplyr::filter`，使用原生 dplyr 条件语法（限 Arrow 可翻译的表达式）

## Attribution

The Svelte grid UI and Arrow paging reader are adapted from [Grid Master](https://github.com/sciro24/vscode_grid_master), copyright (c) 2026–2030 Diego Scirocco, MIT licensed. The original copyright and license are retained in LICENSE.md.
