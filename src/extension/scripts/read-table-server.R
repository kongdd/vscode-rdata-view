# 常驻 R 工作进程：stdin 每行一次请求（制表符分隔），stdout 回一行 ok / error。
# 约定：不得向 stdout 输出任何其它内容。
here <- function() {
  args <- commandArgs(FALSE)
  index <- which(args %in% c("-f", "--file"))
  file <- if (length(index)) sub("^--file=", "", args[[index[[1L]] + 1L]]) else NA_character_
  if (is.na(file)) getwd() else dirname(normalizePath(file))
}
source(file.path(here(), "table-lib.R"))
suppressWarnings(suppressMessages({
  invisible(requireNamespace("arrow", quietly = TRUE))
  invisible(requireNamespace("data.table", quietly = TRUE))
}))

con <- file("stdin", "r")
repeat {
  line <- readLines(con, n = 1L, warn = FALSE)
  if (!length(line)) break
  if (!nzchar(line)) next
  field <- strsplit(line, "\t", fixed = TRUE)[[1L]]
  # strsplit 会丢掉末尾空字段，显式补齐为 ""
  if (length(field) < 8L) field <- c(field, rep("", 8L - length(field)))
  reply <- tryCatch({
    suppressWarnings(suppressMessages(read_table(
      input = field[[1L]], output = field[[2L]], selected = field[[3L]],
      start = field[[4L]], end = field[[5L]],
      paged = identical(field[[6L]], "1"), sample = identical(field[[7L]], "1"),
      classes = field[[8L]]
    )))
    "ok"
  }, error = function(e) paste0("error\t", gsub("[\t\r\n]+", " ", conditionMessage(e))))
  cat(reply, "\n", sep = "")
  flush(stdout())
  rm(line, field, reply)
  invisible(gc(FALSE))
}
close(con)
