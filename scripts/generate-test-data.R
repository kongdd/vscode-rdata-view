#!/usr/bin/env Rscript
# 生成 ~100 MB 的 data.frame，并导出为各受支持格式，用于手动测试查看器。
# 用法: Rscript scripts/generate-test-data.R [输出目录] [行数]

args <- commandArgs(trailingOnly = TRUE)
outdir <- if (length(args) >= 1) args[1] else "data"
n <- if (length(args) >= 2) as.integer(args[2]) else 2e6
dir.create(outdir, showWarnings = FALSE, recursive = TRUE)

set.seed(42)
sites <- sprintf("S%05d", 1:5e4)[sample.int(5e4, n, replace = TRUE)]
tags <- c("alpha", "beta", "gamma", "delta", NA_character_)

df <- data.frame(
  id = seq_len(n),
  site = sites,
  date = as.Date("1957-04-01") + sample.int(2e4, n, replace = TRUE),
  datetime = as.POSIXct("2020-01-01", tz = "UTC") + sample.int(1e8, n, replace = TRUE),
  temperature = round(rnorm(n, 10, 8), 2),
  value = rnorm(n, 1e3, 1e2),
  count = sample.int(1e6, n, replace = TRUE),
  flag = sample(c(TRUE, FALSE), n, replace = TRUE),
  label = factor(sample(tags[1:4], n, replace = TRUE)),
  note = tags,
  stringsAsFactors = FALSE
)
# 缺失值：数值列约 5%，字符列约 10%
df$temperature[sample.int(n, n %/% 20)] <- NA_real_
df$note[sample.int(n, n %/% 10)] <- NA_character_

cat(sprintf("行数 %s，内存占用 %.1f MB\n", format(n, big.mark = ","),
            as.numeric(object.size(df)) / 1024^2))

path <- function(ext) file.path(outdir, paste0("big.", ext))
timed <- function(ext, expr) {
  t0 <- Sys.time()
  force(expr)
  cat(sprintf("%-8s %6.1f MB  %5.1fs\n", ext,
              file.size(path(ext)) / 1024^2, as.numeric(Sys.time() - t0, units = "secs")))
}

timed("csv", data.table::fwrite(df, path("csv")))
timed("fst", fst::write_fst(df, path("fst")))
timed("qs2", qs2::qs_save(df, path("qs2")))
timed("qdata", qs2::qd_save(df, path("qdata")))
timed("rds", saveRDS(df, path("rds")))
timed("rda", save(df, file = path("rda")))
if (requireNamespace("arrow", quietly = TRUE)) {
  timed("arrow", arrow::write_ipc_file(df, path("arrow")))
  timed("feather", arrow::write_feather(df, path("feather")))
}
