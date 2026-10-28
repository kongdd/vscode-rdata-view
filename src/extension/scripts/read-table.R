# 一次性脚本：从环境变量取参数，转换一次即退出（无 R 常驻进程时使用）。
# arf 不在 commandArgs 中暴露脚本路径，故由宿主经 RDATA_LIB 传入脚本目录。
source(file.path(Sys.getenv("RDATA_LIB"), "table-lib.R"))

filter <- Sys.getenv("RDATA_FILTER")
code <- Sys.getenv("RDATA_QUERY")
if (nzchar(code)) {
  execute_query(Sys.getenv("RDATA_INPUT"), Sys.getenv("RDATA_OUTPUT"),
                Sys.getenv("RDATA_SELECTED"), code, filter, cwd = Sys.getenv("RDATA_CWD"))
} else if (nzchar(filter)) {
  write_arrow_filter(open_arrow_filter(Sys.getenv("RDATA_INPUT"), filter),
                     Sys.getenv("RDATA_OUTPUT"), Sys.getenv("RDATA_START", "0"), Sys.getenv("RDATA_END", "0"))
} else read_table(
  input = Sys.getenv("RDATA_INPUT"),
  output = Sys.getenv("RDATA_OUTPUT"),
  selected = Sys.getenv("RDATA_SELECTED"),
  start = Sys.getenv("RDATA_START", "0"),
  end = Sys.getenv("RDATA_END", "1"),
  paged = identical(Sys.getenv("RDATA_PAGED"), "1"),
  sample = identical(Sys.getenv("RDATA_SAMPLE"), "1"),
  classes = Sys.getenv("RDATA_CLASSES")
)
