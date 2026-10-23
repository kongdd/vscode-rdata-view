# 一次读取/转换的共享实现：一次性脚本与常驻进程都调用它。
# 输入、输出、对象名、行区间全部以参数传入，绝不拼接进 shell 代码。
read_table <- function(input, output, selected = "", start = 0, end = 1,
                       paged = FALSE, sample = FALSE, classes = "") {
  format <- tolower(tools::file_ext(input))
  start <- as.numeric(start)
  end <- as.numeric(end)
  choices <- character()
  tabular <- function(x) is.data.frame(x) || is.matrix(x)
  pick <- function(names) {
    if (!length(names)) stop("No tables found")
    if (!nzchar(selected)) return(names[[1L]])
    if (!selected %in% names) stop("Unknown object or worksheet: ", selected)
    selected
  }
  need <- function(pkg) {
    if (!requireNamespace(pkg, quietly = TRUE)) stop("Install R package: ", pkg)
  }
  need("arrow")
  if (format %in% c("rda", "rdata")) {
    env <- new.env(parent = baseenv())
    names <- load(input, envir = env)
    choices <- names[vapply(names, function(n) tabular(env[[n]]), logical(1))]
    selected <- pick(choices)
    table <- env[[selected]]
  } else if (format == "xlsx") {
    need("readxl")
    choices <- readxl::excel_sheets(input)
    selected <- pick(choices)
    table <- readxl::read_excel(input, sheet = selected)
  } else if (format == "fst") {
    need("fst")
    count <- fst::metadata_fst(input)$nrOfRows
    writeLines(as.character(count), paste0(output, ".rows"))
    table <- if (count == 0) fst::read_fst(input) else {
      fst::read_fst(input, from = start + 1, to = min(end, count))
    }
  } else if (format %in% c("qs2", "qdata")) {
    need("qs2")
    table <- if (format == "qs2") qs2::qs_read(input) else qs2::qd_read(input)
  } else if (format %in% c("csv", "tsv")) {
    need("data.table")
    # fread 自动识别分隔符；空串与 NA 统一为缺失值。
    sep <- if (format == "tsv") "\t" else "auto"
    read <- function(...) data.table::fread(input, sep = sep, na.strings = c("NA", ""),
                                            encoding = "UTF-8", showProgress = FALSE, ...)
    cached <- nzchar(classes) && file.exists(classes)
    types <- if (cached) readRDS(classes) else {
      head <- read(nrows = 5000L)
      types <- vapply(head, function(x) class(x)[[1L]], character(1))
      names(types) <- names(head)
      if (nzchar(classes)) saveRDS(types, classes)
      types
    }
    # 分页模式：按行 skip/nrow 读取，避免整表驻留；类型取自首次采样，保证各页一致。
    table <- if (!paged) {
      read(colClasses = types)
    } else if (sample) {
      read(nrows = 5000L)[0, ]
    } else {
      read(skip = start + 1, nrow = end - start,
           header = FALSE, col.names = names(types), colClasses = types)
    }
  } else if (format == "rds") {
    table <- readRDS(input)
  } else if (format %in% c("arrow", "feather")) {
    table <- arrow::read_ipc_stream(input)
  } else stop("Unsupported format: ", format)

  if (!tabular(table)) stop("Expected a data.frame, data.table, tibble or matrix")
  table <- if (is.matrix(table)) as.data.frame(table) else as.data.frame(table, optional = TRUE)
  # List cells remain visible without requiring every nested R type to map to Arrow.
  for (i in seq_along(table)) {
    if (is.list(table[[i]]) && !inherits(table[[i]], "POSIXlt")) {
      table[[i]] <- vapply(table[[i]], function(x) paste(capture.output(dput(x)), collapse = " "), character(1))
    }
  }
  hex <- function(x) paste(format(charToRaw(enc2utf8(x))), collapse = "")
  writeLines(vapply(c(selected, choices), hex, character(1)), paste0(output, ".names"))
  arrow::write_feather(table, output, compression = "zstd", chunk_size = 65536L)
  invisible(TRUE)
}
