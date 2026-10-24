<h1>R Data View</h1>

> **View R data.frame like data in VSCode**

## 1 Motivation

CSV预览数据很方便，但是性能极低，通过Office Excel打开速度极慢；同时文件极大，浪费存储。

R语言很多数据格式，支持高性能压缩，支持高性能读写，但数据预览不方面。

本repo为了填补上述空白，支持R语言data.frame数据格式的预览，实现CSV、Excel的替代。

**支持**：

- R语言数据：rds、rda、fst、qs2、qdata，无惰性读取支持
- 通用数据：CSV、Arrow / Feather

<!-- - **像表格一样浏览**：调整列宽、隐藏与冻结列，跳转到指定行，选择并复制单元格或区域。
- **小表灵活探索，大表分页浏览**：小表支持排序、筛选、搜索和列统计；大表按需加载页面。
- **随手导出 CSV**：小表导出当前筛选、排序后的结果，大表导出完整原表，不覆盖源文件。 
--> 

**读取方式**

| 格式 | 读取方式 | R 包 |
|---|---|---|
| Arrow / Feather V2 | 按 record batch 随机读取，支持 LZ4/ZSTD；无需 R | 无 |
| fst | `read_fst(from, to)` 按行区间读取 | fst、arrow |
| qs2 / qdata | 完整解码驻留 R，当前页转临时 Arrow | qs2、arrow |
| RDS / RData | 完整解码驻留 R，当前页转临时 Arrow | arrow |
| CSV | 默认整表转临时 Arrow；超过 512 MiB 时尝试行区间读取，含引号则回退整表转换 | data.table、arrow |
| XLSX | 所选工作表完整读入 R，当前页转临时 Arrow | readxl、arrow |

- RData、`qs_savem()` 多对象文件及 XLSX 可在左上角切换对象或工作表；只列出可查看的表和矩阵。
- IPC stream 需通过 R 整体转换为 IPC 文件；单次 R 脚本调用仍保留整表转换路径。
- CSV 的 `fread(skip, nrows)` 仍需扫描文本，不等于随机访问。
- 扩展暂不支持 Parquet、NDJSON 和分区数据集；[R arrow 本身的支持范围](https://arrow.apache.org/docs/r/reference/index.html)不代表扩展功能。

## 2 读取性能

**测试数据**：200 万行 × 10 列，每页 500 行（**单位ms**，重复3次取中位数）

| 格式 | 大小 | 写入 | 完整读取 | 冷加载 | 热加载 | 首页 | 中页 | 尾页 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Arrow** | 87.0 M | 150 | 100 | 1.4 | 1.6 | 4.6 | 4.6 | 3.3 |
| **Feather** | 87.0 M | 150 | 100 | 2.6 | 1.5 | 10.1 | 6.3 | 3.2 |
| CSV | 173.9 M | 70 | 150 | 1350.6 | 521.5 | 25.7 | 25.9 | 14.4 |
| fst | 84.0 M | 70 | 90 | 677.7 | 4.1 | 11.6 | 4.8 | 4.9 |
| qdata | 41.1 M | 250 | 160 | 996.3 | 242.2 | 6.1 | 3.4 | 3.4 |
| qs2 | 42.2 M | 310 | 220 | 1090.4 | 299.3 | 6.1 | 3.4 | 3.6 |
| rda | 46.2 M | 4570 | 570 | 1368.8 | 664.7 | 6 | 3.4 | 3.2 |
| rds | 46.2 M | 4570 | 580 | 1359.3 | 650.2 | 5.9 | 3.4 | 3.1 |
| DuckDB | 46.5 M | 740 | 150 | — | — | — | — | — |

- `冷加载`: R启动 + R包加载 + 文件读取/解码
- `热加载`: 文件读取/解码

> Arrow / Feather 无需 R。`fst`: 支持按需读取，未读取全部数据。

**总结**：推荐使用arrow/feather保存数据：
1. 读写速度快（超过qdata/qs2/rda/rds），vscode table view预览速度快
2. 兼容性好（fst到rds仅支持R语言格式, arrow/feather支持R/Julia/Python）
<!-- docs/technical-guide.md#格式读写与翻页性能 -->

## 3 快速开始

1. 在 VS Code 中通过 **Install from VSIX…** 安装扩展。
2. 在 R 中安装所需依赖（只看 Arrow / Feather 文件可跳过）：

  ```r
  install.packages(c("arrow", "fst", "qs2", "readxl", "data.table"))
  ```

已有 vscode-R 配置通常无需额外设置。找不到 R 时，在设置中指定 `rdataView.r.executable`，支持 R 或 arf。

## 4 使用前了解

- 大表分页模式不提供全表排序、筛选、搜索和统计。
- RDS、RData、qs2、qdata 和 Excel 仍需完整解码到 R 内存；常看大表，优先选择 fst 或分批写入的 Feather V2。
- 查看磁盘文件，不连接已有 R 会话；暂不支持 Parquet。

<!-- ## 5 更多

[配置与技术说明](docs/technical-guide.md#使用) · [性能测试](docs/technical-guide.md#格式读写与翻页性能) · [参与开发](docs/technical-guide.md#开发)

基于 Grid Master 的表格界面构建，遵循 [MIT 许可](LICENSE.md)，上游声明见 [NOTICE.md](NOTICE.md)。 -->

<h2>TODO</h2>

- [ ] `RDS、RData、fst、qs2、qdata`：这些数据全部都是读取内存的，所有右键菜单都要支持
- [ ] `Arrow / Feather`测试R语言作为后端的性能
- [ ] `Arrow / Feather`结合dplyr::filter，filter功能要能生效，完全按照dplyr的语法
