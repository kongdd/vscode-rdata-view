# 一次性脚本：从环境变量取参数，转换一次即退出（无 R 常驻进程时使用）。
here <- function() {
  args <- commandArgs(FALSE)
  index <- which(args %in% c("-f", "--file"))
  file <- if (length(index)) sub("^--file=", "", args[[index[[1L]] + 1L]]) else NA_character_
  if (is.na(file)) getwd() else dirname(normalizePath(file))
}
source(file.path(here(), "table-lib.R"))

read_table(
  input = Sys.getenv("RDATA_INPUT"),
  output = Sys.getenv("RDATA_OUTPUT"),
  selected = Sys.getenv("RDATA_SELECTED"),
  start = Sys.getenv("RDATA_START", "0"),
  end = Sys.getenv("RDATA_END", "1"),
  paged = identical(Sys.getenv("RDATA_PAGED"), "1"),
  sample = identical(Sys.getenv("RDATA_SAMPLE"), "1"),
  classes = Sys.getenv("RDATA_CLASSES")
)
