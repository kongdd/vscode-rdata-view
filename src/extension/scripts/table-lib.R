# 一次读取/转换的共享实现：一次性脚本与常驻进程都调用它。
# 输入、输出、对象名、行区间全部以参数传入，绝不拼接进 shell 代码。
# 各 read_* 只负责读取，返回 list(table, selected, choices)；其余由通用函数处理。

need <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE)) stop("Install R package: ", pkg)
}

is_tabular <- function(x) is.data.frame(x) || is.matrix(x)

pick <- function(choices, selected) {
  if (!length(choices)) stop("No tables found")
  if (!nzchar(selected)) return(choices[[1L]])
  if (!selected %in% choices) stop("Unknown object or worksheet: ", selected)
  selected
}

result <- function(table, selected = "", choices = character()) {
  list(table = table, selected = selected, choices = choices)
}

read_rda <- function(input, selected) {
  env <- new.env(parent = baseenv())
  names <- load(input, envir = env)
  choices <- names[vapply(names, function(n) is_tabular(env[[n]]), logical(1))]
  selected <- pick(choices, selected)
  result(env[[selected]], selected, choices)
}

read_xlsx <- function(input, selected) {
  need("readxl")
  choices <- readxl::excel_sheets(input)
  selected <- pick(choices, selected)
  result(readxl::read_excel(input, sheet = selected), selected, choices)
}

read_fst <- function(input, output, start, end) {
  need("fst")
  count <- fst::metadata_fst(input)$nrOfRows
  writeLines(as.character(count), paste0(output, ".rows"))
  if (count == 0) return(result(fst::read_fst(input)))
  result(fst::read_fst(input, from = start + 1, to = min(end, count)))
}

read_qs <- function(input, format, selected) {
  need("qs2")
  if (format != "qs2") return(result(qs2::qd_read(input)))
  x <- qs2::qs_read(input)
  # qs_savem() 保存的多对象文件：顶层命名列表的元素名即变量名。
  if (is_tabular(x) || !is.list(x) || is.null(names(x))) return(result(x))
  choices <- names(x)[vapply(x, is_tabular, logical(1))]
  if (!length(choices)) return(result(x))
  selected <- pick(choices, selected)
  result(x[[selected]], selected, choices)
}

# 列类型取自首次采样并可缓存，保证分页各页一致。
csv_types <- function(read, classes) {
  if (nzchar(classes) && file.exists(classes)) return(readRDS(classes))
  head <- read(nrows = 5000L)
  types <- vapply(head, function(x) class(x)[[1L]], character(1))
  names(types) <- names(head)
  if (nzchar(classes)) saveRDS(types, classes)
  types
}

read_csv <- function(input, format, start, end, paged, sample, classes) {
  need("data.table")
  # fread 自动识别分隔符；空串与 NA 统一为缺失值。
  sep <- if (format == "tsv") "\t" else "auto"
  read <- function(...) data.table::fread(input, sep = sep, na.strings = c("NA", ""),
                                          encoding = "UTF-8", showProgress = FALSE, ...)
  types <- csv_types(read, classes)
  # 分页模式：按行 skip/nrow 读取，避免整表驻留。
  table <- if (!paged) {
    read(colClasses = types)
  } else if (sample) {
    read(nrows = 5000L)[0, ]
  } else {
    read(skip = start + 1, nrow = end - start,
         header = FALSE, col.names = names(types), colClasses = types)
  }
  result(table)
}

# List 单元格转为文本，避免要求所有嵌套 R 类型都能映射到 Arrow。
normalize <- function(table) {
  if (!is_tabular(table)) stop("Expected a data.frame, data.table, tibble or matrix")
  # 矩阵须保留 V1.. 列名；data.frame 类对象保持原列名。
  table <- if (is.matrix(table)) as.data.frame(table) else as.data.frame(table, optional = TRUE)
  for (i in seq_along(table)) {
    if (is.list(table[[i]]) && !inherits(table[[i]], "POSIXlt")) {
      table[[i]] <- vapply(table[[i]], function(x) {
        paste(capture.output(dput(x)), collapse = " ")
      }, character(1))
    }
  }
  table
}

write_table <- function(x, output) {
  hex <- function(s) paste(format(charToRaw(enc2utf8(s))), collapse = "")
  writeLines(vapply(c(x$selected, x$choices), hex, character(1)), paste0(output, ".names"))
  arrow::write_feather(x$table, output, compression = "zstd", chunk_size = 65536L)
}

load_table <- function(input, output = "", selected = "", start = 0, end = 1,
                       paged = FALSE, sample = FALSE, classes = "") {
  format <- tolower(tools::file_ext(input))
  start <- as.numeric(start)
  end <- as.numeric(end)
  need("arrow")
  x <- switch(format,
    rda = , rdata = read_rda(input, selected),
    xlsx = read_xlsx(input, selected),
    fst = read_fst(input, output, start, end),
    qs2 = , qdata = read_qs(input, format, selected),
    csv = , tsv = read_csv(input, format, start, end, paged, sample, classes),
    rds = result(readRDS(input)),
    arrow = , feather = result(arrow::read_ipc_stream(input)),
    stop("Unsupported format: ", format)
  )
  x$table <- normalize(x$table)
  x
}

