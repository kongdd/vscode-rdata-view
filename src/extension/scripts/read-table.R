# One process per conversion/page; paths and object names never enter shell code.
main <- function() {
  input <- Sys.getenv("RDATA_INPUT")
  output <- Sys.getenv("RDATA_OUTPUT")
  selected <- Sys.getenv("RDATA_SELECTED")
  format <- tolower(tools::file_ext(input))
  start <- Sys.getenv("RDATA_START")
  end <- Sys.getenv("RDATA_END")
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
      fst::read_fst(input, from = as.numeric(start) + 1, to = min(as.numeric(end), count))
    }
  } else if (format %in% c("qs2", "qdata")) {
    need("qs2")
    table <- if (format == "qs2") qs2::qs_read(input) else qs2::qd_read(input)
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
}
main()
