#!/usr/bin/env Rscript
# 项目根目录运行：arf --vanilla -f scripts/bench-arrow-dplyr.R
# 独立 R 后端基准；不改变扩展现有的 JS Arrow reader。
source("scripts/read-arrow-rows.R")
suppressPackageStartupMessages(library(dplyr))

# 对单文件的 dplyr 查询流式取页；skip 是筛选后的零基偏移。
# 仍需扫描前面的批次，不是随机访问；解压和预读开销不受页行数严格限制。
read_query_rows <- function(query, skip = 0, nrows = 500) {
  stopifnot(
    length(skip) == 1L, is.finite(skip), skip >= 0, skip == floor(skip),
    length(nrows) == 1L, is.finite(nrows), nrows >= 0, nrows == floor(nrows)
  )
  # 单线程扫描保持文件行序，避免并行查询重排批次后分页不稳定。
  reader <- arrow::Scanner$create(query, use_threads = FALSE)$ToRecordBatchReader()
  empty <- tibble::as_tibble(arrow::Table$create(schema = reader$schema))
  parts <- list(empty)
  while (nrows > 0) {
    batch <- reader$read_next_batch()
    if (is.null(batch)) break
    if (skip >= batch$num_rows) {
      skip <- skip - batch$num_rows
      next
    }
    size <- min(nrows, batch$num_rows - skip)
    parts[[length(parts) + 1L]] <- tibble::as_tibble(batch$Slice(skip, size))
    nrows <- nrows - size
    skip <- 0
  }
  bind_rows(parts)
}

bench_arrow_dplyr <- function(files, repeats = 3L, page_rows = 500L) {
  stopifnot(length(files) > 0L, repeats >= 1L, page_rows >= 1L)
  samples <- list()
  measure <- function(file, mode, page, run, fun) {
    invisible(gc())
    t0 <- Sys.time()
    result <- fun()
    elapsed_ms <- as.numeric(Sys.time() - t0, units = "secs") * 1000
    samples[[length(samples) + 1L]] <<- tibble(
      file = basename(file), mode, page, run, elapsed_ms
    )
    result
  }
  for (file in files) {
    # 独立整表参考仅用于验证，位于计时之外；因此以下均为 OS 文件缓存已热的测试。
    reference <- arrow::read_ipc_file(file) |> tibble::as_tibble()
    expected_filter <- reference |>
      filter(!is.na(temperature), temperature > 10, flag) |>
      select(id, site, date, temperature)
    for (run in seq_len(repeats)) {
      dataset <- measure(file, "open_dataset", "-", run, function() {
        arrow::open_dataset(file, format = "ipc")
      })
      filtered <- dataset |>
        filter(!is.na(temperature), temperature > 10, flag) |>
        select(id, site, date, temperature)
      count <- measure(file, "filter_count", "-", run, function() {
        filtered |> summarise(n = n()) |> collect()
      })
      stopifnot(count$n == nrow(expected_filter))
      for (mode in c("batch_random", "dplyr_scan", "dplyr_filter")) {
        expected <- if (mode == "dplyr_filter") expected_filter else reference
        total <- nrow(expected)
        positions <- c(
          first = 0, middle = floor(total / 2 / page_rows) * page_rows,
          last = max(0, floor((total - 1) / page_rows) * page_rows)
        )
        for (page in names(positions)) {
          skip <- positions[[page]]
          actual <- measure(file, mode, page, run, function() {
            if (mode == "batch_random") read_arrow_rows(file, skip, page_rows)
            else read_query_rows(if (mode == "dplyr_filter") filtered else dataset, skip, page_rows)
          })
          rows <- skip + seq_len(max(0, min(page_rows, total - skip)))
          stopifnot(isTRUE(all.equal(actual, expected[rows, ])))
        }
      }
    }
  }
  bind_rows(samples)
}

if (sys.nframe() == 0L) {
  options(error = function() quit(status = 1))
  files <- commandArgs(trailingOnly = TRUE)
  if (!length(files)) files <- c("data/big.arrow", "data/big.feather", "data/big2.arrow")
  cat("R", as.character(getRversion()), "arrow", as.character(packageVersion("arrow")),
      "dplyr", as.character(packageVersion("dplyr")),
      "scan threads 1; count uses Arrow default threads", arrow::cpu_count(), "\n")
  samples <- bench_arrow_dplyr(files)
  write.csv(samples, "data/bench-arrow-dplyr.csv", row.names = FALSE)
  samples |>
    group_by(file, mode, page) |>
    summarise(median_ms = round(median(elapsed_ms), 2), .groups = "drop") |>
    print(n = Inf)
  cat("ARROW_DPLYR_BENCH_OK\n")
}