read_table <- function(input, output, ...) {
  write_table(load_table(input, output, ...), output)
  invisible(TRUE)
}

# 用户表达式以 UTF-8 十六进制传递，不插入 shell 或工作进程协议。
decode_text <- function(encoded) {
  bytes <- substring(encoded, seq.int(1L, nchar(encoded), 2L), seq.int(2L, nchar(encoded), 2L))
  text <- rawToChar(as.raw(strtoi(bytes, 16L)))
  Encoding(text) <- "UTF-8"
  text
}

# Dataset 不会为不支持的表达式静默整表 collect；翻译失败直接报错。
open_arrow_filter <- function(input, encoded) {
  need("dplyr")
  expressions <- as.list(rlang::parse_expr(paste0("list(", decode_text(encoded), "\n)")))[-1L]
  if (!length(expressions) || any(nzchar(names(expressions)))) stop("Enter unnamed dplyr::filter() conditions")
  conditions <- lapply(expressions, function(expr) {
    # Arrow 的常量筛选须显式构造 Expression（包括空文件）。
    if (is.logical(expr) && length(expr) == 1L) return(arrow::Expression$scalar(expr))
    rlang::new_quosure(expr, env = asNamespace("dplyr"))
  })
  dataset <- arrow::open_dataset(input, format = "ipc")
  query <- rlang::inject(dplyr::filter(dataset, !!!conditions))
  count <- dplyr::collect(dplyr::summarise(query, n = dplyr::n()))$n
  state <- new.env(parent = emptyenv())
  state$query <- query
  state$rows <- as.numeric(count)
  state$empty <- tibble::as_tibble(arrow::Table$create(schema = dataset$schema))
  state$reader <- NULL
  state$batch <- NULL
  state$position <- 0
  state
}

# 只保留当前批次；连续翻页/导出复用扫描游标，向前跳转则重新扫描。
# 筛选结果的行号不是原文件行号；尾页可能需要扫描全表。
write_arrow_filter <- function(state, output, start, end) {
  start <- as.numeric(start)
  end <- as.numeric(end)
  if (start == end) {
    writeLines(as.character(state$rows), paste0(output, ".rows"))
    writeLines("0", paste0(output, ".bytes"))
  }
  parts <- list(state$empty)
  if (start < end) {
    if (is.null(state$reader) || start < state$position) {
      # 单线程保证文件行序，避免并行查询重排批次导致跨页重复/遗漏。
      state$reader <- arrow::Scanner$create(state$query, use_threads = FALSE)$ToRecordBatchReader()
      state$batch <- NULL
      state$position <- 0
    }
    while (start < end) {
      if (is.null(state$batch)) state$batch <- state$reader$read_next_batch()
      if (is.null(state$batch)) break
      next_row <- state$position + state$batch$num_rows
      if (start < next_row) {
        size <- min(end, next_row) - start
        parts[[length(parts) + 1L]] <- tibble::as_tibble(
          state$batch$Slice(start - state$position, size)
        )
        start <- start + size
        if (start == end) break
      }
      state$position <- next_row
      state$batch <- NULL
    }
  }
  write_table(result(normalize(dplyr::bind_rows(parts))), output)
}

# 显式执行用户 R 代码：df 是当前表，Arrow 保持惰性，结果须为可查看的表或矩阵。
# 与只读分页不同，用户 collect()/排序/聚合可能物化整表并产生完整临时文件。
execute_query <- function(input, output, selected, encoded, filter = "", cached = NULL) {
  for (pkg in c("data.table", "magrittr", "dplyr", "lubridate")) {
    need(pkg)
    suppressPackageStartupMessages(library(pkg, character.only = TRUE))
  }
  env <- new.env(parent = globalenv())
  env$df <- if (grepl("\\.(arrow|feather)$", input, ignore.case = TRUE)) {
    if (!is.null(cached) && nzchar(filter)) cached$query else if (nzchar(filter)) {
      open_arrow_filter(input, filter)$query
    } else arrow::open_dataset(input, format = "ipc")
  } else {
    x <- if (is.null(cached)) load_table(input, selected = selected) else cached
    tibble::as_tibble(x$table)
  }
  # print()/cat() 不得污染常驻进程 stdout 的逐行协议。
  con <- file(nullfile(), "w")
  sink(con)
  on.exit({ sink(); close(con) }, add = TRUE)
  value <- eval(parse(text = decode_text(encoded), keep.source = FALSE), envir = env)
  write_table(result(normalize(value)), output)
}
