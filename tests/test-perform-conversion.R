# 拆测原文件读取与整表 Arrow 写入；不改生产读取逻辑。
# arf --vanilla --slave -f tests/test-perform-conversion.R
source("src/extension/scripts/table-lib.R")
invisible(lapply(c("arrow", "data.table", "qs2", "jsonlite"), need))

clock <- function() proc.time()[["elapsed"]] * 1000
original_write <- write_table
measure <- function(input, repeat_id) {
  output <- tempfile(fileext = ".arrow")
  on.exit(unlink(c(output, paste0(output, ".names"))))
  cached <- NULL
  read_ms <- write_ms <- 0
  # read_table 在写入前已经完成读取与 normalize；在这个边界计时。
  write_table <- function(x, output) {
    read_ms <<- clock() - start
    cached <<- x$table
    t <- clock()
    original_write(x, output)
    write_ms <<- clock() - t
  }
  # 仅在本次调用中替换写入函数，保留 read_table 的实际格式分派。
  read <- read_table
  environment(read) <- environment()
  invisible(gc())
  start <- clock()
  read(input, output)
  stopifnot(nrow(cached) == 2000000L, ncol(cached) == 10L)
  page_ms <- vapply(c(0L, 1000000L, 1999500L), function(from) {
    t <- clock()
    json <- jsonlite::toJSON(cached[from + seq_len(500L), , drop = FALSE],
                            dataframe = "values", na = "null", POSIXt = "ISO8601", digits = NA)
    elapsed <- clock() - t
    stopifnot(nrow(jsonlite::fromJSON(json)) == 500L)
    elapsed
  }, numeric(1))
  data.frame(file = basename(input), repeat_id, read_ms, write_ms,
             first_json_ms = page_ms[[1L]], middle_json_ms = page_ms[[2L]],
             last_json_ms = page_ms[[3L]])
}

files <- list.files("data", pattern = "^big\\.(csv|qs2|qdata|rds|rda)$", full.names = TRUE)
stopifnot(length(files) == 5L)
samples <- do.call(rbind, lapply(files, function(input) {
  do.call(rbind, lapply(seq_len(3L), function(i) measure(input, i)))
}))
write.csv(samples, "data/test-perform-conversion.csv", row.names = FALSE)
summary <- aggregate(samples[setdiff(names(samples), c("file", "repeat_id"))],
                     samples["file"], median)
summary$saved_pct <- round(100 * summary$write_ms / (summary$read_ms + summary$write_ms), 1)
print(summary, row.names = FALSE)
cat("PERF_CONVERSION_OK\n")
