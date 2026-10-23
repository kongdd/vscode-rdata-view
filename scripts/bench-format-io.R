#!/usr/bin/env Rscript
# 对比各受支持格式的写入与完整读取耗时（同一份 200 万行 × 10 列数据）。
# 用法: Rscript scripts/bench-format-io.R [行数] [临时目录]

args <- commandArgs(trailingOnly = TRUE)
n <- if (length(args) >= 1) as.integer(args[1]) else 2e6
dir <- if (length(args) >= 2) args[2] else file.path(tempdir(), "rdata-io-bench")
dir.create(dir, showWarnings = FALSE, recursive = TRUE)

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
df$temperature[sample.int(n, n %/% 20)] <- NA_real_
df$note[sample.int(n, n %/% 10)] <- NA_character_

path <- function(ext) file.path(dir, paste0("big.", ext))
median_time <- function(fun, rep = 3) {
  ts <- numeric(rep)
  for (i in seq_len(rep)) {
    t0 <- Sys.time()
    fun()
    ts[i] <- as.numeric(Sys.time() - t0, units = "secs")
    invisible(gc())
  }
  median(ts)
}

writers <- list(
  csv = function() data.table::fwrite(df, path("csv")),
  fst = function() fst::write_fst(df, path("fst")),
  qs2 = function() qs2::qs_save(df, path("qs2")),
  qdata = function() qs2::qd_save(df, path("qdata")),
  rds = function() saveRDS(df, path("rds")),
  rda = function() save(df, file = path("rda")),
  arrow = function() arrow::write_ipc_file(df, path("arrow")),
  feather = function() arrow::write_feather(df, path("feather"))
)
readers <- list(
  csv = function() data.table::fread(path("csv")),
  fst = function() fst::read_fst(path("fst")),
  qs2 = function() qs2::qs_read(path("qs2")),
  qdata = function() qs2::qd_read(path("qdata")),
  rds = function() readRDS(path("rds")),
  rda = function() {
    env <- new.env()
    load(path("rda"), envir = env)
    env$df
  },
  arrow = function() arrow::read_ipc_file(path("arrow")),
  feather = function() arrow::read_feather(path("feather"))
)
# 全部物化为 data.table，并真正扫过数据，避免惰性/零拷贝掩盖成本
to_dt <- function(x) data.table::as.data.table(x)[, .(n = .N, s = sum(value))]

cat(sprintf("%-8s %10s %8s %8s\n", "格式", "大小(MB)", "写入(s)", "读取(s)"))
for (fmt in names(writers)) {
  write_s <- median_time(writers[[fmt]])
  size_mb <- file.size(path(fmt)) / 1024^2
  read_s <- median_time(function() to_dt(readers[[fmt]]()))
  cat(sprintf("%-8s %10.1f %8.2f %8.2f\n", fmt, size_mb, write_s, read_s))
}
