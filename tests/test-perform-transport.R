# 仅供传输对照测试：同一份 R 内存数据，比较临时 Arrow、管道 Arrow 和管道 JSON。
source("src/extension/scripts/table-lib.R")
invisible(lapply(c("arrow", "jsonlite", "bit64"), need))
x <- NULL

handle <- function(field) {
  method <- field[[1L]]
  if (method %in% c("load", "fixture")) {
    if (method == "load") {
      x <<- load_table(field[[2L]])
    } else {
      table <- data.frame(
        big = bit64::as.integer64(c("9007199254740993", "42", NA_character_)),
        date = as.Date(c("1957-04-01", NA_character_, "2025-01-01")),
        time = as.POSIXct(c("2025-01-01", NA_character_, "2020-01-01"), tz = "UTC") + 0.125,
        text = c("中文\t换行\n引号\"", NA_character_, ""),
        flag = c(TRUE, FALSE, NA), group = factor(c("a", "b", NA))
      )
      table$items <- list(c(1, 2), list(a = TRUE), NULL)
      x <<- result(normalize(table))
    }
    return(jsonlite::toJSON(list(
      rows = nrow(x$table), columns = ncol(x$table),
      integer64 = I(which(vapply(x$table, inherits, logical(1), "integer64")) - 1L)
    ), auto_unbox = TRUE))
  }
  start <- as.integer(field[[2L]])
  end <- as.integer(field[[3L]])
  page <- x
  page$table <- x$table[if (start == end) integer() else seq.int(start + 1L, end), , drop = FALSE]
  if (method == "arrow") {
    write_table(page, field[[4L]])
    return("ok")
  }
  if (method == "binary") {
    sink <- arrow::BufferOutputStream$create()
    arrow::write_feather(page$table, sink, compression = "zstd", chunk_size = 65536L)
    return(sink$finish()$data())
  }
  if (method != "json") stop("Unknown transport: ", method)
  # 仅转换当前页；日期与大整数对齐现有 Arrow reader 的值语义。
  page$table[] <- lapply(page$table, function(column) {
    if (inherits(column, "integer64")) return(as.character(column))
    if (inherits(column, "Date")) column <- as.POSIXct(column, tz = "UTC")
    if (inherits(column, "POSIXt")) return(format(column, "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC"))
    column
  })
  # digits = NA 只有约 15 位有效数字；17 保证测试数据的 double 往返一致。
  jsonlite::toJSON(page$table, dataframe = "values", na = "null", digits = 17)
}

con <- file("stdin", "r")
# 二进制 stdout 需使用 Unix 设备路径；file("stdout") 会创建普通文件。
out <- file("/dev/stdout", "wb")
repeat {
  line <- readLines(con, n = 1L, warn = FALSE)
  if (!length(line)) break
  field <- strsplit(line, "\t", fixed = TRUE)[[1L]]
  reply <- tryCatch(suppressWarnings(suppressMessages(handle(field))),
                    error = function(e) paste0("error\t", gsub("[\t\r\n]+", " ", conditionMessage(e))))
  bytes <- if (is.raw(reply)) reply else charToRaw(enc2utf8(reply))
  # 三种方式共用长度帧，控制消息/JSON 均按 UTF-8 编码；二进制不经过文本转换。
  writeBin(as.integer(length(bytes)), out, size = 4L, endian = "little")
  writeBin(bytes, out)
  flush(out)
  rm(line, field, reply, bytes)
}
close(con)
close(out)
