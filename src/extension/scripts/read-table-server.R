# 常驻 R 工作进程：stdin 每行一次请求（制表符分隔），stdout 回一行 ok / error。
# 约定：不得向 stdout 输出任何其它内容。
# arf 不在 commandArgs 中暴露脚本路径，故由宿主经 RDATA_LIB 传入脚本目录。
source(file.path(Sys.getenv("RDATA_LIB"), "table-lib.R"))
suppressWarnings(suppressMessages({
  invisible(requireNamespace("arrow", quietly = TRUE))
  invisible(requireNamespace("data.table", quietly = TRUE))
}))

# 仅保存必须完整解码的活动对象；隐藏/关闭时释放，进程退出后按需重读。
tables <- new.env(parent = emptyenv())
serve <- function(input, output, selected, start, end, paged, sample, classes, key, action) {
  if (action == "gc") return(invisible(gc(FALSE)))
  if (action == "release") {
    if (exists(key, tables, inherits = FALSE)) rm(list = key, envir = tables)
    return(invisible(TRUE))
  }
  if (!nzchar(key)) return(read_table(input, output, selected, start, end, paged, sample, classes))
  if (!exists(key, tables, inherits = FALSE)) {
    tables[[key]] <- load_table(input, selected = selected)
  }
  x <- tables[[key]]
  start <- as.numeric(start)
  end <- as.numeric(end)
  if (start == end) {
    writeLines(as.character(nrow(x$table)), paste0(output, ".rows"))
    writeLines(as.character(as.numeric(object.size(x$table))), paste0(output, ".bytes"))
    x$table <- x$table[0, , drop = FALSE]
  } else {
    x$table <- x$table[seq.int(start + 1, end), , drop = FALSE]
  }
  write_table(x, output)
}

con <- file("stdin", "r")
repeat {
  line <- readLines(con, n = 1L, warn = FALSE)
  if (!length(line)) break
  if (!nzchar(line)) next
  field <- strsplit(line, "\t", fixed = TRUE)[[1L]]
  # strsplit 会丢掉末尾空字段，显式补齐为 ""
  if (length(field) < 10L) field <- c(field, rep("", 10L - length(field)))
  reply <- tryCatch({
    suppressWarnings(suppressMessages(serve(
      input = field[[1L]], output = field[[2L]], selected = field[[3L]],
      start = field[[4L]], end = field[[5L]],
      paged = identical(field[[6L]], "1"), sample = identical(field[[7L]], "1"),
      classes = field[[8L]], key = field[[9L]], action = field[[10L]]
    )))
    "ok"
  }, error = function(e) paste0("error\t", gsub("[\t\r\n]+", " ", conditionMessage(e))))
  cat(reply, "\n", sep = "")
  flush(stdout())
  rm(line, field, reply)
}
close(con)
